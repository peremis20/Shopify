import type { Connection } from "../connection";
import { ensureSchema, sql, type Row } from "../db";
import { resolveRange } from "../dates";
import { googleRequest } from "../google-auth";
import { findOpportunities } from "../seo-tools";
import type { Opportunity } from "../seo-types";
import { readAutopilotSettings, type AutopilotSettings } from "./settings";
import {
  getBody,
  listArticles,
  resolveResource,
  setBody,
  setImageAlt,
  setSeoField,
  type StoreResource,
} from "./shopify";
import type { AutopilotChange, AutopilotRun, ChangeField } from "./types";
import { writeImprovement, writeInternalLink } from "./writer";

/**
 * The SEO autopilot. Each run: measure older changes and undo the ones that
 * hurt, then improve one page (titles, descriptions, alt text, a new
 * section, an internal link), within the weekly page limit.
 */

const MEASURE_AFTER_DAYS = 28;
const REST_DAYS_PER_PAGE = 45;
const WORSE_BY_POSITIONS = 3;

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

async function logChange(c: {
  runId: string;
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
      (run_id, page_url, resource_type, resource_id, query, field, target_id, before_value, after_value, reason, status,
       baseline_position, baseline_clicks, baseline_impressions, note)
    VALUES (${c.runId}, ${c.pageUrl}, ${c.resourceType}, ${c.resourceId}, ${c.query}, ${c.field}, ${c.targetId ?? null},
      ${c.before}, ${c.after}, ${c.reason ?? null}, ${c.status},
      ${c.op?.position ?? null}, ${c.op?.clicks ?? null}, ${c.op?.impressions ?? null}, ${c.note ?? null})
    RETURNING id`;
  return row.id!;
}

const words = (s: string) =>
  new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));

// ---------- measuring ----------

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
async function measureOlderChanges(s: AutopilotSettings, conn: Connection): Promise<string[]> {
  const due = await sql`
    SELECT run_id, page_url, query, min(baseline_position) AS baseline_position, min(baseline_clicks) AS baseline_clicks
    FROM insights_autopilot_changes
    WHERE status = 'applied' AND created_at < now() - make_interval(days => ${MEASURE_AFTER_DAYS})
    GROUP BY run_id, page_url, query
    LIMIT 5`;
  const notes: string[] = [];
  for (const d of due) {
    const now = await positionFor(conn, d.query!, d.page_url!).catch(() => null);
    const baseline = Number(d.baseline_position);
    const baseClicks = Number(d.baseline_clicks ?? 0);
    const worse = now ? now.position > baseline + WORSE_BY_POSITIONS && now.clicks <= baseClicks : false;
    const changes = await sql`
      SELECT * FROM insights_autopilot_changes
      WHERE run_id = ${d.run_id} AND page_url = ${d.page_url} AND status = 'applied' ORDER BY id DESC`;
    for (const c of changes) {
      if (worse) {
        const note = await revertRow(s, c).catch((e) => `Undo failed: ${e.message}`);
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

function pickTarget(ops: Opportunity[], brand: string, rested: Set<string>): { op: Opportunity; related: string[] } | null {
  const usable = ops.filter((o) => {
    const path = new URL(o.page).pathname;
    return !(brand && o.query.includes(brand)) && !rested.has(o.page) && /^\/(blogs\/[^/]+\/[^/]+|pages|products|collections)\//.test(path + "/");
  });
  const op = usable[0];
  if (!op) return null;
  const related = ops.filter((o) => o.page === op.page && o.query !== op.query).map((o) => o.query);
  return { op, related };
}

async function improvePage(s: AutopilotSettings, runId: string, op: Opportunity, related: string[], page: StoreResource) {
  const done: string[] = [];
  const plan = await writeImprovement(s.anthropicKey!, page, op, related, s.allowContent);
  const base = { runId, pageUrl: op.page, resourceType: page.type, resourceId: page.id, query: op.query, reason: plan.reason, op };

  const apply = async (field: ChangeField, before: string | null, after: string, run: () => Promise<void>, targetId?: string) => {
    try {
      await run();
      await logChange({ ...base, field, before, after, status: "applied", targetId });
      done.push(field);
    } catch (err) {
      await logChange({ ...base, field, before, after, status: "failed", targetId, note: (err as Error).message });
    }
  };

  if (plan.metaTitle && plan.metaTitle !== page.metaTitle) {
    await apply("meta_title", page.metaTitle, plan.metaTitle, () => setSeoField(s, page.id, "title_tag", plan.metaTitle));
  }
  if (plan.metaDescription && plan.metaDescription !== page.metaDescription) {
    await apply("meta_description", page.metaDescription, plan.metaDescription, () =>
      setSeoField(s, page.id, "description_tag", plan.metaDescription)
    );
  }
  for (const a of plan.altTexts) {
    await apply("alt", null, a.alt, () => setImageAlt(s, a.imageId, a.alt), a.imageId);
  }
  if (plan.contentSectionHtml && (page.type === "article" || page.type === "page")) {
    const blockId = `${runId}-content`;
    const block = wrap(blockId, plan.contentSectionHtml);
    await apply("content", blockId, block, () => setBody(s, page.type as "article" | "page", page.id, `${page.body}\n${block}`));
  }

  // One internal link from the most related other blog post that doesn't link here yet.
  const path = new URL(op.page).pathname;
  const topic = words(`${op.query} ${page.title}`);
  const source = (await listArticles(s))
    .filter((a) => a.url !== path && !a.body.includes(path))
    .map((a) => ({ a, score: [...words(a.title)].filter((w) => topic.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)[0]?.a;
  if (source) {
    const sentence = await writeInternalLink(s.anthropicKey!, source, { path, query: op.query, title: page.title });
    if (sentence) {
      const blockId = `${runId}-link`;
      const block = wrap(blockId, sentence);
      await apply("internal_link", blockId, block, () => setBody(s, "article", source.id, `${source.body}\n${block}`), source.id);
    }
  }
  return done;
}

export interface RunResult {
  run: AutopilotRun | null;
  message: string;
}

/** One autopilot pass. Safe to call often: it improves at most one page per call. */
export async function runAutopilot(conn: Connection | null, trigger: "schedule" | "manual"): Promise<RunResult> {
  await ensureSchema();
  const s = await readAutopilotSettings();
  if (trigger === "schedule" && !s.enabled) return { run: null, message: "Autopilot is turned off." };
  if (!conn?.gscSiteUrl) return { run: null, message: "Connect Google and choose a Search Console property first." };
  if (!s.anthropicKey || !s.shopDomain || !s.shopifyClientId || !s.shopifyClientSecret) {
    return { run: null, message: "Add your Shopify app and Claude API key in Autopilot settings first." };
  }
  const running = await sql`SELECT id FROM insights_autopilot_runs WHERE status = 'running' AND started_at > now() - interval '30 minutes'`;
  if (running.length) return { run: null, message: "A run is already in progress." };

  const [runRow] = await sql`INSERT INTO insights_autopilot_runs (trigger) VALUES (${trigger}) RETURNING id`;
  const runId = runRow.id!;
  const summary: string[] = [];
  let status = "done";
  try {
    summary.push(...(await measureOlderChanges(s, conn)));

    const [{ pages }] = await sql`
      SELECT count(DISTINCT page_url) AS pages FROM insights_autopilot_changes
      WHERE status IN ('applied', 'kept') AND field <> 'internal_link' AND created_at > now() - interval '7 days'`;
    if (Number(pages) >= s.maxPagesPerWeek) {
      summary.push(`Weekly limit reached (${pages} of ${s.maxPagesPerWeek} pages).`);
    } else {
      const rested = new Set(
        (await sql`SELECT DISTINCT page_url FROM insights_autopilot_changes
          WHERE created_at > now() - make_interval(days => ${REST_DAYS_PER_PAGE})`).map((r) => r.page_url!)
      );
      const brand = new URL(conn.gscSiteUrl.replace(/^sc-domain:/, "https://")).hostname.replace(/^www\./, "").split(".")[0];
      let picked = pickTarget(await findOpportunities(conn, "28d"), brand, rested);
      let page: StoreResource | null = null;
      // Skip pages that don't map to an editable store item (up to a few tries).
      for (let tries = 0; picked && tries < 5; tries++) {
        page = await resolveResource(s, picked.op.page).catch(() => null);
        if (page) break;
        rested.add(picked.op.page);
        picked = pickTarget(await findOpportunities(conn, "28d"), brand, rested);
      }
      if (!picked || !page) {
        summary.push("No new opportunities to work on right now.");
      } else {
        const done = await improvePage(s, runId, picked.op, picked.related, page);
        summary.push(
          done.length
            ? `Improved ${new URL(picked.op.page).pathname} for “${picked.op.query}”: ${done.join(", ").replace(/_/g, " ")}.`
            : `Checked ${new URL(picked.op.page).pathname}; it already looked good, nothing changed.`
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
  return { run: toRun(run), message: summary.join(" ") };
}

// ---------- undo ----------

async function revertRow(s: AutopilotSettings, c: Row): Promise<string> {
  const field = c.field as ChangeField;
  if (field === "meta_title" || field === "meta_description") {
    await setSeoField(s, c.resource_id!, field === "meta_title" ? "title_tag" : "description_tag", c.before_value);
  } else if (field === "alt") {
    await setImageAlt(s, c.target_id!, c.before_value ?? "");
  } else {
    const type = field === "internal_link" ? "article" : (c.resource_type as "article" | "page");
    const id = field === "internal_link" ? c.target_id! : c.resource_id!;
    const body = await getBody(s, type, id);
    const restored = unwrap(c.before_value!, body);
    if (restored === null) {
      await sql`UPDATE insights_autopilot_changes SET status = 'skipped', note = 'The added section was already removed or edited by hand.' WHERE id = ${c.id}`;
      return "Already removed.";
    }
    await setBody(s, type, id, restored);
  }
  await sql`UPDATE insights_autopilot_changes SET status = 'reverted' WHERE id = ${c.id}`;
  return "Restored the previous version.";
}

export async function revertChange(id: string): Promise<void> {
  await ensureSchema();
  const [c] = await sql`SELECT * FROM insights_autopilot_changes WHERE id = ${id}`;
  if (!c) throw new Error("That change doesn't exist.");
  if (c.status !== "applied" && c.status !== "kept") throw new Error("Only live changes can be undone.");
  const s = await readAutopilotSettings();
  const note = await revertRow(s, c);
  await sql`UPDATE insights_autopilot_changes SET note = ${`Undone by hand. ${note}`} WHERE id = ${id} AND status = 'reverted'`;
}

// ---------- reading ----------

const num = (v: string | null) => (v === null ? null : Number(v));

function toRun(r: Row): AutopilotRun {
  return { id: r.id!, startedAt: r.started_at!, finishedAt: r.finished_at, trigger: r.trigger!, status: r.status!, summary: r.summary };
}

export async function autopilotHistory(): Promise<{ changes: AutopilotChange[]; runs: AutopilotRun[] }> {
  await ensureSchema();
  const changes = await sql`SELECT * FROM insights_autopilot_changes ORDER BY id DESC LIMIT 100`;
  const runs = await sql`SELECT * FROM insights_autopilot_runs ORDER BY id DESC LIMIT 10`;
  return {
    changes: changes.map((c) => ({
      id: c.id!,
      createdAt: c.created_at!,
      pageUrl: c.page_url!,
      query: c.query!,
      field: c.field as ChangeField,
      before: c.field === "content" || c.field === "internal_link" ? null : c.before_value,
      after: c.after_value?.replace(/<!--[\s\S]*?-->/g, "") ?? null,
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
