import type { Connection } from "../connection";
import { ensureSchema, sql } from "../db";
import { pageImpressions90d } from "../seo-tools";
import { logChange } from "./engine";
import { setArticlePublished } from "./shopify";
import type { SiteAccess } from "./site-source";
import { topicWords } from "./site-keywords";

/**
 * Content pruning, the careful way (improve first, never a hard delete).
 * Once a month, for articles old enough to have had their chance:
 * 1. Zero Google impressions in 90 days: the autopilot rewrites it first
 *    (the "prune" app turns it into a candidate).
 * 2. Still nothing 60 days after that: it goes. An article the app wrote on a
 *    Shopify store is taken back to a draft (undoable from the history),
 *    with a redirect to a stronger related article suggested. Anything else,
 *    including every article the owner wrote, is only suggested on the fix
 *    list for the owner to approve.
 */

export interface PruneEntry {
  stage: "rewrite" | "removed" | "suggested";
  since: string;
  /** The stronger related article to send its visitors to. */
  into?: string | null;
  appMade: boolean;
}
export interface PruneState {
  at: string;
  pages: Record<string, PruneEntry>;
}

const KEY = (accountId: string) => `prune:${accountId}`;
const DAY = 86_400_000;
/** An article younger than this hasn't had its chance on Google yet. */
const MIN_AGE_DAYS = 120;
/** How long a rewritten article gets before it's taken down. */
const AFTER_REWRITE_DAYS = 60;
/** At most this many taken down or suggested per month, so nothing big happens at once. */
const MAX_PER_RUN = 3;

export async function readPrune(accountId: string): Promise<PruneState | null> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${KEY(accountId)}`;
  return row?.value ? (JSON.parse(row.value) as PruneState) : null;
}

async function save(accountId: string, state: PruneState): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${KEY(accountId)}, ${JSON.stringify(state)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

const norm = (u: string) => u.split("#")[0].split("?")[0].replace(/\/+$/, "");

/** Accounts with the autopilot on whose monthly pruning check is due. */
export async function accountsDueForPrune(limit: number): Promise<string[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT a.account_id FROM insights_account_autopilot a
    LEFT JOIN insights_settings s ON s.key = 'prune:' || a.account_id
    WHERE a.enabled AND (s.updated_at IS NULL OR s.updated_at < now() - interval '30 days')
    ORDER BY s.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}

/** Records that the monthly check ran (keeping what was known), so a site that can't be checked doesn't block the others. */
export async function markPruneTried(accountId: string): Promise<void> {
  const prev = await readPrune(accountId).catch(() => null);
  await save(accountId, { at: new Date().toISOString(), pages: prev?.pages ?? {} }).catch(() => undefined);
}

export async function runPruner(accountId: string, conn: Connection, site: SiteAccess): Promise<string> {
  // Without Search Console there's no way to know an article gets nothing: do nothing rather than guess.
  if (!conn.gscSiteUrl) {
    await markPruneTried(accountId);
    return "no Search Console";
  }
  const impressions = new Map([...(await pageImpressions90d(conn))].map(([u, n]) => [norm(u), n]));
  // A Search Console property with no data at all can't tell good pages from bad ones.
  if (!impressions.size) {
    await markPruneTried(accountId);
    return "no Search Console data yet";
  }
  const articles = await site.articles();
  const prev = (await readPrune(accountId))?.pages ?? {};
  const pages: Record<string, PruneEntry> = {};
  const now = Date.now();

  // Articles the app wrote, and when.
  const made = new Map(
    (await sql`SELECT page_url, created_at, resource_id FROM insights_autopilot_changes WHERE account_id = ${accountId} AND field = 'new_article' AND status IN ('applied','kept')`).map(
      (r) => [norm(r.page_url!), { at: Date.parse(String(r.created_at)), id: r.resource_id! }]
    )
  );

  let acted = 0;
  const notes: string[] = [];
  for (const a of articles) {
    const url = norm(a.url);
    const views = impressions.get(url) ?? 0;
    const old = prev[url];
    if (views > 0) continue; // it's being seen: leave it (and forget any earlier flag)
    if (old?.stage === "removed" || old?.stage === "suggested") {
      pages[url] = old;
      continue;
    }
    // Age: when the app wrote it, else the publish date the platform reports. Unknown age: leave it alone.
    const appMade = made.get(url);
    let born = appMade?.at ?? null;
    if (born === null) {
      const res = await site.resolve(a.url).catch(() => null);
      born = res?.article?.publishedAt ? Date.parse(res.article.publishedAt) : null;
    }
    if (born === null || Number.isNaN(born) || now - born < MIN_AGE_DAYS * DAY) continue;

    if (!old) {
      pages[url] = { stage: "rewrite", since: new Date().toISOString(), appMade: Boolean(appMade) };
      notes.push(`flagged ${new URL(a.url).pathname} for a rewrite`);
      continue;
    }
    if (now - Date.parse(old.since) < AFTER_REWRITE_DAYS * DAY || acted >= MAX_PER_RUN) {
      pages[url] = old;
      continue;
    }

    // Still nothing after its rewrite: find the stronger related article to send visitors to.
    const want = topicWords(a.title);
    let into: { url: string; score: number } | null = null;
    for (const b of articles) {
      const bu = norm(b.url);
      if (bu === url) continue;
      const seen = impressions.get(bu) ?? 0;
      const shared = [...topicWords(b.title)].filter((w) => want.has(w)).length;
      if (!seen || !shared) continue;
      const score = shared * 1000 + seen;
      if (!into || score > into.score) into = { url: b.url, score };
    }
    const redirect = into ? ` Add a redirect from ${new URL(a.url).pathname} to ${new URL(into.url).pathname} so anyone with the old link lands somewhere useful.` : "";

    if (appMade && site.mode === "shopify" && site.store) {
      await setArticlePublished(site.store, appMade.id, false);
      await logChange({
        accountId,
        runId: null,
        pageUrl: a.url,
        resourceType: "article",
        resourceId: appMade.id,
        query: a.title,
        field: "prune",
        before: "published",
        after: "draft",
        reason: `No Google impressions in 90 days, even after a rewrite, so it was taken back to a draft (undo from the history if you want it back).${redirect}`,
        // Not measured like other changes: there is nothing left on the page to measure.
        status: "kept",
      });
      pages[url] = { stage: "removed", since: new Date().toISOString(), into: into?.url ?? null, appMade: true };
      notes.push(`took ${new URL(a.url).pathname} back to a draft`);
    } else {
      await logChange({
        accountId,
        runId: null,
        pageUrl: a.url,
        resourceType: "site",
        resourceId: a.url,
        query: a.title,
        field: "prune",
        before: null,
        after: into ? `Take down and redirect to ${into.url}` : "Take down (back to a draft)",
        reason: `No Google impressions in 90 days, even after a rewrite. Your call: take it down, or keep it if it serves readers another way.${redirect}`,
        status: "suggested",
      });
      pages[url] = { stage: "suggested", since: new Date().toISOString(), into: into?.url ?? null, appMade: Boolean(appMade) };
      notes.push(`suggested taking down ${new URL(a.url).pathname}`);
    }
    acted++;
  }
  await save(accountId, { at: new Date().toISOString(), pages });
  return notes.join(", ") || "nothing to prune";
}
