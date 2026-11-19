import crypto from "node:crypto";
import { sql } from "../db";
import { addFoundContact, knownContact, readCrmSettings, type FinderSettings } from "../crm";
import { clientListKnown, otherClient } from "./clients";
import { findContactEmail } from "./contact-finder";
import { report } from "./status";
import { closeNeed, postNote } from "./team";
import { spend, SpendingLimitReached } from "./usage";

/**
 * The Prospect finder: the start of the owner's sales pipeline. Each week it looks up the kinds of businesses the
 * owner sells to (their words, like "chiropractor") in the places they name, on Google Maps, and adds the real ones
 * it finds to the CRM as new contacts: name, address, phone and website as Google shows them, and the email the
 * business prints on its own website (never a guessed one). From there the CRM's own agents take over: a first email
 * is written for each one with an email, waiting for the owner's Send click; one without an email gets a call task
 * for the morning to do email. Nothing is sent by itself.
 *
 * It works for any business that sells to other businesses; the kinds and places come from the owner's settings.
 * Other DashPatrol customers' businesses are never added, and a business already in the CRM (archived ones
 * included) is never added twice.
 */

export interface Place {
  title: string;
  address: string;
  phone: string;
  website: string;
  category: string;
  rating: number | null;
  reviews: number | null;
  cid: string;
}

interface FinderState {
  week: string;
  added: number;
  emails: number;
  calls: number;
  lookups: number;
  /** Which kind and place search is next. */
  pair: number;
  /** Places already looked at, so a search that comes back the same doesn't cost a second look. */
  seen: string[];
  /** Searches in a row that had nothing new. */
  dry: number;
  /** No work before this time: the week's count is full, or every search was worked through. */
  idleUntil: string | null;
  /** The settings the counts above belong to; new kinds or places start the searches fresh. */
  setup: string;
}

const stateKey = (accountId: string) => `finder_state:${accountId}`;
/** Paid lookups a week at most, whatever happens: each one returns about 20 places. */
const MAX_LOOKUPS = 12;

/** The ISO week a date falls in, like "2026-W47". */
export function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - start.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Every kind and place pairing as a search, in a steady order. */
export function searchesFor(f: Pick<FinderSettings, "kinds" | "places">): string[] {
  const out: string[] = [];
  for (const place of f.places) for (const kind of f.kinds) out.push(`${kind} in ${place}`);
  return out;
}

/** A place from the search results, or null when it has no way to reach it or isn't a real listing. */
export function cleanPlace(raw: unknown): Place | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const s = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n) : "");
  const title = s(r.title, 120);
  const website = (() => {
    const w = s(r.website, 200);
    try {
      const u = new URL(w);
      return u.protocol === "https:" || u.protocol === "http:" ? `${u.protocol}//${u.hostname}${u.pathname === "/" ? "" : u.pathname}` : "";
    } catch {
      return "";
    }
  })();
  const phone = s(r.phoneNumber, 40);
  if (!title || (!website && phone.replace(/[^0-9]/g, "").length < 7)) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    title,
    address: s(r.address, 200),
    phone,
    website,
    category: s(r.category, 60),
    rating: num(r.rating),
    reviews: num(r.ratingCount),
    cid: s(r.cid, 40) || crypto.createHash("sha1").update(`${title}|${s(r.address, 200)}`).digest("hex").slice(0, 16),
  };
}

/** The places Google Maps lists for a search. A public fact, cached for a week for everyone. */
async function lookUp(apiKey: string, query: string): Promise<{ places: Place[]; paid: boolean }> {
  const key = `places:${crypto.createHash("sha256").update(`us|${query.toLowerCase()}`).digest("hex")}`;
  const [hit] = await sql`SELECT data FROM insights_report_cache WHERE cache_key = ${key} AND fetched_at > now() - interval '7 days'`.catch(() => [] as { data: unknown }[]);
  // The listings are cached as Google gives them (raw), and cleaned the same way on every read.
  if (hit?.data) {
    const v = typeof hit.data === "string" ? JSON.parse(hit.data) : hit.data;
    const raw = (v as { raw?: unknown[] }).raw;
    if (Array.isArray(raw)) return { places: raw.map(cleanPlace).filter((p): p is Place => Boolean(p)), paid: false };
  }
  await spend("search");
  const res = await fetch("https://google.serper.dev/places", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, gl: "us", hl: "en" }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { places?: unknown[]; message?: string };
  if (!res.ok) {
    if ([401, 402, 403, 429].includes(res.status) || res.status >= 500) await report("serper", false, `${res.status}: ${body?.message ?? "places lookup failed"}`);
    throw new Error(`The Google Maps lookup failed: ${body?.message ?? res.status}`);
  }
  await report("serper", true);
  const raw = Array.isArray(body.places) ? body.places.slice(0, 40) : [];
  const places = raw.map(cleanPlace).filter((p): p is Place => Boolean(p));
  await sql`INSERT INTO insights_report_cache (cache_key, data, fetched_at) VALUES (${key}, ${JSON.stringify({ raw })}::jsonb, now())
    ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`.catch(() => undefined);
  return { places, paid: true };
}

async function readState(accountId: string, week: string, setup: string): Promise<FinderState> {
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${stateKey(accountId)}`;
  const v = (() => {
    try {
      return row?.value ? (JSON.parse(row.value) as Partial<FinderState>) : {};
    } catch {
      return {};
    }
  })();
  const seen = Array.isArray(v.seen) ? v.seen.filter((x): x is string => typeof x === "string").slice(-3000) : [];
  // New kinds or places: the searches start from the first again and any rest ends.
  const same = v.setup === setup;
  const pair = same && Number.isInteger(v.pair) ? Number(v.pair) : 0;
  const dry = same ? Number(v.dry) || 0 : 0;
  const idleUntil = same && typeof v.idleUntil === "string" ? v.idleUntil : null;
  // A new week starts the counts again; what was seen is kept.
  if (v.week !== week) return { week, added: 0, emails: 0, calls: 0, lookups: 0, pair, seen, dry, idleUntil, setup };
  return { week, added: Number(v.added) || 0, emails: Number(v.emails) || 0, calls: Number(v.calls) || 0, lookups: Number(v.lookups) || 0, pair, seen, dry, idleUntil, setup };
}

/** Monday 00:00 UTC after a date: when a full week's count opens again. */
export function nextWeekStart(d = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + (8 - (t.getUTCDay() || 7)));
  return t.toISOString();
}

async function saveState(accountId: string, st: FinderState): Promise<void> {
  await sql`INSERT INTO insights_settings (key, value) VALUES (${stateKey(accountId)}, ${JSON.stringify({ ...st, seen: st.seen.slice(-3000) })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/**
 * Sites with the finder on that have work: not run in the last 50 minutes, and not resting (a full week, or every
 * search worked through). New settings end a rest, since the state then belongs to the old ones. Longest waiting first.
 */
export async function accountsDueForFinder(limit = 1): Promise<string[]> {
  const rows = await sql`SELECT substring(s.key from 14) AS account_id FROM insights_settings s
    LEFT JOIN insights_settings st ON st.key = 'finder_state:' || substring(s.key from 14)
    WHERE s.key LIKE 'crm_settings:%' AND s.value LIKE '%"finder":{"on":true%'
      AND (st.updated_at IS NULL OR st.updated_at < now() - interval '50 minutes')
      AND (st.value IS NULL OR st.updated_at < s.updated_at
        OR coalesce((st.value::jsonb ->> 'idleUntil')::timestamptz, '-infinity'::timestamptz) < now())
    ORDER BY st.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id)).filter((id) => /^\d{1,18}$/.test(id));
}

/**
 * One hour's work for a site: the next search, and as many of its new places as fit in the time given, each checked
 * against the CRM and the customer list, its website read for a printed email, and added. Returns a line for the log.
 */
export async function runFinder(accountId: string, apiKey: string | null, ourDomain: string | null, deadline: number): Promise<string | null> {
  const { finder } = await readCrmSettings(accountId);
  if (!finder.on || !finder.kinds.length || !finder.places.length) return null;
  const setup = crypto.createHash("sha1").update(JSON.stringify([finder.kinds, finder.places])).digest("hex").slice(0, 12);
  const st = await readState(accountId, isoWeek(), setup);
  const touch = () => saveState(accountId, st);
  // A platform key only the platform owner adds: the status board shows it (not the site owner's to do list).
  if (!apiKey) {
    await touch();
    await report("prospect-finder", false, "A search results key (serper.dev) is needed in Platform keys before new businesses can be found.");
    return "prospect finder waits: no search results key";
  }
  if (st.idleUntil && Date.parse(st.idleUntil) > Date.now()) {
    await touch();
    return null;
  }
  // Other customers' businesses are never added; if that list can't be read, wait rather than guess.
  if (!(await clientListKnown())) {
    await touch();
    return "prospect finder waits: the customer list couldn't be read";
  }
  const isClient = await otherClient(ourDomain ?? "");
  const searches = searchesFor(finder);
  const seen = new Set(st.seen);
  let addedNow = 0;
  let note: string | null = null;
  try {
    // Up to as many searches as there are, so a search with nothing new moves straight on to the next.
    for (let tries = 0; tries < searches.length && Date.now() < deadline - 20_000; tries++) {
      if (st.added >= finder.perWeek || st.lookups >= MAX_LOOKUPS) break;
      const query = searches[st.pair % searches.length];
      const { places, paid } = await lookUp(apiKey, query);
      if (paid) st.lookups++;
      const fresh = places.filter((p) => !seen.has(p.cid));
      st.dry = fresh.length ? 0 : st.dry + 1;
      for (const p of fresh) {
        if (Date.now() > deadline - 15_000 || st.added >= finder.perWeek) break;
        seen.add(p.cid);
        const host = p.website ? new URL(p.website).hostname.replace(/^www\./, "") : "";
        if (host && isClient(host)) continue;
        if (await knownContact(accountId, { phone: p.phone, website: p.website, company: p.title, address: p.address, email: null })) continue;
        const email = p.website && host ? await findContactEmail(p.website, host).catch(() => null) : null;
        // The same email already in the CRM (a lead, an import, a turned down one): not added twice.
        if (email && (await knownContact(accountId, { phone: "", website: "", company: "", address: "", email }))) continue;
        const made = await addFoundContact(accountId, {
          company: p.title,
          email,
          phone: p.phone,
          address: p.address,
          website: p.website,
          kind: p.category,
          note: `Found on Google Maps searching "${query}"${p.category ? `, listed as ${p.category}` : ""}${p.rating !== null ? `, rated ${p.rating}${p.reviews !== null ? ` from ${p.reviews} reviews` : ""}` : ""}.${email ? ` The email is the one printed on ${host}.` : " No email is printed on their website."}`,
        });
        if (!made) continue;
        st.added++;
        addedNow++;
        if (made.email) st.emails++;
        if (made.call) st.calls++;
      }
      // Done with this search once all its places are looked at; otherwise it carries on next hour.
      if (!places.every((p) => seen.has(p.cid))) break;
      st.pair = (st.pair + 1) % searches.length;
      // Every search came back with nothing new: rest four weeks instead of paying for the same lists again, and say so.
      if (st.dry >= searches.length) {
        st.idleUntil = new Date(Date.now() + 28 * 86_400_000).toISOString();
        st.dry = 0;
        await postNote(accountId, "Prospect finder", "needs", "Every search in your list has been worked through. Add more places or kinds of businesses under CRM, Settings, to find more.", { ref: "dry" });
        break;
      }
    }
    if (st.added >= finder.perWeek || st.lookups >= MAX_LOOKUPS) st.idleUntil = nextWeekStart();
    await report("prospect-finder", true);
  } catch (e) {
    // This month's search limit: a pause, not a fault; the count is kept and it carries on when the limit allows.
    if (!(e instanceof SpendingLimitReached)) throw e;
    st.idleUntil = nextWeekStart();
    note = "prospect finder waits: this month's search limit is used up";
  } finally {
    st.seen = [...seen];
    await touch().catch((e) => console.error(`finder state not saved: ${(e as Error).message}`));
  }
  if (addedNow) await closeNeed(accountId, "Prospect finder", "dry");
  if (st.added) {
    await postNote(
      accountId,
      "Prospect finder",
      "did",
      `Found ${st.added} new ${st.added === 1 ? "business" : "businesses"} this week (${finder.kinds.join(", ")} in ${finder.places.join("; ")}) and added them to the CRM: ${st.emails} with an email, whose first email is written for your Send click, and ${st.calls} to call.`,
      { ref: `week:${st.week}` },
    );
  }
  return note ?? (addedNow ? `prospect finder: ${addedNow} new ${addedNow === 1 ? "business" : "businesses"} added to the CRM` : null);
}
