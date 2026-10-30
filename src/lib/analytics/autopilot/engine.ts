import { nextNewArticle, unpublishArticle } from "./new-articles";
import type { Connection } from "../connection";
import { ensureSchema, sql, type Row } from "../db";
import { resolveRange } from "../dates";
import { googleRequest } from "../google-auth";
import { readProfile, siteBrief } from "../profile";
import type { Opportunity } from "../seo-types";
import { readyApps, type Candidate, type Hub, type Mode, type RankingApp } from "./apps";
import { keyOf } from "./apps/types";
import { clickGain } from "./keyword-boost";
import { aiProvider, readAccountAutopilot, readPlatformSettings, type AiProvider, type PlatformSettings } from "./settings";
import {
  copiedFrom,
  duplicateOf,
  pagesForQuery,
  plainText,
  PROTECTED_PAGE,
  strongerRival,
  trafficCheck,
  type SiteItem,
} from "./guards";
import { undoLinkFix } from "./link-fixer";
import { EditedMeanwhile, siteFor, type SiteAccess } from "./site-source";
import { buildSchema, liveHtml, withoutAutopilotSchema } from "./schema";
import type { StoreAccess, StoreResource } from "./shopify";
import type { AutopilotChange, AutopilotPreview, AutopilotRun, ChangeField } from "./types";
import { blocksOf, dropBlocks, writeImprovement, writeInternalLink, type PageImprovement } from "./writer";

/**
 * The SEO autopilot. Each run: measure older changes and undo the ones that
 * hurt, then improve one page (titles, descriptions, alt text, a new
 * section, an internal link), within the weekly page limit.
 *
 * Which page, in order:
 * 1. Defend: a page one search that is slipping.
 * 2. Attack: the biggest gain among #2 to #3 searches going for #1, and #4 to #20 going for the top 3.
 * The connected apps (./apps) suggest the candidates, size and weight them,
 * and brief the writer on the chosen one: Search Console, Analytics, Keyword
 * Planner and Google page one today, more as they're added.
 */

const MEASURE_AFTER_DAYS = 28;
const REST_DAYS_PER_PAGE = 45;
/** A slipping page can be defended again sooner, once the last change has had time to count. */
const DEFEND_REST_DAYS = 21;
const WORSE_BY_POSITIONS = 3;

/** Everything a run needs for one customer. */
interface Ctx {
  accountId: string;
  /** Where pages are read from; on a Shopify store also where changes are written. */
  site: SiteAccess;
  /** Shopify only. */
  store: StoreAccess | null;
  ai: AiProvider;
  platform: PlatformSettings;
  ourDomain: string;
  allowContent: boolean;
  maxPagesPerWeek: number;
  /** The site's pages, loaded once per run for the duplicate guards. */
  index?: Promise<SiteItem[]>;
}

const siteOf = (ctx: Ctx) => (ctx.index ??= ctx.site.index().catch(() => []));


const marker = (id: string) => [`<!-- autopilot:${id} -->`, `<!-- /autopilot:${id} -->`];

function wrap(id: string, html: string) {
  const [start, end] = marker(id);
  return `${start}${html}${end}`;
}

/** Removes an autopilot block from a body, leaving anything else (including later edits) alone. */
function unwrap(id: string, body: string): string | null {
  const [start, end] = marker(id);
  const i = body.indexOf(start);
  const j = body.indexOf(end);
  if (i === -1 || j === -1 || j < i) return null;
  return body.slice(0, i) + body.slice(j + end.length);
}

export async function logChange(c: {
  accountId: string;
  runId: string | null;
  pageUrl: string;
  resourceType: string;
  resourceId: string;
  query: string;
  field: ChangeField;
  targetId?: string;
  before: string | null;
  after: string | null;
  reason?: string;
  status: string;
  op?: Opportunity;
  note?: string;
}): Promise<string> {
  const [row] = await sql`
    INSERT INTO insights_autopilot_changes
      (account_id, run_id, page_url, resource_type, resource_id, query, field, target_id, before_value, after_value, reason, status,
       baseline_position, baseline_clicks, baseline_impressions, note)
    VALUES (${c.accountId}, ${c.runId}, ${c.pageUrl}, ${c.resourceType}, ${c.resourceId}, ${c.query}, ${c.field}, ${c.targetId ?? null},
      ${c.before}, ${c.after}, ${c.reason ?? null}, ${c.status},
      ${c.op?.position ?? null}, ${c.op?.clicks ?? null}, ${c.op?.impressions ?? null}, ${c.note ?? null})
    RETURNING id`;
  return row.id!;
}

/** Words every post shares, which say nothing about whether two posts are on the same topic. */
const GENERIC = new Set(
  "best top guide guides buyer buyers review reviews supplement supplements vitamin vitamins what when which with your that this from about does work works ways tips need know complete ultimate review 2024 2025 2026 2027 benefits".split(" ")
);

/** Topic words of a title or search: no filler, no generic shopping words, plurals folded. */
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !GENERIC.has(w))
      .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
  );

// ---------- measuring ----------

/** Today's position from the daily rank check, for sites without Search Console. */
async function trackedPosition(accountId: string, query: string): Promise<{ position: number; clicks: number } | null> {
  const [row] = await sql`SELECT position FROM insights_rank_daily WHERE account_id = ${accountId} AND query = ${query.toLowerCase()}
    ORDER BY checked_on DESC LIMIT 1`;
  if (!row) return null;
  return { position: row.position === null ? 25 : Number(row.position), clicks: 0 };
}

async function positionFor(conn: Connection, query: string, page: string) {
  const { current } = resolveRange("28d", 3);
  const body = await googleRequest<{ rows?: { position: number; clicks: number; impressions: number }[] }>(
    { kind: "oauth", refreshToken: conn.refreshToken },
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(conn.gscSiteUrl!)}/searchAnalytics/query`,
    {
      startDate: current.start,
      endDate: current.end,
      dimensionFilterGroups: [{ filters: [
        { dimension: "query", operator: "equals", expression: query },
        { dimension: "page", operator: "equals", expression: page },
      ] }],
    }
  );
  return body.rows?.[0] ?? null;
}

/** Looks at pages changed at least 4 weeks ago; keeps what helped and undoes what hurt. */
async function measureOlderChanges(ctx: Ctx, conn: Connection): Promise<string[]> {
  const due = await sql`
    SELECT run_id, page_url, query, min(baseline_position) AS baseline_position, min(baseline_clicks) AS baseline_clicks
    FROM insights_autopilot_changes
    WHERE account_id = ${ctx.accountId} AND status = 'applied' AND created_at < now() - make_interval(days => ${MEASURE_AFTER_DAYS})
    GROUP BY run_id, page_url, query
    LIMIT 5`;
  const notes: string[] = [];
  for (const d of due) {
    const now = conn.gscSiteUrl
      ? await positionFor(conn, d.query!, d.page_url!).catch(() => null)
      : await trackedPosition(ctx.accountId, d.query!).catch(() => null);
    const baseline = Number(d.baseline_position);
    const baseClicks = Number(d.baseline_clicks ?? 0);
    const worse = now ? now.position > baseline + WORSE_BY_POSITIONS && now.clicks <= baseClicks : false;
    const changes = await sql`
      SELECT * FROM insights_autopilot_changes
      WHERE run_id = ${d.run_id} AND page_url = ${d.page_url} AND status = 'applied' ORDER BY id DESC`;
    for (const c of changes) {
      if (worse) {
        const note = await revertRow(ctx, c).catch((e) => `Undo failed: ${e.message}`);
        await sql`UPDATE insights_autopilot_changes SET evaluated_at = now(), result_position = ${now!.position}, result_clicks = ${now!.clicks},
          note = ${`Ranking dropped from ${baseline.toFixed(1)} to ${now!.position.toFixed(1)}. ${note}`} WHERE id = ${c.id}`;
      } else {
        await sql`UPDATE insights_autopilot_changes SET status = 'kept', evaluated_at = now(),
          result_position = ${now?.position ?? null}, result_clicks = ${now?.clicks ?? null},
          note = ${now ? `Position ${baseline.toFixed(1)} → ${now.position.toFixed(1)}` : "Not enough search data yet to compare; kept."} WHERE id = ${c.id}`;
      }
    }
    notes.push(`${worse ? "Undid" : "Kept"} changes for “${d.query}”`);
  }
  return notes;
}

// ---------- improving ----------

/** Legal, contact, account and similar pages on any website: never rewritten. */
const PROTECTED_ANY = /\/(contact|privacy|terms|refund|returns?|shipping|polic(y|ies)|legal|cookies?|accessibility|disclaimer|cart|checkout|account|login|search|tag|tags|author|category|categories)(\/|$)/i;

/**
 * The best candidate on a page the autopilot may change. On Shopify that's a
 * blog post, page, product or collection; on any other website it's any
 * content page (not the home page, legal or utility pages).
 */
function pickTarget(cands: Candidate[], brand: string, rested: (c: Candidate) => boolean, shopify: boolean): Candidate | null {
  return (
    cands.find((c) => {
      const path = new URL(c.op.page).pathname;
      const editable = shopify
        ? /^\/(blogs\/[^/]+\/[^/]+|pages|products|collections)\//.test(path + "/")
        : path.replace(/\/+$/, "") !== "" && !PROTECTED_ANY.test(path);
      return !(brand && c.op.query.includes(brand)) && !rested(c) && !PROTECTED_PAGE.test(path) && editable;
    }) ?? null
  );
}

const score = (c: Candidate) => clickGain(c.op) * Object.values(c.weights).reduce((a, w) => a * w, 1);
const MODE_ORDER: Record<Mode, number> = { defend: 0, top: 1, climb: 1 };

/** Every ready app suggests candidates and enriches all of them; defend comes first, then the biggest gain. */
async function gatherCandidates(hub: Hub, apps: RankingApp[], notes: string[]): Promise<Candidate[]> {
  const seen = new Set<string>();
  const cands: Candidate[] = [];
  for (const app of apps) {
    if (!app.candidates) continue;
    const found = await app.candidates(hub).catch((e) => {
      notes.push(`${app.name} couldn't suggest pages: ${(e as Error).message}`);
      return [];
    });
    for (const c of found) {
      if (seen.has(keyOf(c.op))) {
        // A later app may know it's slipping when an earlier one only saw room to climb.
        const existing = cands.find((x) => keyOf(x.op) === keyOf(c.op))!;
        if (c.mode === "defend" && existing.mode !== "defend") Object.assign(existing, { mode: "defend", previousPosition: c.previousPosition });
        continue;
      }
      seen.add(keyOf(c.op));
      cands.push(c);
    }
  }
  for (const app of apps) {
    if (app.enrich) await app.enrich(hub, cands).catch((e) => notes.push(`${app.name} was skipped: ${(e as Error).message}`));
  }
  return cands.sort((a, b) => MODE_ORDER[a.mode] - MODE_ORDER[b.mode] || score(b) - score(a));
}

/** Every ready app briefs the writer on the chosen target, in order. */
async function gatherBriefs(hub: Hub, apps: RankingApp[], cand: Candidate, notes: string[]) {
  const briefs: string[] = [];
  const summaries: string[] = [];
  const used: string[] = [];
  for (const app of apps) {
    if (!app.brief) continue;
    const b = await app.brief(hub, cand).catch((e) => {
      notes.push(`${app.name} was skipped: ${(e as Error).message}`);
      return null;
    });
    if (!b) continue;
    briefs.push(b.text);
    if (b.summary) summaries.push(b.summary);
    used.push(app.name);
  }
  return { briefs, summaries, used };
}

interface Plan {
  cand: Candidate;
  page: StoreResource;
  improvement: PageImprovement;
  summaries: string[];
  apps: string[];
}

/** Targets tried per run when the writer finds a page can't match what searchers want. */
const MAX_WRITES_PER_RUN = 3;

/**
 * Picks the page and has the writer plan the change. Nothing is written to the
 * store. A target whose page can't give searchers what they want is set aside
 * as a content gap (logged unless `recordGap` is null) and the next one is tried.
 */
async function planNextChange(
  ctx: Ctx,
  conn: Connection,
  notes: string[],
  recordGap: ((cand: Candidate, page: StoreResource, idea: string) => Promise<void>) | null
): Promise<Plan | null> {
  const hub: Hub = { accountId: ctx.accountId, conn, platform: ctx.platform, ourDomain: ctx.ourDomain, shared: new Map() };
  const apps = await readyApps(hub);
  const cands = await gatherCandidates(hub, apps, notes);

  const changedSince = async (days: number) =>
    new Set(
      (await sql`SELECT DISTINCT page_url FROM insights_autopilot_changes
        WHERE account_id = ${ctx.accountId} AND status IN ('applied', 'kept', 'reverted', 'skipped', 'suggested') AND created_at > now() - make_interval(days => ${days})`).map(
        (r) => r.page_url!
      )
    );
  const [restedLong, restedShort] = await Promise.all([changedSince(REST_DAYS_PER_PAGE), changedSince(DEFEND_REST_DAYS)]);
  const skipped = new Set<string>();
  const rested = (c: Candidate) => skipped.has(c.op.page) || (c.mode === "defend" ? restedShort : restedLong).has(c.op.page);
  const brand = ctx.ourDomain.split(".")[0];

  for (let writes = 0; writes < MAX_WRITES_PER_RUN; writes++) {
    let cand = pickTarget(cands, brand, rested, ctx.site.mode === "shopify");
    let page: StoreResource | null = null;
    // Skip pages that don't map to an editable store item, and pages losing a search to another of the site's pages.
    for (let tries = 0; cand && tries < 8; tries++) {
      page = await ctx.site.resolve(cand.op.page).catch(() => null);
      const rival = page ? strongerRival(cand.op.page, await pagesForQuery(conn, cand.op.query).catch(() => [])) : null;
      if (page && !rival) break;
      if (rival) {
        notes.push(
          `Left ${new URL(cand.op.page).pathname} alone for “${cand.op.query}”: ${new URL(rival.page).pathname} gets more of that search, and two pages competing hold each other back. Only the stronger page is worked on.`
        );
      }
      page = null;
      skipped.add(cand.op.page);
      cand = pickTarget(cands, brand, rested, ctx.site.mode === "shopify");
    }
    if (!cand || !page) return null;

    const { briefs, summaries, used } = await gatherBriefs(hub, apps, cand, notes);
    const improvement = await writeImprovement(
      ctx.ai,
      page,
      { query: cand.op.query, position: cand.op.position, impressions: cand.op.impressions, mode: cand.mode, previousPosition: cand.previousPosition },
      briefs,
      ctx.allowContent
    );
    if (improvement.intentMatch) return { cand, page, improvement: await guardDuplicates(ctx, page, improvement, notes), summaries, apps: used };

    const idea = improvement.missingForIntent || "People searching this want something the page doesn't have yet.";
    notes.push(`Skipped “${cand.op.query}” on ${new URL(cand.op.page).pathname}: ${idea}`);
    await recordGap?.(cand, page, idea).catch(() => undefined);
    skipped.add(cand.op.page);
  }
  return null;
}

/** No title or description another page already uses, no section copied from another page or repeating this one. */
async function guardDuplicates(ctx: Ctx, page: StoreResource, imp: PageImprovement, notes: string[]): Promise<PageImprovement> {
  const site = await siteOf(ctx);
  const path = new URL(page.url).pathname;
  const out = { ...imp };
  const titleTwin = out.metaTitle && out.metaTitle !== page.metaTitle ? duplicateOf(out.metaTitle, path, site, "title") : null;
  if (titleTwin) {
    notes.push(`Kept the current SEO title: the new one was nearly the same as ${titleTwin.path}'s.`);
    out.metaTitle = page.metaTitle ?? "";
  }
  const descTwin =
    out.metaDescription && out.metaDescription !== page.metaDescription ? duplicateOf(out.metaDescription, path, site, "description") : null;
  if (descTwin) {
    notes.push(`Kept the current meta description: the new one was nearly the same as ${descTwin.path}'s.`);
    out.metaDescription = page.metaDescription ?? "";
  }
  if (out.contentSectionHtml) {
    const cache = new Map<string, Set<string>>();
    const self: SiteItem = { path: "this page", kind: page.type, title: page.title, seoTitle: "", seoDescription: null, text: plainText(page.body) };
    const others = [self, ...site.filter((i) => i.path !== path)];
    const sources = new Set<string>();
    out.contentSectionHtml = dropBlocks(out.contentSectionHtml, (text) => {
      const from = copiedFrom(text, path, others, cache);
      if (from) sources.add(from.path);
      return Boolean(from);
    });
    if (sources.size) notes.push(`Dropped new paragraphs that repeated ${[...sources].join(", ")}.`);
    if (!blocksOf(out.contentSectionHtml).length) out.contentSectionHtml = "";
  }
  return out;
}

/** The other blog post most related to the page, that doesn't link to it yet. */
async function linkSource(ctx: Ctx, cand: Candidate, page: StoreResource) {
  const path = new URL(cand.op.page).pathname;
  const topic = words(`${cand.op.query} ${page.title}`);
  return (await ctx.site.articles())
    .filter((a) => a.url !== path && !a.body.includes(path))
    .map((a) => ({ a, score: [...words(a.title)].filter((w) => topic.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)[0]?.a;
}

/** Structured data the page should get, or null. */
async function schemaFor(ctx: Ctx, page: StoreResource, body: string): Promise<string | null> {
  const [live, name] = await Promise.all([liveHtml(page.url), ctx.site.name().catch(() => ctx.ourDomain)]);
  return buildSchema(page, body, live, name);
}

/**
 * For sites the app can't edit: the same changes, saved as a fix list for the
 * owner to paste in. Marked done, they're measured like any other change.
 */
async function suggestPlan(ctx: Ctx, runId: string, plan: Plan): Promise<string[]> {
  const { cand, page, improvement } = plan;
  const op = cand.op;
  const done: string[] = [];
  const base = { accountId: ctx.accountId, runId, pageUrl: op.page, resourceType: "site", resourceId: page.url, query: op.query, reason: improvement.reason, op };
  const suggest = async (field: ChangeField, before: string | null, after: string, targetId?: string) => {
    await logChange({ ...base, field, before, after, status: "suggested", targetId });
    done.push(field);
  };
  if (improvement.metaTitle && improvement.metaTitle !== page.metaTitle) await suggest("meta_title", page.metaTitle, improvement.metaTitle);
  if (improvement.metaDescription && improvement.metaDescription !== page.metaDescription) {
    await suggest("meta_description", page.metaDescription, improvement.metaDescription);
  }
  if (improvement.contentSectionHtml) await suggest("content", null, improvement.contentSectionHtml);
  const body = improvement.contentSectionHtml ? `${page.body}\n${improvement.contentSectionHtml}` : page.body;
  const schema = await schemaFor(ctx, { ...page, metaDescription: improvement.metaDescription || page.metaDescription }, body).catch(() => null);
  if (schema) await suggest("schema", null, withoutAutopilotSchema(schema).trim() || schema);
  const source = await linkSource(ctx, cand, page).catch(() => undefined);
  if (source) {
    const sentence = await writeInternalLink(ctx.ai, source, { path: new URL(op.page).pathname, query: op.query, title: page.title });
    if (sentence) await suggest("internal_link", null, sentence, source.id);
  }
  return done;
}

async function applyPlan(ctx: Ctx, runId: string, plan: Plan): Promise<string[]> {
  const w = ctx.site.writer;
  if (!w) return suggestPlan(ctx, runId, plan);
  const { cand, page, improvement } = plan;
  const op = cand.op;
  const done: string[] = [];
  // Snippet sites: the logged change is what the snippet serves on that page.
  const resourceType = ctx.site.mode === "snippet" ? "snippet" : page.type;
  const base = { accountId: ctx.accountId, runId, pageUrl: op.page, resourceType, resourceId: page.id, query: op.query, reason: improvement.reason, op };

  const apply = async (field: ChangeField, before: string | null, after: string, run: () => Promise<void>, targetId?: string) => {
    try {
      await run();
      await logChange({ ...base, field, before, after, status: "applied", targetId });
      done.push(field);
    } catch (err) {
      // Saved, but live only at the owner's next publish (Webflow with other unpublished work).
      const saved = (err as Error).name === "SavedNotLive";
      const status = saved ? "applied" : err instanceof EditedMeanwhile ? "skipped" : "failed";
      await logChange({ ...base, field, before, after, status, targetId, note: (err as Error).message });
      if (saved) done.push(field);
    }
  };
  // What this platform can't change for this page goes on the fix list instead.
  const can = async (field: ChangeField, id: string) => !w.supports || (await w.supports(field, id).catch(() => false));
  const suggest = async (field: ChangeField, before: string | null, after: string, targetId?: string) => {
    await logChange({ ...base, resourceType: "site", resourceId: page.url, field, before, after, status: "suggested", targetId });
    done.push(field);
  };

  if (improvement.metaTitle && improvement.metaTitle !== page.metaTitle) {
    if (await can("meta_title", page.id)) await apply("meta_title", page.metaTitle, improvement.metaTitle, () => w.setSeo(page.id, "title", improvement.metaTitle));
    else await suggest("meta_title", page.metaTitle, improvement.metaTitle);
  }
  if (improvement.metaDescription && improvement.metaDescription !== page.metaDescription) {
    if (await can("meta_description", page.id)) {
      await apply("meta_description", page.metaDescription, improvement.metaDescription, () => w.setSeo(page.id, "description", improvement.metaDescription));
    } else await suggest("meta_description", page.metaDescription, improvement.metaDescription);
  }
  if (w.setAlt) {
    for (const a of improvement.altTexts) await apply("alt", null, a.alt, () => w.setAlt!(a.imageId, a.alt), a.imageId);
  }
  const canContent = await can("content", page.id);
  if (improvement.contentSectionHtml && (page.type === "article" || page.type === "page")) {
    const blockId = `${runId}-content`;
    const block = wrap(blockId, improvement.contentSectionHtml);
    if (canContent) await apply("content", blockId, block, () => w.setBodyIfUnchanged(page.type as "article" | "page", page.id, page.body, `${page.body}\n${block}`));
    else await suggest("content", null, improvement.contentSectionHtml);
  }

  // Structured data, rebuilt from the page as it is now (including any new FAQ).
  if ((page.type === "article" || page.type === "page") && !(await can("schema", page.id))) {
    const body = improvement.contentSectionHtml ? `${page.body}\n${improvement.contentSectionHtml}` : page.body;
    const schema = await schemaFor(ctx, { ...page, metaDescription: improvement.metaDescription || page.metaDescription }, body).catch(() => null);
    if (schema) await suggest("schema", null, schema);
  } else if (page.type === "article" || page.type === "page") {
    const type = page.type;
    const fetched = await w.getBody(type, page.id).catch(() => null);
    // Platforms without a text API (Wix) build structured data from the page as visitors see it.
    const current = fetched || (w.setSchema ? `${page.body}\n${improvement.contentSectionHtml}` : fetched);
    const updated = { ...page, metaDescription: improvement.metaDescription || page.metaDescription };
    const plan = current === null ? null : await schemaFor(ctx, updated, current);
    if (current !== null && plan) {
      const blockId = `${runId}-schema`;
      const block = wrap(blockId, plan);
      await apply("schema", blockId, block, () =>
        w.setSchema ? w.setSchema(type, page.id, block) : w.setBodyIfUnchanged(type, page.id, current, `${withoutAutopilotSchema(current)}\n${block}`)
      );
    }
  }

  const source = await linkSource(ctx, cand, page);
  if (source) {
    const path = new URL(op.page).pathname;
    const sentence = await writeInternalLink(ctx.ai, source, { path, query: op.query, title: page.title });
    if (sentence) {
      const blockId = `${runId}-link`;
      const block = wrap(blockId, sentence);
      if (await can("internal_link", source.id)) {
        await apply("internal_link", blockId, block, () => w.setBodyIfUnchanged("article", source.id, source.body, `${source.body}\n${block}`), source.id);
      } else await suggest("internal_link", null, sentence, new URL(source.url, op.page).href);
    }
  }
  return done;
}

function describe(cand: Candidate): string {
  const path = new URL(cand.op.page).pathname;
  const volume = cand.op.monthlySearches ? `, ${cand.op.monthlySearches.toLocaleString("en-US")} searches a month` : "";
  return cand.mode === "defend"
    ? `Defended ${path} for “${cand.op.query}” (slipped from ${cand.previousPosition?.toFixed(1)} to ${cand.op.position.toFixed(1)}${volume})`
    : cand.mode === "top"
      ? `Pushed ${path} for #1 on “${cand.op.query}” (now ${cand.op.position.toFixed(1)}${volume})`
      : `Improved ${path} for “${cand.op.query}” (now ${cand.op.position.toFixed(1)}${volume})`;
}

export interface RunResult {
  run: AutopilotRun | null;
  message: string;
  preview?: AutopilotPreview;
}

type Trigger = "schedule" | "manual" | "preview";

/**
 * One autopilot pass for one customer. Improves at most one page per call.
 * A "preview" goes through every step on live data but changes nothing: no
 * store edits, no measuring or undoing, and it doesn't count as a run.
 */
export async function runAutopilot(accountId: string, conn: Connection | null, trigger: Trigger): Promise<RunResult> {
  await ensureSchema();
  const [acct, platform] = await Promise.all([readAccountAutopilot(accountId), readPlatformSettings()]);
  if (trigger === "schedule" && !acct.enabled) return { run: null, message: "Autopilot is turned off." };
  if (!conn) return { run: null, message: "Connect Google first." };
  const baseAi = aiProvider(platform);
  if (!baseAi) return { run: null, message: "Autopilot isn't available yet." };
  const profile = await readProfile(accountId);
  // A Shopify store or connected WordPress is edited directly; any other website gets a fix list.
  const access = await siteFor(accountId);
  if (!access) return { run: null, message: "Connect your website first." };
  const store = access.store;
  const brand = profile.brandName ?? (access.mode === "manual" ? null : await access.name().catch(() => null));
  // The writer signs titles with the customer's own brand and fits what they sell.
  const ai = { ...baseAi, site: siteBrief({ ...profile, brandName: brand }) };
  const ctx: Ctx = {
    accountId,
    site: access,
    store,
    ai,
    platform,
    // Search Console's property, or (without it) the site's own domain.
    ourDomain: conn.gscSiteUrl
      ? new URL(conn.gscSiteUrl.replace(/^sc-domain:/, "https://")).hostname.replace(/^www\./, "")
      : (profile.siteDomain ?? ""),
    allowContent: acct.allowContent,
    maxPagesPerWeek: acct.maxPagesPerWeek,
  };
  const preview = trigger === "preview";

  if (!preview) {
    const running = await sql`SELECT id FROM insights_autopilot_runs
      WHERE account_id = ${accountId} AND status = 'running' AND trigger <> 'preview' AND started_at > now() - interval '30 minutes'`;
    if (running.length) return { run: null, message: "A run is already in progress." };
  }

  const [runRow] = await sql`INSERT INTO insights_autopilot_runs (account_id, trigger) VALUES (${accountId}, ${trigger}) RETURNING id`;
  if (!preview) await sql`UPDATE insights_account_autopilot SET last_run_at = now() WHERE account_id = ${accountId}`;
  const runId = runRow.id!;
  const summary: string[] = [];
  const notes: string[] = [];
  let status = "done";
  let previewOut: AutopilotPreview | undefined;
  try {
    if (!preview) summary.push(...(await measureOlderChanges(ctx, conn)));

    const [{ pages }] = await sql`
      SELECT count(DISTINCT page_url) AS pages FROM insights_autopilot_changes
      WHERE account_id = ${accountId} AND status IN ('applied', 'kept', 'suggested') AND field NOT IN ('internal_link', 'link_fix')
        AND created_at > now() - interval '7 days'`;
    const capped = Number(pages) >= ctx.maxPagesPerWeek;
    // Emergency brake: when Google clicks suddenly fall, change nothing new until it's clear why.
    const traffic = await trafficCheck(conn).catch(() => null);
    const brake = traffic?.sharp
      ? `Google clicks fell ${Math.round(traffic.drop * 100)}% last week (${traffic.recentWeek} against a usual ${traffic.usualWeek}). New changes are on hold until that settles; check Search Console for a Google update or a site problem.`
      : null;
    // A new article for a chosen search no page covers yet (within the weekly number).
    if (!preview && !capped && !brake) {
      const posted = await nextNewArticle({
        accountId,
        site: access,
        ai,
        platform,
        ourDomain: ctx.ourDomain,
        publish: acct.allowContent,
        perWeek: acct.articlesPerWeek,
      }).catch((e) => (notes.push(`New article not written: ${(e as Error).message}`), null));
      if (posted) {
        await logChange({
          accountId,
          runId,
          pageUrl: posted.url ?? `https://${ctx.ourDomain}/`,
          resourceType: posted.resourceType,
          resourceId: posted.resourceId,
          query: posted.keyword,
          field: "new_article",
          before: null,
          after: `<h1>${posted.article.title}</h1>\n<p><strong>SEO title:</strong> ${posted.article.metaTitle}<br><strong>Meta description:</strong> ${posted.article.metaDescription}</p>\n${posted.article.html}`,
          reason: `No page on the site covered "${posted.keyword}", so the autopilot wrote one from what ranks on Google page one.`,
          status: posted.resourceType === "site" ? "suggested" : "applied",
          note: posted.note || (posted.live ? "Published." : "Saved as a draft: turn on new content in Autopilot settings to publish automatically."),
        });
        summary.push(
          posted.url
            ? `${posted.live ? "Published" : "Drafted"} a new article for "${posted.keyword}": ${posted.url}`
            : `Wrote a new article for "${posted.keyword}" (on the fix list).`
        );
      }
    }
    if (capped && !preview) {
      summary.push(`Weekly limit reached (${pages} of ${ctx.maxPagesPerWeek} pages).`);
    } else if (brake && !preview) {
      summary.push(brake);
    } else {
      if (capped) notes.push(`The weekly limit is reached (${pages} of ${ctx.maxPagesPerWeek} pages), so a real run would wait.`);
      if (brake) notes.push(`${brake} A real run would wait.`);
      const recordGap = preview
        ? null
        : (cand: Candidate, page: StoreResource, idea: string) =>
            logChange({
              accountId,
              runId,
              pageUrl: cand.op.page,
              resourceType: page.type,
              resourceId: page.id,
              query: cand.op.query,
              field: "intent",
              before: null,
              after: idea,
              reason: "Searchers want something this page can't honestly offer yet, so the autopilot left it unchanged.",
              status: "skipped",
              op: cand.op,
            }).then(() => undefined);
      const plan = await planNextChange(ctx, conn, notes, recordGap);
      const gaps = notes.filter((n) => n.startsWith("Skipped “"));
      if (!plan) {
        summary.push(gaps.length ? `No change made. ${gaps.join(" ")}` : "No new opportunities to work on right now.");
      } else if (preview) {
        const { cand, page, improvement } = plan;
        const changes: AutopilotPreview["changes"] = [];
        if (improvement.metaTitle && improvement.metaTitle !== page.metaTitle) changes.push({ field: "meta_title", before: page.metaTitle, after: improvement.metaTitle });
        if (improvement.metaDescription && improvement.metaDescription !== page.metaDescription)
          changes.push({ field: "meta_description", before: page.metaDescription, after: improvement.metaDescription });
        for (const a of improvement.altTexts) changes.push({ field: "alt", before: null, after: a.alt });
        if (improvement.contentSectionHtml && (page.type === "article" || page.type === "page"))
          changes.push({ field: "content", before: null, after: improvement.contentSectionHtml });
        if (page.type === "article" || page.type === "page") {
          const body = improvement.contentSectionHtml ? `${page.body}\n${improvement.contentSectionHtml}` : page.body;
          const schema = await schemaFor(ctx, { ...page, metaDescription: improvement.metaDescription || page.metaDescription }, body).catch(() => null);
          if (schema) {
            const types = [...schema.matchAll(/"@type":"(BlogPosting|FAQPage)"/g)].map((m) => m[1]).join(" and ");
            changes.push({ field: "schema", before: null, after: `Adds ${types} structured data built from the page.` });
          }
        }
        const source = await linkSource(ctx, cand, page).catch(() => undefined);
        if (source) changes.push({ field: "internal_link", before: null, after: `A closing paragraph in “${source.title}” linking here.` });
        previewOut = {
          page: cand.op.page,
          query: cand.op.query,
          mode: cand.mode,
          position: cand.op.position,
          monthlySearches: cand.op.monthlySearches ?? null,
          apps: plan.apps,
          changes,
          reason: improvement.reason,
          notes: [...plan.summaries, ...notes],
        };
        summary.push(`Preview: ${describe(cand).replace(/^(Defended|Pushed|Improved)/, (w) => `would have ${w.toLowerCase()}`)}. ${changes.length} change${changes.length === 1 ? "" : "s"} planned, nothing written.`);
      } else {
        const done = await applyPlan(ctx, runId, plan);
        const extra = [...plan.summaries, ...gaps].length ? ` ${[...plan.summaries, ...gaps].join(" ")}` : "";
        summary.push(
          done.length
            ? `${describe(plan.cand)}: ${done.join(", ").replace(/_/g, " ")}.${extra}`
            : `Checked ${new URL(plan.cand.op.page).pathname}; it already looked good, nothing changed.${extra}`
        );
      }
    }
  } catch (err) {
    status = "failed";
    summary.push((err as Error).message);
  }
  const [run] = await sql`
    UPDATE insights_autopilot_runs SET finished_at = now(), status = ${status}, summary = ${summary.join(" ")}
    WHERE id = ${runId} RETURNING *`;
  return { run: toRun(run), message: summary.join(" "), preview: previewOut };
}

/** Accounts due for their daily run (enabled, store connected, not run in the last 20 hours). */
export async function accountsDueForRun(limit: number): Promise<string[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT a.account_id FROM insights_account_autopilot a
    LEFT JOIN insights_account_profile p ON p.account_id = a.account_id
    WHERE a.enabled AND (a.shop_token_enc IS NOT NULL OR p.site_domain IS NOT NULL)
      AND (a.last_run_at IS NULL OR a.last_run_at < now() - interval '20 hours')
    ORDER BY a.last_run_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => r.account_id!);
}

// ---------- undo ----------

async function revertRow(ctx: Ctx, c: Row): Promise<string> {
  const field = c.field as ChangeField;
  const w = ctx.site?.writer;
  if (c.resource_type === "snippet") {
    // The snippet only serves live changes, so marking it undone removes it from the site.
    await sql`UPDATE insights_autopilot_changes SET status = 'reverted' WHERE id = ${c.id}`;
    return "Removed from your site (the snippet stops showing it right away).";
  }
  if (c.resource_type === "site" || !w) {
    // A change pasted in by hand is changed back by hand.
    const back = c.before_value && field !== "content" && field !== "schema" && field !== "internal_link" ? `put back: ${c.before_value}` : "remove what was added";
    await sql`UPDATE insights_autopilot_changes SET status = 'reverted' WHERE id = ${c.id}`;
    return `This one didn't help; ${back}.`;
  }
  if (field === "new_article") {
    await unpublishArticle(ctx.accountId, ctx.site, c.resource_id!);
    await sql`UPDATE insights_autopilot_changes SET status = 'reverted' WHERE id = ${c.id}`;
    return "Taken off the site (kept as a draft).";
  }
  if (field === "meta_title" || field === "meta_description") {
    await w.setSeo(c.resource_id!, field === "meta_title" ? "title" : "description", c.before_value).catch((e) => {
      if ((e as Error).name !== "SavedNotLive") throw e;
    });
  } else if (field === "alt") {
    await w.setAlt?.(c.target_id!, c.before_value ?? "");
  } else if (field === "link_fix") {
    if (!ctx.store || !(await undoLinkFix(ctx.store, c.resource_type as "article" | "page", c.resource_id!, c.before_value!, c.after_value!))) {
      await sql`UPDATE insights_autopilot_changes SET status = 'skipped', note = 'The post was edited after the fix, so it was left as is.' WHERE id = ${c.id}`;
      return "Left as is.";
    }
  } else if (field === "schema" && w.setSchema) {
    await w.setSchema(c.resource_type as "article" | "page", c.resource_id!, null);
  } else {
    const type = field === "internal_link" ? "article" : (c.resource_type as "article" | "page");
    const id = field === "internal_link" ? c.target_id! : c.resource_id!;
    const body = await w.getBody(type, id);
    const restored = unwrap(c.before_value!, body);
    if (restored === null) {
      await sql`UPDATE insights_autopilot_changes SET status = 'skipped', note = 'The added section was already removed or edited by hand.' WHERE id = ${c.id}`;
      return "Already removed.";
    }
    await w.setBody(type, id, restored);
  }
  await sql`UPDATE insights_autopilot_changes SET status = 'reverted' WHERE id = ${c.id}`;
  return "Restored the previous version.";
}

/** The owner pasted a fix list item in (it's measured from now on) or skipped it. */
export async function markSuggestion(accountId: string, id: string, done: boolean): Promise<void> {
  await ensureSchema();
  const rows = done
    ? await sql`UPDATE insights_autopilot_changes SET status = 'applied', created_at = now(), note = 'Done by hand.'
        WHERE id = ${id} AND account_id = ${accountId} AND status = 'suggested' RETURNING id`
    : await sql`UPDATE insights_autopilot_changes SET status = 'skipped', note = 'Skipped.'
        WHERE id = ${id} AND account_id = ${accountId} AND status = 'suggested' RETURNING id`;
  if (!rows.length) throw new Error("That fix isn't waiting anymore.");
}

export async function revertChange(accountId: string, id: string): Promise<void> {
  await ensureSchema();
  const [c] = await sql`SELECT * FROM insights_autopilot_changes WHERE id = ${id} AND account_id = ${accountId}`;
  if (!c) throw new Error("That change doesn't exist.");
  if (c.status !== "applied" && c.status !== "kept") throw new Error("Only live changes can be undone.");
  const site = await siteFor(accountId);
  if (!site?.writer && c.resource_type !== "site" && c.resource_type !== "snippet") throw new Error("Reconnect your store or website first.");
  const ctx = { accountId, site, store: site?.store ?? null } as Ctx;
  const note = await revertRow(ctx, c);
  await sql`UPDATE insights_autopilot_changes SET note = ${`Undone by hand. ${note}`} WHERE id = ${id} AND status = 'reverted'`;
}

// ---------- reading ----------

const num = (v: string | null) => (v === null ? null : Number(v));

function toRun(r: Row): AutopilotRun {
  return { id: r.id!, startedAt: r.started_at!, finishedAt: r.finished_at, trigger: r.trigger!, status: r.status!, summary: r.summary };
}

export async function autopilotHistory(accountId: string): Promise<{ changes: AutopilotChange[]; runs: AutopilotRun[] }> {
  await ensureSchema();
  const changes = await sql`SELECT * FROM insights_autopilot_changes WHERE account_id = ${accountId} ORDER BY id DESC LIMIT 100`;
  const runs = await sql`SELECT * FROM insights_autopilot_runs WHERE account_id = ${accountId} ORDER BY id DESC LIMIT 10`;
  return {
    changes: changes.map((c) => ({
      id: c.id!,
      createdAt: c.created_at!,
      pageUrl: c.page_url!,
      query: c.query!,
      field: c.field as ChangeField,
      before: c.field === "content" || c.field === "internal_link" || c.field === "link_fix" ? null : c.before_value,
      after: c.field === "link_fix" ? c.reason : (c.after_value?.replace(/<!--[\s\S]*?-->/g, "") ?? null),
      reason: c.reason,
      status: c.status as AutopilotChange["status"],
      baselinePosition: num(c.baseline_position),
      resultPosition: num(c.result_position),
      evaluatedAt: c.evaluated_at,
      note: c.note,
      targetId: c.target_id,
    })),
    runs: runs.map(toRun),
  };
}
