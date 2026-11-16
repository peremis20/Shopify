import { sql } from "../db";
import { dayOf, historyEntry, normalStatus, outletEmailOk, ownerPatch, type CrmMetrics, type CrmStatus, type HistoryEntry, CRM_STATUSES } from "./press-crm";
import { dedupeKey, IMPORT_BATCH, IMPORT_CHUNK, IMPORT_MAX_ROWS as IMPORT_MAX, IMPORT_ORDER, outletFromEmail, NOT_LISTED, planImport, rowValues, type ImportRow, type Reject } from "./press-import";
import type { Journalist, Sql } from "./press";

/**
 * The journalist list for thousands of rows: paging, search, filters and sorting run in SQL on insights_press_items
 * (this account only), the metrics strip comes from one aggregate query, bulk actions are one statement each, and
 * imports go in batches of 500 rows per statement. Other customers' outlets are left out in SQL too (rows the owner
 * entered are theirs and always shown).
 */

export const PAGE_SIZE = 50;
export type SortKey = "recent" | "name" | "outlet" | "status" | "last";

export interface ListQuery {
  q: string | null;
  status: CrmStatus | null;
  tag: string | null;
  field: string | null;
  due: boolean;
  hasEmail: boolean;
  sort: SortKey;
  page: number;
}

const str = (v: unknown, max = 100) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Rows the list may show: the owner's own always; found ones only when not at another customer's outlet. */
export const isOtherFrom = (others: string[] | null) => (d: string) => {
  const h = (d ?? "").toLowerCase().replace(/^www\./, "");
  return others === null ? true : others.some((c) => h === c || h.endsWith(`.${c}`));
};

/**
 * A found journalist's email is shown only while it is on their outlet's own domain and not another customer's: an
 * outlet email or a Hunter email failing that is blanked, the same in the list and in every export.
 */
export function safeEmail<T extends Pick<Journalist, "source" | "email" | "emailIsOutlets" | "emailSource" | "outletDomain">>(j: T, others: string[] | null): T {
  if (j.source === "owner" || !j.email || !(j.emailIsOutlets || j.emailSource === "hunter")) return j;
  return outletEmailOk(j.email, j.outletDomain, isOtherFrom(others)) ? j : { ...j, email: null };
}

/** The list query from the address (or a POST body), every value checked. */
export function parseListQuery(src: URLSearchParams | Record<string, unknown> | null | undefined): ListQuery {
  const get = (k: string): unknown => (src instanceof URLSearchParams ? src.get(k) : src?.[k]);
  const status = get("status");
  const sort = get("sort");
  const page = Number(get("page"));
  const yes = (v: unknown) => v === true || v === "1" || v === "true";
  return {
    q: str(get("q")),
    status: CRM_STATUSES.includes(status as CrmStatus) ? (status as CrmStatus) : null,
    tag: str(get("tag"), 60),
    field: str(get("field"), 80),
    due: yes(get("due")),
    hasEmail: yes(get("hasEmail")),
    sort: (["recent", "name", "outlet", "status", "last"] as const).includes(sort as SortKey) ? (sort as SortKey) : "recent",
    page: Number.isInteger(page) && page >= 0 && page < 10_000 ? page : 0,
  };
}

/** A search phrase as a LIKE pattern: lower case, its own % and _ taken literally. */
export const likePattern = (q: string | null) => (q ? `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null);

const jsonOf = (v: unknown): Record<string, unknown> => (typeof v === "string" ? (JSON.parse(v) as Record<string, unknown>) : ((v ?? {}) as Record<string, unknown>));

export type ListedJournalist = Journalist & { status: CrmStatus; due: boolean; tags: string[]; history: HistoryEntry[] };

/** One row as shown: the agent's data, the owner's fields on top, the status in today's words. */
export function listed(data: Record<string, unknown>, owner: Record<string, unknown>, today: string): ListedJournalist {
  const OWNER = ["status", "statusAt", "lastContacted", "followUp", "notes", "pitchEdit", "tags", "history"];
  const clean = Object.fromEntries(Object.entries(data).filter(([k]) => !OWNER.includes(k)));
  const mine = Object.fromEntries(Object.entries(owner).filter(([k]) => OWNER.includes(k)));
  const j = { ...clean, ...mine } as unknown as ListedJournalist;
  j.status = normalStatus(owner.status);
  j.tags = Array.isArray(owner.tags) ? (owner.tags as unknown[]).map(String) : [];
  j.history = Array.isArray(owner.history) ? (owner.history as HistoryEntry[]).filter((h) => h && typeof h.at === "string").slice(-50) : [];
  j.due = !["replied", "covered", "not_interested"].includes(j.status) && typeof j.followUp === "string" && j.followUp <= today;
  return j;
}

/**
 * One page of the list. Every filter is a parameter, so the statement never changes shape; the total comes with the
 * rows. `limit` is raised only for an export.
 */
export async function listJournalists(
  accountId: string,
  query: ListQuery,
  /** Other customers' domains; null when the customer list can't be read: then only the owner's own rows show. */
  others: string[] | null,
  today: string,
  q: Sql = sql,
  limit = PAGE_SIZE,
): Promise<{ rows: ListedJournalist[]; total: number }> {
  const pattern = likePattern(query.q);
  const rows = await q`
    SELECT item_id, data, owner, count(*) OVER () AS total FROM insights_press_items
    WHERE account_id = ${accountId} AND kind = 'journalist'
      AND (data ->> 'source' = 'owner' OR (${others !== null}::boolean AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(others ?? [])}::jsonb) c
        WHERE coalesce(data ->> 'outletDomain', '') = c OR coalesce(data ->> 'outletDomain', '') LIKE '%.' || c)))
      AND (${pattern}::text IS NULL OR lower(data ->> 'name') LIKE ${pattern} OR lower(data ->> 'outlet') LIKE ${pattern} OR lower(coalesce(data ->> 'email', '')) LIKE ${pattern})
      AND (${query.status}::text IS NULL OR (CASE coalesce(owner ->> 'status', 'new') WHEN 'pitched' THEN 'emailed' WHEN 'dismissed' THEN 'not_interested' ELSE coalesce(owner ->> 'status', 'new') END) = ${query.status})
      AND (${query.tag}::text IS NULL OR coalesce(owner -> 'tags', '[]'::jsonb) @> jsonb_build_array(${query.tag}::text))
      AND (${query.field}::text IS NULL OR lower(coalesce(data ->> 'field', '')) = lower(${query.field}))
      AND (NOT ${query.due}::boolean OR (coalesce(owner ->> 'status', 'new') NOT IN ('replied', 'covered', 'not_interested', 'dismissed') AND owner ->> 'followUp' <= ${today}))
      AND (NOT ${query.hasEmail}::boolean OR coalesce(data ->> 'email', '') <> '')
    ORDER BY
      CASE WHEN ${query.sort} = 'name' THEN lower(data ->> 'name') END ASC,
      CASE WHEN ${query.sort} = 'outlet' THEN lower(data ->> 'outlet') END ASC,
      CASE WHEN ${query.sort} = 'status' THEN (CASE coalesce(owner ->> 'status', 'new') WHEN 'new' THEN 0 WHEN 'emailed' THEN 1 WHEN 'pitched' THEN 1 WHEN 'replied' THEN 2 WHEN 'covered' THEN 3 ELSE 4 END) END ASC,
      CASE WHEN ${query.sort} = 'last' THEN owner ->> 'lastContacted' END DESC NULLS LAST,
      found_at DESC, item_id
    LIMIT ${limit} OFFSET ${query.page * PAGE_SIZE}`;
  return { rows: rows.map((r) => safeEmail(listed(jsonOf(r.data), jsonOf(r.owner), today), others)), total: Number(rows[0]?.total ?? 0) };
}

/** The metrics strip from one aggregate query over this account's list (the same rules as crmMetrics in press-crm.ts). */
export async function listMetrics(accountId: string, others: string[] | null, now = Date.now(), q: Sql = sql): Promise<CrmMetrics> {
  const today = dayOf(now);
  const weekAgo = dayOf(now - 7 * 864e5);
  const [r] = await q`
    SELECT
      count(*) FILTER (WHERE st <> 'not_interested') AS total,
      count(*) FILTER (WHERE st <> 'not_interested' AND found_at > now() - interval '7 days') AS new_week,
      count(*) FILTER (WHERE lc > ${weekAgo} AND lc <= ${today}) AS emailed_week,
      count(*) FILTER (WHERE lc IS NOT NULL OR st IN ('emailed', 'replied', 'covered')) AS emailed_ever,
      count(*) FILTER (WHERE st IN ('replied', 'covered')) AS replies,
      count(*) FILTER (WHERE st = 'covered') AS coverage,
      count(*) FILTER (WHERE st NOT IN ('replied', 'covered', 'not_interested') AND fu <= ${today}) AS due,
      count(*) FILTER (WHERE st = 'new' AND (data ->> 'pitch' IS NOT NULL OR owner ->> 'pitchEdit' IS NOT NULL)) AS ready,
      count(*) AS found
    FROM (
      SELECT data, owner, found_at, owner ->> 'lastContacted' AS lc, owner ->> 'followUp' AS fu,
        CASE coalesce(owner ->> 'status', 'new') WHEN 'pitched' THEN 'emailed' WHEN 'dismissed' THEN 'not_interested' ELSE coalesce(owner ->> 'status', 'new') END AS st
      FROM insights_press_items
      WHERE account_id = ${accountId} AND kind = 'journalist'
        AND (data ->> 'source' = 'owner' OR (${others !== null}::boolean AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(others ?? [])}::jsonb) c
          WHERE coalesce(data ->> 'outletDomain', '') = c OR coalesce(data ->> 'outletDomain', '') LIKE '%.' || c)))
    ) t`;
  const n = (k: string) => Number(r?.[k] ?? 0);
  const emailedEver = n("emailed_ever");
  const replies = n("replies");
  return {
    total: n("total"),
    newThisWeek: n("new_week"),
    emailedThisWeek: n("emailed_week"),
    emailedEver,
    replies,
    replyRate: emailedEver > 0 ? Math.round((replies / emailedEver) * 100) : null,
    coverage: n("coverage"),
    followUpsToday: n("due"),
    readyToSend: n("ready"),
    funnel: { found: n("found"), emailed: emailedEver, replied: replies, covered: n("coverage") },
  };
}

/** The list tags and fields in use, for the filter dropdowns. */
export async function listFacets(accountId: string, q: Sql = sql): Promise<{ tags: string[]; fields: string[] }> {
  const rows = await q`
    SELECT 'tag' AS k, t AS v FROM insights_press_items, jsonb_array_elements_text(coalesce(owner -> 'tags', '[]'::jsonb)) t
      WHERE account_id = ${accountId} AND kind = 'journalist' GROUP BY t
    UNION ALL
    SELECT 'field' AS k, data ->> 'field' AS v FROM insights_press_items
      WHERE account_id = ${accountId} AND kind = 'journalist' AND coalesce(data ->> 'field', '') <> '' GROUP BY data ->> 'field'
    LIMIT 400`;
  const of = (k: string) => rows.filter((r) => r.k === k).map((r) => String(r.v)).sort((a, b) => a.localeCompare(b));
  return { tags: of("tag"), fields: of("field") };
}

// ---------- bulk actions ----------

export const BULK_MAX = 1000;
/** History lines kept per person: the newest. */
export const HISTORY_MAX = 50;
const ID = /^[0-9a-f]{16}$/;
export const cleanIds = (ids: unknown) => (Array.isArray(ids) ? [...new Set(ids.map(String).filter((i) => ID.test(i)))].slice(0, BULK_MAX) : []);
export const cleanTag = (t: unknown) => (typeof t === "string" ? t.replace(/\s+/g, " ").trim().slice(0, 60) : "");

export type BulkAction = { kind: "status"; status: unknown } | { kind: "tag"; tag: unknown } | { kind: "delete" };

/**
 * One statement for the selected rows of this account. Status and tags are owner fields; delete removes only rows the
 * owner entered or imported (found journalists are set to Not interested instead). Returns the rows changed.
 */
export async function bulkJournalists(accountId: string, ids: unknown, action: BulkAction, q: Sql = sql, now = Date.now()): Promise<number> {
  const list = cleanIds(ids);
  if (!list.length) return 0;
  const idsJson = JSON.stringify(list);
  if (action.kind === "status") {
    const r = ownerPatch({ kind: "status", status: action.status }, now);
    if (!r.ok) throw new Error(r.error);
    const entry = historyEntry(r.patch);
    const rows = await q`
      UPDATE insights_press_items
      SET owner = owner || ${JSON.stringify(r.patch)}::jsonb
        || jsonb_build_object('history', (
          SELECT coalesce(jsonb_agg(h.e ORDER BY h.n), '[]'::jsonb) FROM (
            SELECT e, n FROM jsonb_array_elements(coalesce(owner -> 'history', '[]'::jsonb) || ${JSON.stringify(entry ? [entry] : [])}::jsonb) WITH ORDINALITY x(e, n)
            ORDER BY n DESC LIMIT ${HISTORY_MAX}) h))
      WHERE account_id = ${accountId} AND kind = 'journalist' AND item_id IN (SELECT jsonb_array_elements_text(${idsJson}::jsonb))
      RETURNING item_id`;
    return rows.length;
  }
  if (action.kind === "tag") {
    const tag = cleanTag(action.tag);
    if (!tag) throw new Error("Type a list name.");
    const rows = await q`
      UPDATE insights_press_items SET owner = owner || jsonb_build_object('tags',
        CASE WHEN coalesce(owner -> 'tags', '[]'::jsonb) @> jsonb_build_array(${tag}::text) THEN coalesce(owner -> 'tags', '[]'::jsonb)
             ELSE coalesce(owner -> 'tags', '[]'::jsonb) || jsonb_build_array(${tag}::text) END)
      WHERE account_id = ${accountId} AND kind = 'journalist' AND item_id IN (SELECT jsonb_array_elements_text(${idsJson}::jsonb))
      RETURNING item_id`;
    return rows.length;
  }
  const rows = await q`
    DELETE FROM insights_press_items
    WHERE account_id = ${accountId} AND kind = 'journalist' AND data ->> 'source' = 'owner' AND item_id IN (SELECT jsonb_array_elements_text(${idsJson}::jsonb))
    RETURNING item_id`;
  return rows.length;
}

/** The selected rows, for an export or the compose panel: the same other customers rule and email check as the list. */
export async function journalistsByIds(accountId: string, ids: unknown, others: string[] | null, today: string, q: Sql = sql): Promise<ListedJournalist[]> {
  const list = cleanIds(ids);
  if (!list.length) return [];
  const rows = await q`
    SELECT data, owner FROM insights_press_items
    WHERE account_id = ${accountId} AND kind = 'journalist' AND item_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(list)}::jsonb))
      AND (data ->> 'source' = 'owner' OR (${others !== null}::boolean AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(others ?? [])}::jsonb) c
        WHERE coalesce(data ->> 'outletDomain', '') = c OR coalesce(data ->> 'outletDomain', '') LIKE '%.' || c)))`;
  return rows.map((r) => safeEmail(listed(jsonOf(r.data), jsonOf(r.owner), today), others));
}

// ---------- import ----------

export { IMPORT_ORDER, rowValues } from "./press-import";

/** People one account's list may hold. */
export const JOURNALIST_CAP = 50_000;
export const CAP_MESSAGE = `Your list holds up to ${JOURNALIST_CAP.toLocaleString("en-US")} people. Delete some before adding more.`;

/** Room left on this account's list. */
export async function listRoom(accountId: string, q: Sql = sql): Promise<number> {
  const [r] = await q`SELECT count(*) AS n FROM insights_press_items WHERE account_id = ${accountId} AND kind = 'journalist'`;
  return Math.max(0, JOURNALIST_CAP - Number(r?.n ?? 0));
}

/** An imported row as stored: the owner's data, with their notes and list tag as owner fields. */
export function importItem(r: ImportRow, tag: string | null, itemIdOf: (key: string) => string, now = new Date().toISOString()) {
  const domain = outletFromEmail(r.email);
  let articleHost = "";
  try {
    articleHost = r.articleUrl ? new URL(r.articleUrl).hostname.replace(/^www\./, "") : "";
  } catch {
    articleHost = "";
  }
  const id = itemIdOf(`owner:${dedupeKey(r)}`);
  return {
    id,
    data: {
      id,
      source: "owner",
      name: r.name,
      jobTitle: r.jobTitle,
      outlet: r.outlet,
      outletDomain: domain && domain !== NOT_LISTED ? domain : articleHost,
      email: r.email,
      emailIsOutlets: false,
      ...(r.email ? { emailSource: "owner" } : {}),
      phone: r.phone,
      phoneIsOutlets: false,
      location: r.location,
      field: r.field,
      profileUrl: r.profileUrl,
      articleUrl: r.articleUrl ?? "",
      articleTitle: r.articleTitle ?? "",
      date: null,
      topic: "",
      contactPage: null,
      foundAt: now,
    },
    owner: (() => {
      const tags = [...new Set([...(r.tags ?? []), ...(tag ? [tag] : [])])];
      return { ...(r.notes ? { notes: r.notes } : {}), ...(tags.length ? { tags } : {}) };
    })(),
  };
}

/**
 * Inserts up to 500 rows in one statement. Duplicates are left out in SQL: a row whose email (any case), or without an
 * email whose name and outlet, is already on the list; the same person twice at once meets the same id. The list's
 * cap is checked in the statement too. Returns the rows added.
 */
export async function insertBatch(accountId: string, items: { id: string; data: Record<string, unknown>; owner: Record<string, unknown> }[], q: Sql = sql): Promise<number> {
  if (!items.length) return 0;
  if (items.length > IMPORT_BATCH) throw new Error(`At most ${IMPORT_BATCH} rows per statement.`);
  const rows = await q`
    INSERT INTO insights_press_items (account_id, kind, item_id, data, owner)
    SELECT ${accountId}, 'journalist', x.v ->> 'id', x.v -> 'data', x.v -> 'owner'
    FROM jsonb_array_elements(${JSON.stringify(items)}::jsonb) WITH ORDINALITY x(v, n)
    WHERE x.n <= ${JOURNALIST_CAP} - (SELECT count(*) FROM insights_press_items c WHERE c.account_id = ${accountId} AND c.kind = 'journalist')
      AND NOT EXISTS (
        SELECT 1 FROM insights_press_items p WHERE p.account_id = ${accountId} AND p.kind = 'journalist' AND (
          (coalesce(x.v -> 'data' ->> 'email', '') <> '' AND lower(p.data ->> 'email') = lower(x.v -> 'data' ->> 'email'))
          OR (coalesce(x.v -> 'data' ->> 'email', '') = ''
            AND regexp_replace(lower(trim(p.data ->> 'name')), '[[:space:]]+', ' ', 'g') = regexp_replace(lower(trim(x.v -> 'data' ->> 'name')), '[[:space:]]+', ' ', 'g')
            AND regexp_replace(lower(trim(p.data ->> 'outlet')), '[[:space:]]+', ' ', 'g') = regexp_replace(lower(trim(x.v -> 'data' ->> 'outlet')), '[[:space:]]+', ' ', 'g'))))
    ON CONFLICT (account_id, kind, item_id) DO NOTHING
    RETURNING item_id`;
  return rows.length;
}

/**
 * One request's worth of an import (up to 2,000 rows from the browser): checked again with the same rules, duplicates
 * against the list and within the rows left out, then added 500 rows per statement.
 */
export async function importJournalists(
  accountId: string,
  valueRows: unknown,
  tagIn: unknown,
  itemIdOf: (key: string) => string,
  q: Sql = sql,
): Promise<{ added: number; duplicates: number; rejects: Reject[] }> {
  if (!Array.isArray(valueRows)) throw new Error("Nothing to import.");
  if (valueRows.length > IMPORT_CHUNK) throw new Error(`Send at most ${IMPORT_CHUNK} rows at a time.`);
  const rows = valueRows.map((r) => (Array.isArray(r) ? r.slice(0, IMPORT_ORDER.length).map((v) => (v === null || v === undefined ? "" : String(v))) : []));
  const tag = cleanTag(tagIn) || null;
  // Checked and deduplicated within these rows here; against the list in SQL, as each batch goes in.
  const plan = planImport(rows, IMPORT_ORDER, new Set(), 1);
  const room = await listRoom(accountId, q);
  if (plan.add.length && room <= 0) throw new Error(CAP_MESSAGE);
  const fits = plan.add.slice(0, room);
  const over = plan.add.slice(room);
  const items = fits.map((r) => importItem(r, tag, itemIdOf));
  let added = 0;
  for (let i = 0; i < items.length; i += IMPORT_BATCH) added += await insertBatch(accountId, items.slice(i, i + IMPORT_BATCH), q);
  // Rows not added were already on the list (or met another import of the same person at the same moment).
  const rejects = [...plan.rejects, ...over.map((r) => ({ line: 0, reason: CAP_MESSAGE, values: rowValues(r) }))];
  return { added, duplicates: plan.duplicates + (items.length - added), rejects };
}

/** How many of these dedupe keys the list already has (for the preview's duplicate count), counted in SQL. */
export async function countExisting(accountId: string, keys: unknown, q: Sql = sql): Promise<number> {
  if (!Array.isArray(keys) || !keys.length) return 0;
  const list = [...new Set(keys.map(String))].filter((k) => /^[en]:/.test(k)).slice(0, IMPORT_MAX);
  const [r] = await q`
    SELECT count(*) AS n FROM jsonb_array_elements_text(${JSON.stringify(list)}::jsonb) k
    WHERE EXISTS (
      SELECT 1 FROM insights_press_items p WHERE p.account_id = ${accountId} AND p.kind = 'journalist' AND (
        (left(k, 2) = 'e:' AND lower(p.data ->> 'email') = substr(k, 3))
        OR (left(k, 2) = 'n:' AND regexp_replace(lower(trim(p.data ->> 'name')), '[[:space:]]+', ' ', 'g') || '|' || regexp_replace(lower(trim(p.data ->> 'outlet')), '[[:space:]]+', ' ', 'g') = substr(k, 3))))`;
  return Number(r?.n ?? 0);
}

// ---------- moving "Location: ...; Field: ..." out of notes ----------

/**
 * Notes written before location and field had their own place ("Location: Austin; Field: Health; rest"): the two
 * values, and the notes without them. Null when the notes hold neither.
 */
export function splitNotes(notes: string | null | undefined): { location: string | null; field: string | null; rest: string | null } | null {
  if (!notes || !/\b(?:location|field)\s*:/i.test(notes)) return null;
  let location: string | null = null;
  let field: string | null = null;
  const rest = notes
    .replace(/(?:^|(?<=[;\n|]))\s*(location|field)\s*:\s*([^;\n|]*)/gi, (_m, k: string, v: string) => {
      const val = v.trim() || null;
      if (k.toLowerCase() === "location") location ??= val;
      else field ??= val;
      return "";
    })
    .split(/[;\n|]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join("; ");
  if (location === null && field === null) return null;
  return { location, field, rest: rest || null };
}

/** The rows that may hold the old notes (the same rule as splitNotes: the key at the start or after ; | or a new line). */
const OLD_NOTES = "(^|[;|\n])[[:space:]]*(location|field)[[:space:]]*:";

/**
 * The one time move for rows the owner entered before: location and field go to their own fields, the notes keep the
 * rest. Each row is marked checked (notesMoved) in the same statement, so it is never selected again; a row whose
 * notes changed meanwhile is left for the next read. Runs through every such row, 500 at a time.
 */
export async function migrateOwnerNotes(accountId: string, q: Sql = sql, maxBatches = 200): Promise<number> {
  let moved = 0;
  const seen = new Set<string>();
  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = await q`
      SELECT item_id, owner ->> 'notes' AS notes, data ->> 'location' AS location, data ->> 'field' AS field FROM insights_press_items
      WHERE account_id = ${accountId} AND kind = 'journalist' AND data ->> 'source' = 'owner' AND data ->> 'notesMoved' IS NULL
        AND owner ->> 'notes' ~* ${OLD_NOTES}
      ORDER BY item_id LIMIT 500`;
    const fresh = rows.filter((r) => !seen.has(String(r.item_id)));
    if (!fresh.length) break;
    for (const r of fresh) {
      seen.add(String(r.item_id));
      const split = splitNotes(r.notes ? String(r.notes) : null);
      // Location and field the owner already set are never overwritten: such a row is only marked checked.
      const canMove = Boolean(split) && r.location === null && r.field === null;
      const done = await q`
        UPDATE insights_press_items
        SET data = data || ${JSON.stringify(canMove ? { notesMoved: true, location: split!.location, field: split!.field } : { notesMoved: true })}::jsonb,
            owner = owner || ${JSON.stringify(canMove ? { notes: split!.rest } : {})}::jsonb
        WHERE account_id = ${accountId} AND kind = 'journalist' AND item_id = ${String(r.item_id)}
          AND owner ->> 'notes' = ${String(r.notes)} AND data ->> 'notesMoved' IS NULL
        RETURNING item_id`;
      if (canMove && done.length) moved++;
    }
    if (rows.length < 500) break;
  }
  return moved;
}

// ---------- the owner's email templates ----------

export interface Template {
  id: string;
  name: string;
  subject: string;
  body: string;
}

/** Templates one account may keep. */
export const TEMPLATE_MAX = 30;

export async function listTemplates(accountId: string, q: Sql = sql): Promise<Template[]> {
  const rows = await q`SELECT id, name, subject, body FROM insights_press_templates WHERE account_id = ${accountId} ORDER BY lower(name) LIMIT ${TEMPLATE_MAX}`;
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), subject: String(r.subject), body: String(r.body) }));
}

/** A template checked: a name, a subject and a body, within their lengths. */
export function cleanTemplate(t: { name?: unknown; subject?: unknown; body?: unknown }): { ok: true; value: Omit<Template, "id"> } | { ok: false; error: string } {
  const name = typeof t.name === "string" ? t.name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  const subject = typeof t.subject === "string" ? t.subject.trim().slice(0, 200) : "";
  const body = typeof t.body === "string" ? t.body.trim().slice(0, 5000) : "";
  if (!name) return { ok: false, error: "Give the template a name." };
  if (!subject || !body) return { ok: false, error: "The subject and the email can't be empty." };
  return { ok: true, value: { name, subject, body } };
}

/** Saves a new template (within the account's thirty) or changes one of the account's own. Returns its id. */
export async function saveTemplate(accountId: string, t: { id?: unknown; name?: unknown; subject?: unknown; body?: unknown }, newId: () => string, q: Sql = sql): Promise<string> {
  const c = cleanTemplate(t);
  if (!c.ok) throw new Error(c.error);
  const id = typeof t.id === "string" && /^[0-9a-f]{16}$/.test(t.id) ? t.id : null;
  if (id) {
    const rows = await q`
      UPDATE insights_press_templates SET name = ${c.value.name}, subject = ${c.value.subject}, body = ${c.value.body}, updated_at = now()
      WHERE account_id = ${accountId} AND id = ${id} RETURNING id`;
    if (!rows.length) throw new Error("That template isn't there anymore.");
    return id;
  }
  const fresh = newId();
  const rows = await q`
    INSERT INTO insights_press_templates (account_id, id, name, subject, body)
    SELECT ${accountId}, ${fresh}, ${c.value.name}, ${c.value.subject}, ${c.value.body}
    WHERE (SELECT count(*) FROM insights_press_templates WHERE account_id = ${accountId}) < ${TEMPLATE_MAX}
    RETURNING id`;
  if (!rows.length) throw new Error(`Keep up to ${TEMPLATE_MAX} templates. Delete one first.`);
  return fresh;
}

export async function deleteTemplate(accountId: string, id: unknown, q: Sql = sql): Promise<void> {
  if (typeof id !== "string") return;
  await q`DELETE FROM insights_press_templates WHERE account_id = ${accountId} AND id = ${id}`;
}
