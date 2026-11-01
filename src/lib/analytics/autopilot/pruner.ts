import type { Connection } from "../connection";
import { ensureSchema, sql } from "../db";
import { gscHasDataFrom, pageImpressions90d } from "../seo-tools";
import { logChange } from "./engine";
import { setArticlePublished } from "./shopify";
import type { SiteAccess } from "./site-source";
import { topicWords } from "./site-keywords";
import { readTargets, saveTarget } from "./targets";
import type { AiProvider } from "./settings";
import { reviewTakedown } from "./writer";
import { plainText } from "./guards";

/**
 * Content pruning (the owner's rule: three months, then it goes).
 * Once a month, an article at least three months old that Google hasn't shown
 * even once in the last 90 days is reviewed by a second AI, which keeps it
 * whenever there's a good reason. If the reviewer agrees it should go: an
 * article the app wrote on a Shopify store is taken back to a draft (undoable
 * from the history), with a redirect to a stronger related article suggested;
 * anything else, including every article the owner wrote, is only suggested
 * on the fix list. Never a hard delete.
 *
 * Pages are compared by path only (lowercase, decoded, no trailing slash),
 * with impressions added up across hosts and schemes, because Search Console
 * reports full addresses (www or not, http or https, several hosts for a
 * domain property) while the site lists paths.
 */

export interface PruneEntry {
  /** "kept": the reviewing AI decided it stays; it's looked at again after a while. */
  stage: "rewrite" | "removed" | "suggested" | "kept";
  since: string;
  /** The article's full address. */
  url: string;
  /** The stronger related article to send its visitors to. */
  into?: string | null;
  appMade: boolean;
}
export interface PruneState {
  at: string;
  /** Keyed by path (see pathKey). */
  pages: Record<string, PruneEntry>;
}

const KEY = (accountId: string) => `prune:${accountId}`;
const DAY = 86_400_000;
/** An article younger than this hasn't had its chance on Google yet (the owner's rule: three months). */
const MIN_AGE_DAYS = 90;
/** At most this many taken down or suggested per month, so nothing big happens at once. */
const MAX_PER_RUN = 3;
/** Search Console's row cap: when a site has more pages than this, unseen can't be told from cut off, so the check is skipped. */
const GSC_ROWS = 5000;

/** A page's path for comparing: lowercase, no query, no fragment, no trailing slash. Works on full addresses and bare paths. */
export function pathKey(u: string): string {
  try {
    let p = new URL(u, "https://x.invalid").pathname;
    // Search Console may encode characters the site lists plainly (' ( ! and so on): compare them decoded.
    try {
      p = decodeURIComponent(p);
    } catch {
      /* keep it encoded */
    }
    p = p.normalize("NFC").toLowerCase().replace(/\/+$/, "");
    return p || "/";
  } catch {
    return "";
  }
}

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

/** Points a target at its article again, or away from it when it's taken down. */
async function setTargetLive(accountId: string, url: string, live: boolean): Promise<void> {
  const key = pathKey(url);
  for (const t of await readTargets(accountId).catch(() => [])) {
    const matches = (t.page && pathKey(t.page) === key) || (t.article?.url && pathKey(t.article.url) === key);
    if (!matches) continue;
    await saveTarget(accountId, {
      ...t,
      page: live ? url : null,
      article: t.article ? { ...t.article, live, note: live ? "Published again" : "Taken down: no Google views" } : t.article,
    });
  }
}
export const restoreTarget = (accountId: string, url: string) => setTargetLive(accountId, url, true);

/** After the reviewer keeps an article, it isn't looked at again for this long. */
const KEPT_DAYS = 180;
/** AI reviews per monthly run; the rest wait for next month (keeps the hourly check quick). */
const MAX_REVIEWS = 5;

/**
 * `origin` is the site's address, like https://example.com (used to turn the site's paths into full addresses).
 * `ai` is required: nothing is taken down or suggested without a second AI reviewing it first.
 */
export async function runPruner(accountId: string, conn: Connection, site: SiteAccess, origin: string, ai: AiProvider | null, sells: string): Promise<string> {
  // Without Search Console there's no way to know an article gets nothing: do nothing rather than guess.
  if (!conn.gscSiteUrl) {
    await markPruneTried(accountId);
    return "no Search Console";
  }
  const { pages: raw, rows } = await pageImpressions90d(conn);
  // No data at all, or more pages than one report holds: unseen can't be told apart from missing.
  if (!rows || rows >= GSC_ROWS) {
    await markPruneTried(accountId);
    return rows ? "too many pages to check safely" : "no Search Console data yet";
  }
  // Search Console connected recently: it can't speak for 90 days yet.
  if (!(await gscHasDataFrom(conn, 90))) {
    await markPruneTried(accountId);
    return "Search Console has less than 90 days of data";
  }
  const impressions = new Map<string, number>();
  for (const [u, n] of raw) impressions.set(pathKey(u), (impressions.get(pathKey(u)) ?? 0) + n);

  const full = (u: string) => new URL(u, origin).href;
  const articles = (await site.articles()).map((a) => ({ ...a, url: full(a.url), key: pathKey(a.url) }));
  // If none of the site's articles shows up in this Search Console property, the property doesn't cover them
  // (old domain, another host): every article would look unseen, so nothing is judged.
  if (articles.length && !articles.some((a) => (impressions.get(a.key) ?? 0) > 0)) {
    await markPruneTried(accountId);
    return "this Search Console property doesn't seem to cover the site's articles";
  }
  const prevState = await readPrune(accountId);
  const prev = prevState?.pages ?? {};
  const listed = new Set(articles.map((a) => a.key));
  // What was already taken down or suggested stays on record even when the article no longer lists (drafts don't).
  const pages: Record<string, PruneEntry> = {};
  for (const [k, e] of Object.entries(prev)) if (e.stage !== "rewrite" && !listed.has(k)) pages[k] = e;
  const now = Date.now();

  // Articles the app wrote, and when.
  const made = new Map(
    (await sql`SELECT page_url, created_at, resource_id FROM insights_autopilot_changes WHERE account_id = ${accountId} AND field = 'new_article' AND status IN ('applied','kept')`).map(
      (r) => [pathKey(r.page_url!), { at: Date.parse(String(r.created_at)), id: r.resource_id! }]
    )
  );

  let acted = 0;
  let reviews = 0;
  const notes: string[] = [];
  for (const a of articles) {
    try {
      const views = impressions.get(a.key) ?? 0;
      const old = prev[a.key];
      if (views > 0) continue; // it's being seen: leave it (and forget any earlier flag)
      if (old?.stage === "removed" || old?.stage === "suggested") {
        pages[a.key] = old;
        continue;
      }
      // The reviewer kept it: leave it alone for six months, then it may be looked at again from the start.
      if (old?.stage === "kept") {
        if (now - Date.parse(old.since) < KEPT_DAYS * DAY) pages[a.key] = old;
        continue;
      }
      // Age: when the app wrote it, else the publish date the platform reports. Unknown age: leave it alone.
      const appMade = made.get(a.key);
      let born = appMade?.at ?? null;
      if (born === null) {
        const res = await site.resolve(a.url).catch(() => null);
        born = res?.article?.publishedAt ? Date.parse(res.article.publishedAt) : null;
      }
      if (born === null || Number.isNaN(born) || now - born < MIN_AGE_DAYS * DAY) continue;

      const path = new URL(a.url).pathname;
      if (old) pages[a.key] = old;
      // Three months old and never shown on Google at all: it goes to review (within the month's cap).
      if (acted >= MAX_PER_RUN) continue;

      // Find the stronger related article to send its visitors to.
      const want = topicWords(a.title);
      let into: { url: string; score: number } | null = null;
      for (const b of articles) {
        if (b.key === a.key) continue;
        const seen = impressions.get(b.key) ?? 0;
        const shared = [...topicWords(b.title)].filter((w) => want.has(w)).length;
        if (!seen || !shared) continue;
        const score = shared * 1000 + seen;
        if (!into || score > into.score) into = { url: b.url, score };
      }
      const redirect = into ? ` Add a redirect from ${path} to ${new URL(into.url).pathname} so anyone with the old link lands somewhere useful.` : "";

      // Another agent looks at it first. No reviewer, or any doubt: it stays.
      if (!ai || reviews >= MAX_REVIEWS) continue;
      reviews++;
      const verdict = await reviewTakedown(ai, { title: a.title, url: a.url, text: plainText(a.body ?? ""), into: into?.url ?? null, siteSells: sells }).catch(() => null);
      if (!verdict?.remove) {
        pages[a.key] = { stage: "kept", since: new Date().toISOString(), url: a.url, appMade: Boolean(appMade) };
        notes.push(`kept ${path}: ${verdict?.why || "the review couldn't be done, so it stays"}`);
        continue;
      }

      if (appMade && site.mode === "shopify" && site.store) {
        // Logged first, so a take down always has a history row to undo from.
        const changeId = await logChange({
          accountId,
          runId: null,
          pageUrl: a.url,
          resourceType: "article",
          resourceId: appMade.id,
          query: a.title,
          field: "prune",
          before: "published",
          after: "draft",
          reason: `Not shown on Google at all in the last three months, and a second AI agreed: ${verdict.why} It was taken back to a draft (undo from the history if you want it back).${redirect}`,
          // Not measured like other changes: there is nothing left on the page to measure.
          status: "kept",
        });
        try {
          await setArticlePublished(site.store, appMade.id, false);
        } catch (e) {
          await sql`UPDATE insights_autopilot_changes SET status = 'failed', note = ${(e as Error).message} WHERE id = ${changeId}`.catch(() => undefined);
          throw e;
        }
        await setTargetLive(accountId, a.url, false);
        pages[a.key] = { stage: "removed", since: new Date().toISOString(), url: a.url, into: into?.url ?? null, appMade: true };
        notes.push(`took ${path} back to a draft`);
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
          reason: `Not shown on Google at all in three months, and a second AI suggests removing it: ${verdict.why} Your call: take it down, or keep it if it serves readers another way.${redirect}`,
          status: "suggested",
        });
        pages[a.key] = { stage: "suggested", since: new Date().toISOString(), url: a.url, into: into?.url ?? null, appMade: Boolean(appMade) };
        notes.push(`suggested taking down ${path}`);
      }
      acted++;
    } catch (e) {
      // One article failing never loses the month's record of the others.
      notes.push(`skipped one article: ${(e as Error).message}`);
      if (prev[a.key]) pages[a.key] = pages[a.key] ?? prev[a.key];
    }
  }
  await save(accountId, { at: new Date().toISOString(), pages });
  return notes.join(", ") || "nothing to prune";
}
