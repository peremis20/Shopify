import crypto from "crypto";
import { ensureSchema, sql } from "./db";
import { parseCsv } from "./csv";
import { tokenSecret } from "./oauth-client";
import { decrypt, encrypt } from "./secrets";
import { healthRulesApply, readProfile, siteBrief } from "./profile";
import { claimProblem, noDashes } from "./social-agent";
import { shopifyGql, type StoreAccess } from "./autopilot/shopify";
import { siteFor } from "./autopilot/site-source";
import { aiProvider, readPlatformSettings } from "./autopilot/settings";
import { hasAiTell, numbersKnown, secondCheck, writeNewsletterDraft } from "./autopilot/writer";
import { report } from "./autopilot/status";
import { closeNeed, postNote } from "./autopilot/team";
import { salesFor } from "./autopilot/shopify-sales";
import { isSabbath } from "./autopilot/sabbath";

/**
 * The Newsletter: each site emails its own subscribers through the site owner's OWN Resend account (never the
 * platform's key). The owner writes a campaign (or has one drafted from their latest article and checked by a second
 * AI), sends a test to themselves and clicks approve; only then does the hourly run send it, in batches, within the
 * site's daily cap. Every email carries an unsubscribe link (one click, RFC 8058) and the business's postal address.
 *
 * Each site keeps its own subscribers only: every query is keyed by account. Nobody who unsubscribed, bounced or
 * complained is ever subscribed again by an import.
 */

export const DEFAULT_DAILY_CAP = 500;
export const MAX_DAILY_CAP = 50_000;
/** Resend's batch endpoint takes up to 100 emails a call. */
export const BATCH_SIZE = 100;
/** At most this many emails per site per hourly run, so one big list never holds up the other agents. */
export const PER_RUN = 2_000;
export const IMPORT_MAX = 20_000;

export type SubscriberStatus = "subscribed" | "unsubscribed" | "bounced" | "complained";
export type SubscriberSource = "shopify" | "import" | "signup" | "manual";
export type CampaignStatus = "draft" | "approved" | "sending" | "sent" | "failed" | "stopped";

// ---------- pure parts (tested in tests/newsletter.test.ts) ----------

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** One email address, trimmed and lowercased, or null when it isn't one. */
export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().replace(/^mailto:/i, "").replace(/^<|>$/g, "").trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) return null;
  const [local] = e.split("@");
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return e;
}

const cut = (v: unknown, n: number) =>
  typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, n) : "";
const oneLine = (v: unknown, n: number) => cut(v, n * 2).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, n);
const headerKey = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

export interface ListRow {
  email: string;
  name: string;
}

/** A list split by semicolons reads like one split by commas; a semicolon inside double quotes (a name) stays. */
export function semicolonsToCommas(text: string): string {
  let out = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    out += ch === ";" && !quoted ? "," : ch;
  }
  return out;
}

/**
 * Reads a pasted list or a CSV file: with a header row, the email column (and a name, or first and last name) is found
 * by its name; without one, every cell holding an email address counts ("Ana Lopez <ana@x.com>" keeps the name).
 * The same address twice is kept once.
 */
export function parseSubscriberList(text: string): { rows: ListRow[]; invalid: number; duplicates: number } {
  const table = parseCsv(semicolonsToCommas(text));
  const rows: ListRow[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  let duplicates = 0;
  const add = (email: string | null, name: string) => {
    if (!email) {
      invalid++;
      return;
    }
    if (seen.has(email)) {
      duplicates++;
      return;
    }
    seen.add(email);
    rows.push({ email, name: oneLine(name, 120) });
  };
  if (!table.length) return { rows, invalid, duplicates };
  const head = table[0].map(headerKey);
  const emailCol = head.findIndex((h) => ["email", "emailaddress", "mail", "subscriberemail", "customeremail"].includes(h));
  if (emailCol >= 0) {
    const nameCol = head.findIndex((h) => ["name", "fullname", "subscribername", "customername"].includes(h));
    const firstCol = head.findIndex((h) => ["firstname", "first", "givenname"].includes(h));
    const lastCol = head.findIndex((h) => ["lastname", "last", "surname", "familyname"].includes(h));
    for (const r of table.slice(1)) {
      const name = nameCol >= 0 ? r[nameCol] ?? "" : [firstCol >= 0 ? r[firstCol] : "", lastCol >= 0 ? r[lastCol] : ""].filter(Boolean).join(" ");
      add(normalizeEmail(r[emailCol] ?? ""), name ?? "");
    }
    return { rows, invalid, duplicates };
  }
  for (const r of table) {
    for (const cell of r) {
      const c = cell.trim();
      if (!c) continue;
      const angled = c.match(/^(.*?)<([^>]+)>\s*$/);
      if (angled) add(normalizeEmail(angled[2]), angled[1].replace(/["']/g, "").trim());
      else if (c.includes("@")) add(normalizeEmail(c), "");
      else if (r.length === 1) invalid++;
    }
  }
  return { rows, invalid, duplicates };
}

/**
 * What an import does with each row: only addresses not on the list yet are added. Anyone already on it is left
 * exactly as they are, so someone who unsubscribed, bounced or complained is never subscribed again.
 */
export function mergeImport(existing: Map<string, SubscriberStatus>, rows: ListRow[]): { add: ListRow[]; already: number; blocked: number } {
  const add: ListRow[] = [];
  let already = 0;
  let blocked = 0;
  for (const r of rows) {
    const cur = existing.get(r.email);
    if (!cur) add.push(r);
    else if (cur === "subscribed") already++;
    else blocked++;
  }
  return { add, already, blocked };
}

/** A random, unguessable unsubscribe token (32 bytes, base64url). */
export const newToken = () => crypto.randomBytes(32).toString("base64url");
/** Only a token in the exact shape newToken makes is ever looked up. */
export const validToken = (t: unknown): t is string => typeof t === "string" && /^[A-Za-z0-9_-]{43}$/.test(t);

/** The unsubscribe link; with the campaign's id, so an unsubscribe is counted for the email it came from. */
export const unsubscribeUrl = (origin: string, token: string, campaignId?: string) =>
  `${origin.replace(/\/+$/, "")}/api/newsletter/unsubscribe?t=${encodeURIComponent(token)}${campaignId && /^\d{1,18}$/.test(campaignId) ? `&c=${campaignId}` : ""}`;

/** The campaign's name in links (utm_campaign): its id and the first words of its subject, plain letters and digits. */
export function campaignSlug(id: string, subject: string): string {
  const words = subject.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 5).join("_");
  return `${id}${words ? `_${words}` : ""}`.slice(0, 50);
}

/**
 * Adds the newsletter's UTM tags to a link, only when it points at the site's own domain (www or not). Tags the owner
 * already set are kept; other sites' links are never changed.
 */
export function withUtm(url: string, siteDomain: string | null | undefined, slug: string): string {
  const site = (siteDomain ?? "").toLowerCase().replace(/^www\./, "").trim();
  if (!site) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (!/^https?:$/.test(u.protocol) || u.hostname.toLowerCase().replace(/^www\./, "") !== site) return url;
  for (const [k, v] of [["utm_source", "newsletter"], ["utm_medium", "email"], ["utm_campaign", slug]] as const) {
    if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  }
  return u.toString();
}

export const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A link's address: only https (or http) addresses, never javascript: or data:. */
const safeHref = (u: string) => (/^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : null);

type LinkFn = (url: string) => string;
const same: LinkFn = (u) => u;

function inlineHtml(text: string, link: LinkFn = same): string {
  // Links and bold are found in the raw text, then every piece is escaped, so nothing the owner types becomes markup.
  const out: string[] = [];
  const re = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"')]+)|\*\*([^*\n]{1,300})\*\*/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(escapeHtml(text.slice(last, m.index)));
    if (m[1] && safeHref(m[2])) out.push(`<a href="${escapeHtml(link(m[2]))}" style="color:#0F5130">${escapeHtml(m[1])}</a>`);
    else if (m[3] && safeHref(m[3])) out.push(`<a href="${escapeHtml(link(m[3]))}" style="color:#0F5130">${escapeHtml(m[3])}</a>`);
    else if (m[4]) out.push(`<strong>${escapeHtml(m[4])}</strong>`);
    else out.push(escapeHtml(m[0]));
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(escapeHtml(text.slice(last)));
  return out.join("");
}

const inlineText = (text: string, link: LinkFn = same) =>
  text
    .replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"')]+)/g, (_m, words: string | undefined, href: string | undefined, bare: string | undefined) =>
      words && href ? `${words} (${link(href)})` : link(bare ?? ""))
    .replace(/\*\*([^*\n]{1,300})\*\*/g, "$1");

/**
 * The owner's simple format, as safe HTML and as plain text: paragraphs split by a blank line, "# " starts a heading,
 * "* " starts a list item, [words](https://link), bare https links and **bold**. Nothing else is markup; any HTML the
 * owner types is shown as text.
 */
export function renderBody(body: string, link: LinkFn = same): { html: string; text: string } {
  const blocks = body.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const html: string[] = [];
  const text: string[] = [];
  for (const b of blocks) {
    const lines = b.split("\n").map((l) => l.trim());
    if (lines.length === 1 && /^#{1,3}\s+/.test(lines[0])) {
      const h = lines[0].replace(/^#{1,3}\s+/, "");
      html.push(`<h2 style="font-size:20px;margin:24px 0 8px">${inlineHtml(h, link)}</h2>`);
      text.push(inlineText(h, link).toUpperCase());
    } else if (lines.every((l) => /^[*-]\s+/.test(l))) {
      const items = lines.map((l) => l.replace(/^[*-]\s+/, ""));
      html.push(`<ul style="margin:0 0 16px;padding-left:22px">${items.map((i) => `<li style="margin:4px 0">${inlineHtml(i, link)}</li>`).join("")}</ul>`);
      text.push(items.map((i) => `* ${inlineText(i, link)}`).join("\n"));
    } else {
      html.push(`<p style="margin:0 0 16px">${lines.map((l) => inlineHtml(l, link)).join("<br>")}</p>`);
      text.push(lines.map((l) => inlineText(l, link)).join("\n"));
    }
  }
  return { html: html.join("\n"), text: text.join("\n\n") };
}

/** The footer every email carries: why they get it, the unsubscribe link, and the business's postal address. */
export function footer(p: { brand: string; postalAddress: string; unsubscribe: string }): { html: string; text: string } {
  const why = `You get this email because you signed up for emails from ${p.brand}.`;
  const addr = p.postalAddress.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  return {
    text: `${why}\nUnsubscribe: ${p.unsubscribe}\n${addr.join("\n")}`,
    html: `<hr style="border:none;border-top:1px solid #e5e1d8;margin:28px 0 16px"><p style="font-size:12px;color:#6b675f;margin:0 0 6px">${escapeHtml(why)} <a href="${escapeHtml(p.unsubscribe)}" style="color:#6b675f">Unsubscribe</a></p><p style="font-size:12px;color:#6b675f;margin:0">${addr.map(escapeHtml).join("<br>")}</p>`,
  };
}

/** The From line: the name quoted and stripped of anything that could break the header. */
export function fromHeader(name: string, address: string): string {
  const n = name.replace(/["\\<>\r\n]/g, "").trim();
  return n ? `"${n}" <${address}>` : address;
}

/** Whether a from address is on a subdomain (news@news.example.com), which keeps newsletter mail apart from the main domain's. */
export function onSubdomain(address: string): boolean {
  const host = address.split("@")[1] ?? "";
  const labels = host.split(".").filter(Boolean);
  // example.com and example.co.uk are both the main domain; one more label is a subdomain.
  const secondLevel = labels.length >= 3 && /^(co|com|org|net|gov|ac|edu)$/.test(labels[labels.length - 2]) && labels[labels.length - 1].length === 2;
  return labels.length >= (secondLevel ? 4 : 3);
}

export interface EmailParts {
  from: string;
  replyTo: string | null;
  to: string;
  subject: string;
  preview: string;
  body: string;
  brand: string;
  postalAddress: string;
  unsubscribe: string;
  /** UTM tags for links to the site's own domain. */
  utm?: { domain: string | null; slug: string } | null;
}

/**
 * One email as Resend takes it, with the one click unsubscribe headers (RFC 8058) and the footer. No tags: older
 * Resend docs listed tags as not supported in batch sends, and a rejection there would refuse every batch.
 */
export function buildEmail(p: EmailParts): Record<string, unknown> {
  const utm = p.utm;
  const content = renderBody(p.body, utm ? (u) => withUtm(u, utm.domain, utm.slug) : same);
  const foot = footer({ brand: p.brand, postalAddress: p.postalAddress, unsubscribe: p.unsubscribe });
  const preheader = p.preview
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(p.preview)}</div>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f7f3ec"><div style="max-width:600px;margin:0 auto;padding:24px 20px;background:#ffffff;font:16px/1.6 Georgia,serif;color:#2b2a27">${preheader}${content.html}${foot.html}</div></body></html>`;
  return {
    from: p.from,
    to: [p.to],
    subject: p.subject.replace(/[\r\n]+/g, " ").trim(),
    html,
    text: `${content.text}\n\n${foot.text}`,
    ...(p.replyTo ? { reply_to: p.replyTo } : {}),
    headers: {
      "List-Unsubscribe": `<${p.unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/** How many more emails the site may send today. */
export const allowance = (cap: number, sentToday: number) => Math.max(0, Math.floor(cap) - Math.max(0, Math.floor(sentToday)));

/** The batch sizes for sending `waiting` emails within today's allowance and this run's limit, BATCH_SIZE at most each. */
export function batchSizes(waiting: number, left: number, perRun = PER_RUN, size = BATCH_SIZE): number[] {
  let n = Math.max(0, Math.min(waiting, left, perRun));
  const out: number[] = [];
  while (n > 0) {
    const b = Math.min(size, n);
    out.push(b);
    n -= b;
  }
  return out;
}

export function chunk<T>(items: T[], size = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * What a failed Resend call means.
 * "fatal": Resend refused it (bad key, domain not verified), so nothing was sent and the campaign waits for the owner.
 * "invalid": Resend refused the content of the request (422); a batch is then tried one email at a time.
 * "retry": nothing was sent (a rate limit, or an idempotency clash), so the claims are dropped and made again later.
 * "unknown": no clear answer (a server error or no answer); those emails may have gone out, so exactly those are sent
 * again with the same idempotency key (Resend then never sends twice) within 24 hours.
 */
export function failureKind(status: number | null): "fatal" | "invalid" | "retry" | "unknown" {
  if (status === 429 || status === 409) return "retry";
  if (status === 422) return "invalid";
  if (status !== null && status >= 400 && status < 500) return "fatal";
  return "unknown";
}

/**
 * Whether a refusal of one email names the recipient (the `to` field), so only that person is skipped. A refusal about
 * the sender (`from`, `reply_to`) is the owner's setup, never one subscriber's address.
 */
export function addressProblem(body: unknown, text = ""): boolean {
  const b = (body ?? {}) as { name?: string; message?: string };
  const words = `${b.name ?? ""} ${b.message ?? ""} ${text}`;
  if (/\bfrom\b|reply_?to|reply to|\bsender\b|domain/i.test(words)) return false;
  return /invalid_to|`to`|"to"|'to'|\bto field\b|\bto address\b|\brecipient/i.test(words);
}

/** After this many address refusals in a row with no email going out between them, the problem is not the addresses. */
export const ADDRESS_REFUSAL_LIMIT = 3;

/** Midnight UTC of the day `now` falls in: the daily cap counts from there. */
export const todayStartUtc = (now = Date.now()) => Math.floor(now / 86_400_000) * 86_400_000;

/**
 * Whether an unanswered batch may be sent again now. Rows claimed today already count against today's cap; rows
 * claimed on an earlier day don't, so they need room in today's allowance. Never past this run's own limit.
 */
export function resendFits(size: number, claimedAt: number, left: number, runLeft: number, now = Date.now()): boolean {
  if (runLeft <= 0 || size > runLeft) return false;
  return claimedAt >= todayStartUtc(now) || left >= size;
}

/** Resend's Retry-After (seconds, or an HTTP date) in milliseconds; null when absent or unreadable. */
export function retryAfterMs(header: string | null | undefined, now = Date.now()): number | null {
  if (!header) return null;
  const secs = Number(header.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * The idempotency key for one batch. A fresh claim gets a fresh nonce, so a batch whose claims were dropped and made
 * again never reuses a key (Resend would answer 409); only the safe resend of an unanswered batch reuses its key.
 */
export function batchKey(campaignId: string, nonce = crypto.randomBytes(9).toString("base64url")): string {
  return `newsletter-${campaignId}-${nonce}`;
}
/** The key for one email of a batch sent one at a time. */
export const singleKey = (key: string, subscriberId: string) => `${key}-one-${subscriberId}`;
export const isSingleKey = (key: string) => /-one-\d+$/.test(key);

/** Resend keeps idempotency keys for 24 hours: an unanswered batch is sent again with its key until then, never after. */
export const RESEND_WINDOW_MS = 23 * 3_600_000;
export function pendingAction(claimedAt: number, now = Date.now()): "resend" | "unknown" {
  return now - claimedAt < RESEND_WINDOW_MS ? "resend" : "unknown";
}

/** The wait between batch calls, so a big list stays within Resend's rate limit. */
export const BATCH_PAUSE_MS = 600;

/** Checks a Svix signature (how Resend signs webhooks), within five minutes of its time. */
export function verifySvix(secret: string, h: { id: string | null; timestamp: string | null; signature: string | null }, body: string, now = Date.now()): boolean {
  if (!h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (!key.length) return false;
  const expected = crypto.createHmac("sha256", key).update(`${h.id}.${h.timestamp}.${body}`).digest();
  return h.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const got = Buffer.from(sig, "base64");
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

/** Plain text of an article's HTML. */
export const plainOf = (html: string) =>
  html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

// ---------- metrics, schedules and events (pure) ----------

export interface CampaignMetrics {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  opens: number;
  uniqueOpens: number;
  clicks: number;
  uniqueClicks: number;
}

export const emptyMetrics = (): CampaignMetrics => ({ sent: 0, delivered: 0, bounced: 0, complained: 0, unsubscribed: 0, opens: 0, uniqueOpens: 0, clicks: 0, uniqueClicks: 0 });

/** A share as a whole percent with one decimal, or null when there is nothing to divide by (never a made up 0%). */
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/**
 * The rates the owner sees. Opens and clicks are counted against delivered emails once Resend reports deliveries,
 * else against sent ones; each is null when there is nothing to count against.
 */
export function metricRates(m: CampaignMetrics) {
  const base = m.delivered || m.sent;
  return {
    delivered: pct(m.delivered, m.sent),
    bounced: pct(m.bounced, m.sent),
    complained: pct(m.complained, m.sent),
    unsubscribed: pct(m.unsubscribed, m.sent),
    opens: pct(m.uniqueOpens, base),
    clicks: pct(m.uniqueClicks, base),
  };
}

export function addMetrics(a: CampaignMetrics, b: CampaignMetrics): CampaignMetrics {
  const out = emptyMetrics();
  for (const k of Object.keys(out) as (keyof CampaignMetrics)[]) out[k] = a[k] + b[k];
  return out;
}

/** Monday of the UTC week a moment falls in, as YYYY-MM-DD. */
export function weekOf(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

/** The last `weeks` weeks, oldest first, with the counts found and zeros for weeks with none. */
export function weekSeries(rows: { week: string; subscribed: number; unsubscribed: number }[], weeks = 12, now = Date.now()) {
  const by = new Map(rows.map((r) => [r.week.slice(0, 10), r]));
  const out: { week: string; subscribed: number; unsubscribed: number }[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const w = weekOf(now - i * 7 * 864e5);
    const r = by.get(w);
    out.push({ week: w, subscribed: r?.subscribed ?? 0, unsubscribed: r?.unsubscribed ?? 0 });
  }
  return out;
}

/** True when `tz` is a time zone this server knows (an IANA name like America/Chicago). */
export function validZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** The weekday (0 Sunday to 6 Saturday), hour and date of a moment in a time zone. */
export function localTime(now: number, tz: string): { weekday: number; hour: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { weekday, hour: Number(get("hour")) % 24, date: `${get("year")}-${get("month")}-${get("day")}` };
}

/**
 * Whether the weekly newsletter is due now: on the owner's weekday, at or after their hour (in their time zone), and
 * not tried yet that day. `key` is the local date, saved when it runs so it is tried once a week.
 */
export function weeklyDue(f: { now: number; tz: string; day: number; hour: number; lastKey: string | null }): { due: boolean; key: string } {
  const t = localTime(f.now, validZone(f.tz) ? f.tz : "UTC");
  return { due: t.weekday === f.day && t.hour >= f.hour && f.lastKey !== t.date, key: t.date };
}

/** A send time the owner picked: in the future and within 60 days; null for "send now". */
export function parseSchedule(v: unknown, now = Date.now()): Date | null {
  if (v === undefined || v === null || v === "") return null;
  const at = typeof v === "string" ? Date.parse(v) : NaN;
  if (Number.isNaN(at)) throw new Error("Pick a date and time to send it.");
  if (at < now + 60_000) throw new Error("Pick a time in the future.");
  if (at > now + 60 * 864e5) throw new Error("Pick a time within the next 60 days.");
  return new Date(at);
}

export const EVENT_TYPES = ["email.sent", "email.delivered", "email.delivery_delayed", "email.bounced", "email.complained", "email.opened", "email.clicked"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** The parts of a Resend webhook event this app keeps; null for an event it doesn't track. */
export function eventFields(ev: unknown): { type: EventType; resendId: string | null; emails: string[]; link: string | null; at: string | null; bounceType: string | null } | null {
  const e = (ev ?? {}) as { type?: unknown; created_at?: unknown; data?: Record<string, unknown> };
  if (typeof e.type !== "string" || !(EVENT_TYPES as readonly string[]).includes(e.type)) return null;
  const d = e.data ?? {};
  const to = Array.isArray(d.to) ? d.to : typeof d.to === "string" ? [d.to] : [];
  const click = (d.click ?? {}) as { link?: unknown };
  const bounce = (d.bounce ?? {}) as { type?: unknown };
  const at = typeof d.created_at === "string" ? d.created_at : typeof e.created_at === "string" ? e.created_at : null;
  return {
    type: e.type as EventType,
    resendId: typeof d.email_id === "string" && d.email_id.length <= 100 ? d.email_id : null,
    emails: to.filter((x): x is string => typeof x === "string").slice(0, 50),
    link: typeof click.link === "string" ? click.link.slice(0, 1000) : null,
    at: at && !Number.isNaN(Date.parse(at)) ? new Date(Date.parse(at)).toISOString() : null,
    bounceType: typeof bounce.type === "string" ? bounce.type : null,
  };
}

/** The newest article whose link no newsletter used yet; null when every one was used. */
export function pickArticle<T extends { url: string }>(articles: T[], used: Set<string>, siteDomain: string | null): (T & { link: string }) | null {
  for (const a of articles) {
    const link = /^https?:\/\//i.test(a.url) ? a.url : siteDomain ? `https://${siteDomain}${a.url.startsWith("/") ? "" : "/"}${a.url}` : null;
    if (link && !used.has(link)) return { ...a, link };
  }
  return null;
}

/** After this many failed weekly runs in a row, the weekly newsletter pauses itself until the owner turns it on again. */
export const WEEKLY_FAILURE_LIMIT = 2;

// ---------- storage ----------

let ready: Promise<void> | null = null;
function schema(): Promise<void> {
  ready ??= (async () => {
    await ensureSchema();
    await sql`CREATE TABLE IF NOT EXISTS insights_newsletter_settings (
      account_id bigint PRIMARY KEY,
      resend_key_enc text,
      webhook_secret_enc text,
      from_name text NOT NULL DEFAULT '',
      from_address text NOT NULL DEFAULT '',
      reply_to text NOT NULL DEFAULT '',
      postal_address text NOT NULL DEFAULT '',
      daily_cap integer NOT NULL DEFAULT 500,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS insights_newsletter_subscribers (
      id bigserial PRIMARY KEY,
      account_id bigint NOT NULL,
      email text NOT NULL,
      name text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'subscribed',
      source text NOT NULL,
      consent text NOT NULL DEFAULT '',
      token text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, email)
    )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS insights_newsletter_subscribers_token ON insights_newsletter_subscribers (token)`;
    await sql`CREATE INDEX IF NOT EXISTS insights_newsletter_subscribers_status ON insights_newsletter_subscribers (account_id, status, id)`;
    await sql`CREATE TABLE IF NOT EXISTS insights_newsletter_campaigns (
      id bigserial PRIMARY KEY,
      account_id bigint NOT NULL,
      subject text NOT NULL DEFAULT '',
      preview text NOT NULL DEFAULT '',
      body text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'draft',
      checked text NOT NULL DEFAULT 'owner',
      source_url text,
      origin text,
      approved_at timestamptz,
      approved_count integer,
      test_sent_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    )`;
    await sql`CREATE INDEX IF NOT EXISTS insights_newsletter_campaigns_account ON insights_newsletter_campaigns (account_id, created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS insights_newsletter_campaigns_due ON insights_newsletter_campaigns (approved_at) WHERE status IN ('approved', 'sending')`;
    // One row per campaign and subscriber: claimed ("pending") before the call to Resend, so a retry or an overlapping
    // run never sends anyone the same campaign twice.
    await sql`CREATE TABLE IF NOT EXISTS insights_newsletter_sends (
      campaign_id bigint NOT NULL,
      subscriber_id bigint NOT NULL,
      account_id bigint NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      resend_id text,
      sent_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (campaign_id, subscriber_id)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS insights_newsletter_sends_day ON insights_newsletter_sends (account_id, sent_at)`;
    // The idempotency key a claimed row went out with, so an unanswered batch is sent again with exactly that key.
    await sql`ALTER TABLE insights_newsletter_sends ADD COLUMN IF NOT EXISTS batch_key text`;
    await sql`ALTER TABLE insights_newsletter_sends ADD COLUMN IF NOT EXISTS note text`;
    // The answer a row's own last attempt got when it stayed pending (a status code, or 0 for no answer).
    await sql`ALTER TABLE insights_newsletter_sends ADD COLUMN IF NOT EXISTS last_status integer`;
    await sql`CREATE INDEX IF NOT EXISTS insights_newsletter_sends_pending ON insights_newsletter_sends (campaign_id, batch_key) WHERE status = 'pending'`;
    // When the hourly run last took a turn for this email, so sites take turns fairly.
    await sql`ALTER TABLE insights_newsletter_campaigns ADD COLUMN IF NOT EXISTS last_run_at timestamptz`;
    // What kind of email: a one off campaign, the welcome email (always on once approved), or the weekly newsletter.
    await sql`ALTER TABLE insights_newsletter_campaigns ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'campaign'`;
    // Approved for a later time: the hourly run sends it from then on.
    await sql`ALTER TABLE insights_newsletter_campaigns ADD COLUMN IF NOT EXISTS scheduled_at timestamptz`;
    // Approved by the agent on the owner's standing permission (send on its own), not by a click.
    await sql`ALTER TABLE insights_newsletter_campaigns ADD COLUMN IF NOT EXISTS auto boolean NOT NULL DEFAULT false`;
    await sql`CREATE INDEX IF NOT EXISTS insights_newsletter_sends_resend ON insights_newsletter_sends (account_id, resend_id) WHERE resend_id IS NOT NULL`;
    // Automatic sending, all off until the owner turns it on.
    await sql`ALTER TABLE insights_newsletter_settings ADD COLUMN IF NOT EXISTS welcome_on boolean NOT NULL DEFAULT false`;
    await sql`ALTER TABLE insights_newsletter_settings ADD COLUMN IF NOT EXISTS welcome_since timestamptz`;
    await sql`ALTER TABLE insights_newsletter_settings ADD COLUMN IF NOT EXISTS weekly_on boolean NOT NULL DEFAULT false`;
    await sql`ALTER TABLE insights_newsletter_settings ADD COLUMN IF NOT EXISTS weekly_auto_send boolean NOT NULL DEFAULT false`;
    await sql`ALTER TABLE insights_newsletter_settings ADD COLUMN IF NOT EXISTS weekly_day integer NOT NULL DEFAULT 2`;
    await sql`ALTER TABLE insights_newsletter_settings ADD COLUMN IF NOT EXISTS weekly_hour integer NOT NULL DEFAULT 9`;
    await sql`ALTER TABLE insights_newsletter_settings ADD COLUMN IF NOT EXISTS time_zone text`;
    await sql`ALTER TABLE insights_newsletter_settings ADD COLUMN IF NOT EXISTS weekly_last_key text`;
    await sql`ALTER TABLE insights_newsletter_settings ADD COLUMN IF NOT EXISTS weekly_failures integer NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE insights_newsletter_settings ADD COLUMN IF NOT EXISTS weekly_note text`;
    await sql`ALTER TABLE insights_newsletter_settings ADD COLUMN IF NOT EXISTS weekly_paused text`;
    // The app's public address, saved by the owner's settings click, for links in emails the agent sends on its own.
    await sql`ALTER TABLE insights_newsletter_settings ADD COLUMN IF NOT EXISTS origin text`;
    // The welcome email went to this person (once ever), and which email an unsubscribe came from.
    await sql`ALTER TABLE insights_newsletter_subscribers ADD COLUMN IF NOT EXISTS welcomed_at timestamptz`;
    await sql`ALTER TABLE insights_newsletter_subscribers ADD COLUMN IF NOT EXISTS unsub_campaign_id bigint`;
    await sql`ALTER TABLE insights_newsletter_subscribers ADD COLUMN IF NOT EXISTS unsub_at timestamptz`;
    // Resend's delivery and engagement events, once each (the Svix message id), keyed by account.
    await sql`CREATE TABLE IF NOT EXISTS insights_newsletter_events (
      account_id bigint NOT NULL,
      svix_id text NOT NULL,
      type text NOT NULL,
      resend_id text,
      campaign_id bigint,
      subscriber_id bigint,
      link text,
      at timestamptz NOT NULL DEFAULT now(),
      received_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, svix_id)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS insights_newsletter_events_campaign ON insights_newsletter_events (account_id, campaign_id, type)`;
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

interface Settings {
  resendKey: string | null;
  webhookSecret: string | null;
  fromName: string;
  fromAddress: string;
  replyTo: string;
  postalAddress: string;
  dailyCap: number;
  welcomeOn: boolean;
  welcomeSince: string | null;
  weeklyOn: boolean;
  weeklyAutoSend: boolean;
  weeklyDay: number;
  weeklyHour: number;
  timeZone: string | null;
  weeklyLastKey: string | null;
  weeklyFailures: number;
  weeklyNote: string | null;
  weeklyPaused: string | null;
  origin: string | null;
}

const yes = (v: string | null | undefined) => v === "t" || v === "true";

async function readSettings(accountId: string): Promise<Settings> {
  await schema();
  const [r] = await sql`SELECT * FROM insights_newsletter_settings WHERE account_id = ${accountId}`;
  const secret = r?.resend_key_enc || r?.webhook_secret_enc ? await tokenSecret() : "";
  const cap = Number(r?.daily_cap);
  return {
    resendKey: r?.resend_key_enc ? decrypt(r.resend_key_enc, secret) : null,
    webhookSecret: r?.webhook_secret_enc ? decrypt(r.webhook_secret_enc, secret) : null,
    fromName: r?.from_name ?? "",
    fromAddress: r?.from_address ?? "",
    replyTo: r?.reply_to ?? "",
    postalAddress: r?.postal_address ?? "",
    dailyCap: Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_DAILY_CAP,
    welcomeOn: yes(r?.welcome_on),
    welcomeSince: r?.welcome_since ?? null,
    weeklyOn: yes(r?.weekly_on),
    weeklyAutoSend: yes(r?.weekly_auto_send),
    weeklyDay: Number.isInteger(Number(r?.weekly_day)) ? Number(r?.weekly_day) : 2,
    weeklyHour: Number.isInteger(Number(r?.weekly_hour)) ? Number(r?.weekly_hour) : 9,
    timeZone: validZone(r?.time_zone) ? r!.time_zone : null,
    weeklyLastKey: r?.weekly_last_key ?? null,
    weeklyFailures: Number(r?.weekly_failures ?? 0) || 0,
    weeklyNote: r?.weekly_note ?? null,
    weeklyPaused: r?.weekly_paused ?? null,
    origin: r?.origin ?? null,
  };
}

/** What still has to be set up before anything can be sent, in plain words. */
export function missingSetup(s: Pick<Settings, "resendKey" | "fromAddress" | "postalAddress">): string[] {
  const out: string[] = [];
  if (!s.resendKey) out.push("your Resend key");
  if (!s.fromAddress) out.push("a from address");
  if (!s.postalAddress.trim()) out.push("your business postal address");
  return out;
}

/** The settings as the browser sees them: the keys only as "saved", never their values. */
export interface NewsletterSettingsView {
  keySaved: boolean;
  webhookSaved: boolean;
  fromName: string;
  fromAddress: string;
  replyTo: string;
  postalAddress: string;
  dailyCap: number;
  subdomain: boolean;
  welcomeOn: boolean;
  weeklyOn: boolean;
  weeklyAutoSend: boolean;
  weeklyDay: number;
  weeklyHour: number;
  timeZone: string | null;
  /** Why the weekly newsletter paused itself, or null. */
  weeklyPaused: string | null;
  /** What the last weekly run did, in plain words. */
  weeklyNote: string | null;
}

/** The connected Shopify store's own time zone. */
async function shopZone(accountId: string): Promise<string | null> {
  const store = (await siteFor(accountId))?.store ?? null;
  if (!store) return null;
  const d = await shopifyGql<{ shop: { ianaTimezone: string | null } }>(store, "{ shop { ianaTimezone } }");
  return validZone(d.shop.ianaTimezone) ? d.shop.ianaTimezone : null;
}

/** The automatic sending choices (owner only, checked by the caller). Pure apart from the time zone check. */
export function cleanAuto(b: Record<string, unknown>, cur: Pick<Settings, "welcomeOn" | "weeklyOn" | "weeklyAutoSend" | "weeklyDay" | "weeklyHour" | "timeZone">) {
  const flag = (v: unknown, keep: boolean) => (v === undefined ? keep : v === true);
  const day = b.weeklyDay === undefined ? cur.weeklyDay : Number(b.weeklyDay);
  const hour = b.weeklyHour === undefined ? cur.weeklyHour : Number(b.weeklyHour);
  if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error("Pick a day of the week.");
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("Pick an hour of the day.");
  let tz = cur.timeZone;
  if (b.timeZone !== undefined) {
    if (b.timeZone === "" || b.timeZone === null) tz = null;
    else if (validZone(b.timeZone)) tz = b.timeZone;
    else throw new Error("That time zone isn't known. Use a name like America/Chicago.");
  }
  return { welcomeOn: flag(b.welcomeOn, cur.welcomeOn), weeklyOn: flag(b.weeklyOn, cur.weeklyOn), weeklyAutoSend: flag(b.weeklyAutoSend, cur.weeklyAutoSend), weeklyDay: day, weeklyHour: hour, timeZone: tz };
}

export async function saveNewsletterSettings(accountId: string, input: unknown, origin?: string): Promise<string | null> {
  await schema();
  const b = (input ?? {}) as Record<string, unknown>;
  const cur = await readSettings(accountId);
  const fromName = b.fromName !== undefined ? oneLine(b.fromName, 80).replace(/["\\<>]/g, "") : cur.fromName;
  let fromAddress = cur.fromAddress;
  if (b.fromAddress !== undefined) {
    const raw = oneLine(b.fromAddress, 254);
    const e = raw ? normalizeEmail(raw) : "";
    if (e === null) throw new Error("The from address isn't an email address. Use one like news@news.yourdomain.com.");
    fromAddress = e;
  }
  let replyTo = cur.replyTo;
  if (b.replyTo !== undefined) {
    const raw = oneLine(b.replyTo, 254);
    const e = raw ? normalizeEmail(raw) : "";
    if (e === null) throw new Error("The reply address isn't an email address.");
    replyTo = e;
  }
  const postal = b.postalAddress !== undefined ? cut(b.postalAddress, 400) : cur.postalAddress;
  let cap = cur.dailyCap;
  if (b.dailyCap !== undefined) {
    cap = Number(b.dailyCap);
    if (!Number.isInteger(cap) || cap < 1 || cap > MAX_DAILY_CAP) throw new Error(`Pick a daily limit between 1 and ${MAX_DAILY_CAP.toLocaleString("en-US")}.`);
  }
  const secret = await tokenSecret();
  let keyEnc: string | null | undefined;
  if (typeof b.resendKey === "string" && b.resendKey.trim()) {
    const k = b.resendKey.trim();
    if (!/^re_[A-Za-z0-9_]{8,200}$/.test(k)) throw new Error("That doesn't look like a Resend key. It starts with re_ and is in your Resend account under API Keys.");
    keyEnc = encrypt(k, secret);
  } else if (b.removeKey === true) keyEnc = null;
  let hookEnc: string | null | undefined;
  if (typeof b.webhookSecret === "string" && b.webhookSecret.trim()) {
    const w = b.webhookSecret.trim();
    if (!/^whsec_[A-Za-z0-9+/=]{16,200}$/.test(w)) throw new Error("That doesn't look like a Resend signing secret. It starts with whsec_ and is shown on the webhook in Resend.");
    hookEnc = encrypt(w, secret);
  } else if (b.removeWebhook === true) hookEnc = null;
  await sql`INSERT INTO insights_newsletter_settings (account_id, from_name, from_address, reply_to, postal_address, daily_cap, resend_key_enc, webhook_secret_enc)
    VALUES (${accountId}, ${fromName}, ${fromAddress}, ${replyTo}, ${postal}, ${cap}, ${keyEnc ?? null}, ${hookEnc ?? null})
    ON CONFLICT (account_id) DO UPDATE SET from_name = EXCLUDED.from_name, from_address = EXCLUDED.from_address, reply_to = EXCLUDED.reply_to,
      postal_address = EXCLUDED.postal_address, daily_cap = EXCLUDED.daily_cap,
      resend_key_enc = CASE WHEN ${keyEnc === undefined ? "keep" : "set"}::text = 'keep' THEN insights_newsletter_settings.resend_key_enc ELSE EXCLUDED.resend_key_enc END,
      webhook_secret_enc = CASE WHEN ${hookEnc === undefined ? "keep" : "set"}::text = 'keep' THEN insights_newsletter_settings.webhook_secret_enc ELSE EXCLUDED.webhook_secret_enc END,
      updated_at = now()`;
  const auto = cleanAuto(b, cur);
  // No zone chosen: the shop's own, when a Shopify store is connected.
  if (!auto.timeZone && auto.weeklyOn) auto.timeZone = await shopZone(accountId).catch(() => null);
  // Turning the weekly newsletter on again (a pause turns it off) clears the pause and its failure count.
  const weeklyRestart = auto.weeklyOn && !cur.weeklyOn;
  await sql`UPDATE insights_newsletter_settings SET welcome_on = ${auto.welcomeOn}, weekly_on = ${auto.weeklyOn}, weekly_auto_send = ${auto.weeklyAutoSend},
      weekly_day = ${auto.weeklyDay}, weekly_hour = ${auto.weeklyHour}, time_zone = ${auto.timeZone},
      weekly_failures = CASE WHEN ${weeklyRestart ? "1" : "0"}::text = '1' THEN 0 ELSE weekly_failures END,
      weekly_paused = CASE WHEN ${weeklyRestart ? "1" : "0"}::text = '1' THEN NULL ELSE weekly_paused END,
      origin = coalesce(${origin && /^https?:\/\/[a-z0-9.:-]+$/i.test(origin) ? origin : null}, origin)
    WHERE account_id = ${accountId}`;
  // With a full access key, say whether the from address's domain is verified in Resend. A sending only key can't
  // list domains, which is fine: the test email shows it.
  const key = keyEnc ? decrypt(keyEnc, secret) : cur.resendKey;
  if (!key || !fromAddress) return null;
  const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res) return null;
  if (res.status === 401 && keyEnc) {
    const body = await res.text().catch(() => "");
    if (!/restricted/i.test(body)) return "Resend didn't accept this key. Check that you copied all of it.";
    return null;
  }
  if (!res.ok) return null;
  const d = (await res.json().catch(() => ({}))) as { data?: { name: string; status: string }[] };
  const host = fromAddress.split("@")[1];
  const dom = d.data?.find((x) => x.name?.toLowerCase() === host);
  if (!dom) return `${host} isn't in your Resend account yet. Add it under Domains in Resend and verify it, or emails can't be sent.`;
  if (dom.status !== "verified") return `${host} isn't verified in Resend yet. Finish the DNS records Resend shows under Domains.`;
  return null;
}

async function subscriberCounts(accountId: string): Promise<Record<SubscriberStatus, number>> {
  const rows = await sql`SELECT status, count(*) AS n FROM insights_newsletter_subscribers WHERE account_id = ${accountId} GROUP BY status`;
  const out: Record<SubscriberStatus, number> = { subscribed: 0, unsubscribed: 0, bounced: 0, complained: 0 };
  for (const r of rows) if (r.status && r.status in out) out[r.status as SubscriberStatus] = Number(r.n ?? 0);
  return out;
}

export async function sentToday(accountId: string): Promise<number> {
  await schema();
  const [r] = await sql`SELECT count(*) AS n FROM insights_newsletter_sends WHERE account_id = ${accountId}
    AND status IN ('pending', 'sent', 'unknown') AND sent_at >= ((now() AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC')`;
  return Number(r?.n ?? 0);
}

export interface Subscriber {
  id: string;
  email: string;
  name: string;
  status: SubscriberStatus;
  source: SubscriberSource;
  consent: string;
  createdAt: string;
}

export interface Campaign {
  id: string;
  subject: string;
  preview: string;
  body: string;
  status: CampaignStatus;
  checked: "ai" | "owner";
  sourceUrl: string | null;
  approvedAt: string | null;
  approvedCount: number | null;
  testSentAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  sent: number;
  /** No clear answer from Resend within 24 hours; never sent again. */
  unsure: number;
  /** Subscribed when approved and still waiting. */
  waiting: number;
  /** A test went out since the last edit. */
  tested: boolean;
  kind: "campaign" | "welcome" | "weekly";
  /** Approved for this time; the hourly run sends it from then on. */
  scheduledAt: string | null;
  /** Approved by the agent on the owner's standing permission. */
  auto: boolean;
}

/** A timestamp as Postgres sends it as text ("2026-11-26 10:00:00.12+00"), in ISO form for the browser. */
export function iso(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

const toCampaign = (r: Record<string, string | null>): Campaign => ({
  id: String(r.id),
  subject: r.subject ?? "",
  preview: r.preview ?? "",
  body: r.body ?? "",
  status: (r.status ?? "draft") as CampaignStatus,
  checked: r.checked === "ai" ? "ai" : "owner",
  sourceUrl: r.source_url ?? null,
  approvedAt: iso(r.approved_at),
  approvedCount: r.approved_count === null || r.approved_count === undefined ? null : Number(r.approved_count),
  testSentAt: iso(r.test_sent_at),
  lastError: r.last_error ?? null,
  createdAt: iso(r.created_at) ?? "",
  updatedAt: iso(r.updated_at) ?? "",
  finishedAt: iso(r.finished_at),
  sent: Number(r.sent ?? 0),
  unsure: Number(r.unsure ?? 0),
  waiting: Number(r.waiting ?? 0),
  tested: r.tested === "t" || r.tested === "true",
  kind: r.kind === "welcome" || r.kind === "weekly" ? r.kind : "campaign",
  scheduledAt: iso(r.scheduled_at),
  auto: r.auto === "t" || r.auto === "true",
});

export async function newsletterView(accountId: string, query = "") {
  await schema();
  const s = await readSettings(accountId);
  const q = oneLine(query, 120).toLowerCase();
  const [counts, today, subs, camps, store] = await Promise.all([
    subscriberCounts(accountId),
    sentToday(accountId),
    q
      ? sql`SELECT id, email, name, status, source, consent, created_at FROM insights_newsletter_subscribers
          WHERE account_id = ${accountId} AND (email LIKE ${`%${q.replace(/[%_\\]/g, "\\$&")}%`} OR lower(name) LIKE ${`%${q.replace(/[%_\\]/g, "\\$&")}%`}) ORDER BY id DESC LIMIT 50`
      : sql`SELECT id, email, name, status, source, consent, created_at FROM insights_newsletter_subscribers WHERE account_id = ${accountId} ORDER BY id DESC LIMIT 50`,
    sql`SELECT c.*, (c.test_sent_at IS NOT NULL AND c.test_sent_at >= c.updated_at) AS tested,
        (SELECT count(*) FROM insights_newsletter_sends x WHERE x.campaign_id = c.id AND x.status = 'sent') AS sent,
        (SELECT count(*) FROM insights_newsletter_sends x WHERE x.campaign_id = c.id AND x.status = 'unknown') AS unsure,
        CASE WHEN c.kind = 'welcome' THEN (SELECT count(*) FROM insights_newsletter_subscribers s, insights_newsletter_settings st
          WHERE st.account_id = c.account_id AND s.account_id = c.account_id AND s.status = 'subscribed' AND s.welcomed_at IS NULL
            AND st.welcome_since IS NOT NULL AND s.created_at >= st.welcome_since
            AND NOT EXISTS (SELECT 1 FROM insights_newsletter_sends x WHERE x.campaign_id = c.id AND x.subscriber_id = s.id))
        WHEN c.status IN ('approved', 'sending', 'stopped') AND c.approved_at IS NOT NULL THEN (SELECT count(*) FROM insights_newsletter_subscribers s WHERE s.account_id = c.account_id
          AND s.status = 'subscribed' AND s.created_at <= c.approved_at
          AND NOT EXISTS (SELECT 1 FROM insights_newsletter_sends x WHERE x.campaign_id = c.id AND x.subscriber_id = s.id)) ELSE 0 END AS waiting
      FROM insights_newsletter_campaigns c WHERE c.account_id = ${accountId} ORDER BY c.created_at DESC LIMIT 30`,
    siteFor(accountId).then((x) => Boolean(x?.store), () => false),
  ]);
  const [owner] = await sql`SELECT email FROM insights_accounts WHERE id = ${accountId}`;
  const settings: NewsletterSettingsView = {
    keySaved: Boolean(s.resendKey),
    webhookSaved: Boolean(s.webhookSecret),
    fromName: s.fromName,
    fromAddress: s.fromAddress,
    replyTo: s.replyTo,
    postalAddress: s.postalAddress,
    dailyCap: s.dailyCap,
    subdomain: s.fromAddress ? onSubdomain(s.fromAddress) : false,
    welcomeOn: s.welcomeOn,
    weeklyOn: s.weeklyOn,
    weeklyAutoSend: s.weeklyAutoSend,
    weeklyDay: s.weeklyDay,
    weeklyHour: s.weeklyHour,
    timeZone: s.timeZone,
    weeklyPaused: s.weeklyPaused,
    weeklyNote: s.weeklyNote,
  };
  return {
    settings,
    missing: missingSetup(s),
    counts,
    sentToday: today,
    subscribers: subs.map(
      (r): Subscriber => ({
        id: String(r.id),
        email: r.email ?? "",
        name: r.name ?? "",
        status: (r.status ?? "subscribed") as SubscriberStatus,
        source: (r.source ?? "manual") as SubscriberSource,
        consent: r.consent ?? "",
        createdAt: iso(r.created_at) ?? "",
      }),
    ),
    campaigns: camps.map(toCampaign),
    ownerEmail: owner?.email ?? null,
    hasStore: store,
  };
}

// ---------- subscribers ----------

async function existingStatuses(accountId: string, emails: string[]): Promise<Map<string, SubscriberStatus>> {
  const out = new Map<string, SubscriberStatus>();
  const SEP = String.fromCharCode(31);
  for (const part of chunk(emails, 2000)) {
    const rows = await sql`SELECT email, status FROM insights_newsletter_subscribers WHERE account_id = ${accountId}
      AND email = ANY(string_to_array(${part.join(SEP)}, chr(31)))`;
    for (const r of rows) if (r.email) out.set(r.email, (r.status ?? "subscribed") as SubscriberStatus);
  }
  return out;
}

async function insertRows(accountId: string, rows: ListRow[], source: SubscriberSource, consent: string): Promise<number> {
  let added = 0;
  for (const part of chunk(rows, 1000)) {
    // ON CONFLICT DO NOTHING: anyone already on the list (whatever their status) is never changed by an import.
    const made = await sql`INSERT INTO insights_newsletter_subscribers (account_id, email, name, status, source, consent, token)
      SELECT ${accountId}, x.email, x.name, 'subscribed', ${source}, ${consent}, x.token
      FROM jsonb_to_recordset(${JSON.stringify(part.map((r) => ({ email: r.email, name: r.name, token: newToken() })))}::jsonb) AS x(email text, name text, token text)
      ON CONFLICT (account_id, email) DO NOTHING RETURNING id`;
    added += made.length;
  }
  return added;
}

export interface ImportResult {
  added: number;
  already: number;
  blocked: number;
  invalid: number;
}

/** A pasted list or CSV file. Only with the owner's word that these people agreed to get emails. */
export async function importList(accountId: string, text: unknown, confirmed: unknown, consentNote: unknown, source: SubscriberSource = "import"): Promise<ImportResult> {
  await schema();
  if (confirmed !== true) throw new Error("Tick the box to confirm these people agreed to get emails from you.");
  if (typeof text !== "string" || !text.trim()) throw new Error("Paste the email addresses, or choose a CSV file.");
  if (text.length > 3_000_000) throw new Error("That list is too big. Import up to 20,000 people at a time.");
  const parsed = parseSubscriberList(text);
  if (parsed.rows.length > IMPORT_MAX) throw new Error("Import up to 20,000 people at a time.");
  if (!parsed.rows.length) throw new Error("No email addresses were found in that list.");
  const note = oneLine(consentNote, 200) || (source === "manual" ? "Added by the owner, who confirmed they agreed to get emails" : "Imported by the owner, who confirmed they agreed to get emails");
  const plan = mergeImport(await existingStatuses(accountId, parsed.rows.map((r) => r.email)), parsed.rows);
  const added = await insertRows(accountId, plan.add, source, `${note} (${new Date().toISOString().slice(0, 10)})`);
  return { added, already: plan.already + (plan.add.length - added), blocked: plan.blocked, invalid: parsed.invalid };
}

type ShopCustomer = { firstName: string | null; lastName: string | null; defaultEmailAddress: { emailAddress: string | null; marketingState: string | null } | null };

async function shopCustomers(store: StoreAccess, state: "SUBSCRIBED" | "UNSUBSCRIBED", deadline: number): Promise<{ rows: ListRow[]; complete: boolean }> {
  const rows: ListRow[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  for (;;) {
    if (Date.now() > deadline || rows.length >= IMPORT_MAX) return { rows, complete: false };
    const d: { customers: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopCustomer[] } } = await shopifyGql(
      store,
      `query($after: String, $q: String!) { customers(first: 250, after: $after, query: $q) { pageInfo { hasNextPage endCursor }
        nodes { firstName lastName defaultEmailAddress { emailAddress marketingState } } } }`,
      { after, q: `email_marketing_state:${state}` },
    );
    for (const c of d.customers.nodes) {
      // Shopify's search isn't exact: only the customer's own consent state counts.
      if (c.defaultEmailAddress?.marketingState !== state) continue;
      const email = normalizeEmail(c.defaultEmailAddress.emailAddress ?? "");
      if (!email || seen.has(email)) continue;
      seen.add(email);
      rows.push({ email, name: oneLine([c.firstName, c.lastName].filter(Boolean).join(" "), 120) });
    }
    if (!d.customers.pageInfo.hasNextPage || !d.customers.pageInfo.endCursor) return { rows, complete: true };
    after = d.customers.pageInfo.endCursor;
  }
}

/**
 * Customers of the connected Shopify store who said yes to email marketing there. Customers who unsubscribed in
 * Shopify are marked unsubscribed here too, so a choice made in the store is respected.
 */
export async function importFromShopify(accountId: string, deadline = Date.now() + 50_000): Promise<ImportResult & { optedOut: number; complete: boolean }> {
  await schema();
  const store = (await siteFor(accountId))?.store ?? null;
  if (!store) throw new Error("Connect your Shopify store first (Settings, Connected apps).");
  let yes: { rows: ListRow[]; complete: boolean };
  let no: { rows: ListRow[]; complete: boolean } = { rows: [], complete: true };
  try {
    yes = await shopCustomers(store, "SUBSCRIBED", deadline);
    if (Date.now() < deadline) no = await shopCustomers(store, "UNSUBSCRIBED", deadline);
    else no = { rows: [], complete: false };
  } catch (e) {
    if (/access denied|read_customers|write_customers|protected customer data|not approved|required access/i.test(String((e as Error)?.message ?? e)))
      throw new Error("Shopify needs to let DashPatrol read your customers. Approve the app's updated permissions in Shopify, then try again.");
    throw e;
  }
  let optedOut = 0;
  for (const part of chunk(no.rows.map((r) => r.email), 2000)) {
    const done = await sql`UPDATE insights_newsletter_subscribers SET status = 'unsubscribed', unsub_at = now(), updated_at = now()
      WHERE account_id = ${accountId} AND status = 'subscribed' AND email = ANY(string_to_array(${part.join(String.fromCharCode(31))}, chr(31))) RETURNING id`;
    optedOut += done.length;
  }
  const plan = mergeImport(await existingStatuses(accountId, yes.rows.map((r) => r.email)), yes.rows);
  const added = await insertRows(accountId, plan.add, "shopify", `Subscribed to email marketing in Shopify (${new Date().toISOString().slice(0, 10)})`);
  return { added, already: plan.already + (plan.add.length - added), blocked: plan.blocked, invalid: 0, optedOut, complete: yes.complete && no.complete };
}

/** The owner takes someone off the list (they asked by phone, say). Never the other way round. */
export async function ownerUnsubscribe(accountId: string, id: unknown): Promise<void> {
  await schema();
  if (typeof id !== "string" || !/^\d{1,18}$/.test(id)) throw new Error("That person isn't on your list.");
  await sql`UPDATE insights_newsletter_subscribers SET status = 'unsubscribed', unsub_at = now(), updated_at = now()
    WHERE id = ${id} AND account_id = ${accountId} AND status = 'subscribed'`;
}

/** The public unsubscribe page's lookup: who the token is for, and the business name. */
export async function subscriberByToken(token: unknown): Promise<{ accountId: string; email: string; status: SubscriberStatus; brand: string } | null> {
  if (!validToken(token)) return null;
  await schema();
  const [r] = await sql`SELECT account_id, email, status FROM insights_newsletter_subscribers WHERE token = ${token}`;
  if (!r?.account_id) return null;
  const profile = await readProfile(String(r.account_id)).catch(() => null);
  // Only the from name: the public page never decrypts the site's keys.
  const [st] = await sql`SELECT from_name FROM insights_newsletter_settings WHERE account_id = ${r.account_id}`.catch(() => [] as Record<string, string | null>[]);
  return { accountId: String(r.account_id), email: r.email ?? "", status: (r.status ?? "subscribed") as SubscriberStatus, brand: st?.from_name || profile?.brandName || profile?.siteDomain || "this sender" };
}

/** One click unsubscribe. Bounced and complained stay as they are (they are already never emailed). */
export async function unsubscribeByToken(token: unknown, campaignId?: unknown): Promise<boolean> {
  if (!validToken(token)) return false;
  await schema();
  // The email it came from is kept only when it is this subscriber's own site's email, for that email's numbers.
  const cid = typeof campaignId === "string" && /^\d{1,18}$/.test(campaignId) ? campaignId : null;
  const [r] = await sql`UPDATE insights_newsletter_subscribers s SET
      unsub_campaign_id = CASE WHEN s.status = 'subscribed' THEN (SELECT k.id FROM insights_newsletter_campaigns k WHERE k.id = ${cid}::bigint AND k.account_id = s.account_id) ELSE s.unsub_campaign_id END,
      unsub_at = CASE WHEN s.status = 'subscribed' THEN now() ELSE s.unsub_at END,
      status = CASE WHEN s.status = 'subscribed' THEN 'unsubscribed' ELSE s.status END, updated_at = now()
    WHERE s.token = ${token} RETURNING s.id`;
  return Boolean(r);
}

/** Resend told us an address bounced or the person marked the email as spam. */
export async function markDelivery(accountId: string, emails: string[], status: "bounced" | "complained"): Promise<number> {
  await schema();
  const list = emails.map(normalizeEmail).filter((e): e is string => Boolean(e));
  if (!list.length) return 0;
  // A complaint outranks a bounce; neither is ever undone by an import.
  const rows = await sql`UPDATE insights_newsletter_subscribers SET status = ${status}, updated_at = now()
    WHERE account_id = ${accountId} AND email = ANY(string_to_array(${list.join(String.fromCharCode(31))}, chr(31)))
      AND status <> 'complained' RETURNING id`;
  return rows.length;
}

export async function webhookSecretFor(accountId: string): Promise<string | null> {
  if (!/^\d{1,18}$/.test(accountId)) return null;
  return (await readSettings(accountId)).webhookSecret;
}

// ---------- campaigns ----------

const ID = /^\d{1,18}$/;

function cleanCampaign(input: unknown): { subject: string; preview: string; body: string } {
  const b = (input ?? {}) as Record<string, unknown>;
  const subject = oneLine(b.subject, 150);
  const preview = oneLine(b.preview, 200);
  const body = cut(b.body, 50_000);
  if (!subject) throw new Error("Write a subject.");
  if (!body) throw new Error("Write the email.");
  return { subject, preview, body };
}

async function ownedCampaign(accountId: string, id: unknown): Promise<Record<string, string | null>> {
  if (typeof id !== "string" || !ID.test(id)) throw new Error("That email isn't here anymore.");
  const [c] = await sql`SELECT * FROM insights_newsletter_campaigns WHERE id = ${id} AND account_id = ${accountId}`;
  if (!c) throw new Error("That email isn't here anymore.");
  return c;
}

/** Saves a draft (new, or an edit of a draft). Editing means a new test is needed before it can be approved. */
export async function saveCampaign(accountId: string, input: unknown, id?: unknown): Promise<string> {
  await schema();
  const c = cleanCampaign(input);
  if (id !== undefined && id !== null && id !== "") {
    const cur = await ownedCampaign(accountId, id);
    if (cur.status !== "draft" && cur.status !== "stopped" && cur.status !== "failed") throw new Error("This email is already approved. Stop it first to change it.");
    const sent = await sql`SELECT 1 FROM insights_newsletter_sends WHERE campaign_id = ${cur.id} LIMIT 1`;
    if (sent.length) throw new Error("Some people already got this email, so it can't be changed. Start a new one instead.");
    // The owner changed the words: any second AI check no longer applies.
    await sql`UPDATE insights_newsletter_campaigns SET subject = ${c.subject}, preview = ${c.preview}, body = ${c.body}, status = 'draft',
        checked = CASE WHEN subject = ${c.subject}::text AND preview = ${c.preview}::text AND body = ${c.body}::text THEN checked ELSE 'owner' END,
        updated_at = CASE WHEN subject = ${c.subject} AND preview = ${c.preview} AND body = ${c.body} THEN updated_at ELSE now() END, last_error = NULL
      WHERE id = ${cur.id} AND account_id = ${accountId}`;
    return String(cur.id);
  }
  const kind = (input as { kind?: unknown } | null)?.kind === "welcome" ? "welcome" : "campaign";
  const [made] = await sql`INSERT INTO insights_newsletter_campaigns (account_id, subject, preview, body, kind) VALUES (${accountId}, ${c.subject}, ${c.preview}, ${c.body}, ${kind}) RETURNING id`;
  return String(made.id);
}

export async function deleteCampaign(accountId: string, id: unknown): Promise<void> {
  await schema();
  const cur = await ownedCampaign(accountId, id);
  const sent = await sql`SELECT 1 FROM insights_newsletter_sends WHERE campaign_id = ${cur.id} LIMIT 1`;
  if (sent.length || (cur.status !== "draft" && cur.status !== "stopped" && cur.status !== "failed")) throw new Error("Only an email nobody got yet can be deleted.");
  await sql`DELETE FROM insights_newsletter_campaigns WHERE id = ${cur.id} AND account_id = ${accountId}`;
}

/** No article to write from (none at all, or every one already used): a reason to skip, not a failure. */
export class NoNewArticle extends Error {}

/**
 * A draft from one of the site's articles (the latest, or for the weekly newsletter the newest one no newsletter used
 * yet), written by the AI and checked before it is offered: the claim guard (strict on health sites), AI wording, no
 * number the article doesn't have, and a second AI from another service. A draft that fails a check is never saved.
 */
async function draftFrom(accountId: string, f: { unused: boolean; kind: "campaign" | "weekly" }): Promise<{ id: string; checked: "ai" | "owner"; subject: string }> {
  await schema();
  if (isSabbath()) throw new Error("DashPatrol rests for the Sabbath. Try again after Saturday sundown.");
  const profile = await readProfile(accountId);
  const site = await siteFor(accountId);
  if (!site) throw new Error("Connect your website first, so there is an article to share.");
  const articles = await site.articles();
  if (!articles.length) throw new NoNewArticle("No published article was found on your site yet.");
  const used = new Set<string>();
  if (f.unused) {
    const rows = await sql`SELECT DISTINCT source_url FROM insights_newsletter_campaigns WHERE account_id = ${accountId} AND source_url IS NOT NULL`;
    for (const r of rows) if (r.source_url) used.add(r.source_url);
  }
  const latest = pickArticle(articles, used, profile.siteDomain);
  if (!latest) {
    if (!profile.siteDomain && !articles.some((a) => /^https?:\/\//i.test(a.url))) throw new Error("Your website address isn't set, so the email can't link to the article. Add it in Settings.");
    throw new NoNewArticle("There is no new article since the last newsletter.");
  }
  const link = latest.link;
  const articleText = plainOf(latest.body);
  if (articleText.length < 200) throw new Error("The article is too short to write an email from.");
  const base = aiProvider(await readPlatformSettings());
  if (!base) throw new Error("An AI key is needed to write a draft. You can still write the email yourself.");
  const ai = { ...base, site: siteBrief(profile) };
  const health = healthRulesApply(profile);
  const raw = await writeNewsletterDraft(ai, { title: latest.title, articleText, brand: profile.brandName, site: profile.siteDomain ?? "this site", health });
  const subject = noDashes(raw.subject.replace(/["\n]/g, " ").trim()).slice(0, 120);
  const preview = noDashes(raw.preview.replace(/\n/g, " ").trim()).slice(0, 200);
  const paras = raw.body.replace(/https?:\/\/\S+/g, " ").split(/\n\s*\n/).map((p) => noDashes(p.replace(/[ \t]+/g, " ").trim())).filter(Boolean);
  const text = `${subject}\n${preview}\n${paras.join("\n\n")}`;
  if (!subject || !paras.length) throw new Error("The draft came back empty. Please try again.");
  const problem = claimProblem(text, health) ?? (hasAiTell(text) ? "It reads as written by AI." : null) ?? (numbersKnown(text, `${latest.title} ${articleText}`) ? null : "It has a number the article doesn't have.");
  if (problem) throw new Error(`The draft didn't pass the checks, so it isn't offered: ${problem}`);
  const verdict = await secondCheck(ai, {
    what: "a newsletter email that shares the business's own article with its subscribers",
    source: `${latest.title}\n${articleText}`,
    text,
    health,
  });
  if (verdict && !verdict.ok) throw new Error(`A second AI turned the draft down, so it isn't offered: ${verdict.why || "no reason given."}`);
  const body = `${paras.join("\n\n")}\n\n[Read the article](${link})`;
  const checked = verdict ? "ai" : "owner";
  const [made] = await sql`INSERT INTO insights_newsletter_campaigns (account_id, subject, preview, body, checked, source_url, kind)
    VALUES (${accountId}, ${subject}, ${preview}, ${body}, ${checked}, ${link}, ${f.kind}) RETURNING id`;
  return { id: String(made.id), checked, subject };
}

/** The owner's "Draft from my latest article" click. */
export async function draftFromLatestArticle(accountId: string): Promise<string> {
  return (await draftFrom(accountId, { unused: false, kind: "campaign" })).id;
}

type ResendAnswer = { ok: boolean; status: number | null; body: unknown; text: string; retryAfter?: string | null };

async function resendPost(key: string, path: "/emails" | "/emails/batch", payload: unknown, idempotencyKey?: string): Promise<ResendAnswer> {
  const res = await fetch(`https://api.resend.com${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => ({ error: e as Error }));
  if ("error" in res) return { ok: false, status: null, body: null, text: res.error.message };
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { ok: res.ok, status: res.status, body, text: text.slice(0, 300), retryAfter: res.headers.get("retry-after") };
}

const resendWhy = (r: { status: number | null; body: unknown; text: string }) => {
  const m = (r.body as { message?: string } | null)?.message;
  return `${r.status ?? "no answer"}${m ? `: ${m}` : r.text ? `: ${r.text}` : ""}`.slice(0, 300);
};

async function brandOf(accountId: string, s: Settings): Promise<string> {
  const p = await readProfile(accountId).catch(() => null);
  return s.fromName || p?.brandName || p?.siteDomain || "us";
}

/**
 * A test through the business's Resend account: to the owner's own sign in address, or to `person` (a team member
 * who pressed it, with the verified email they signed in with).
 */
export async function sendTest(accountId: string, id: unknown, origin: string, person?: string, canApprove = !person): Promise<string> {
  await schema();
  if (isSabbath()) throw new Error("DashPatrol rests for the Sabbath. Try again after Saturday sundown.");
  const c = await ownedCampaign(accountId, id);
  const s = await readSettings(accountId);
  const missing = missingSetup(s);
  if (missing.length) throw new Error(`Add ${missing.join(", ")} first.`);
  const [owner] = await sql`SELECT email FROM insights_accounts WHERE id = ${accountId}`;
  const to = normalizeEmail(person ?? owner?.email ?? "");
  if (!to) throw new Error("Your account has no email address to send the test to.");
  const payload = buildEmail({
    from: fromHeader(s.fromName, s.fromAddress),
    replyTo: s.replyTo || null,
    to,
    subject: `Test: ${c.subject}`,
    preview: c.preview ?? "",
    body: c.body ?? "",
    brand: await brandOf(accountId, s),
    postalAddress: s.postalAddress,
    // A test link: it opens the unsubscribe page, which says it was only a test.
    unsubscribe: `${origin.replace(/\/+$/, "")}/api/newsletter/unsubscribe?t=test`,
  });
  const r = await resendPost(s.resendKey!, "/emails", payload);
  if (!r.ok) {
    const why = resendWhy(r);
    await report("newsletter", false, `A test newsletter email for account ${accountId} failed (${why})`);
    if (r.status === 401 || r.status === 403) throw new Error(`Resend refused the email (${why}). Check your Resend key and that ${s.fromAddress.split("@")[1]} is verified in Resend.`);
    throw new Error(`Resend didn't send the test (${why}).`);
  }
  await report("newsletter", true);
  // Only a test seen by someone with the right to approve counts: the owner, or a platform owner acting with owner rights,
  // each in their own inbox. A team member's test only shows them the email. Any later edit needs a new test.
  if (canApprove || to === normalizeEmail(owner?.email ?? "")) {
    await sql`UPDATE insights_newsletter_campaigns SET test_sent_at = now() WHERE id = ${c.id} AND account_id = ${accountId}`;
  }
  return to;
}

/**
 * The owner's Send click. Nothing is ever sent without it. The count the owner saw ("Send to N subscribers") must
 * match the list now, a test must have gone out since the last edit, and the words pass the claim guard. With
 * `scheduledAt` it waits until then. For the welcome email this turns it on: from then on each new subscriber gets it
 * once (while the welcome email is turned on in Newsletter settings), and an earlier welcome email stops.
 */
export async function approveCampaign(accountId: string, id: unknown, count: unknown, origin: string, scheduledAt?: unknown): Promise<number> {
  await schema();
  const c = await ownedCampaign(accountId, id);
  if (c.status !== "draft" && c.status !== "stopped") throw new Error("This email isn't a draft anymore.");
  const welcome = c.kind === "welcome";
  const at = welcome ? null : parseSchedule(scheduledAt);
  const s = await readSettings(accountId);
  const missing = missingSetup(s);
  if (missing.length) throw new Error(`Add ${missing.join(", ")} first. US law (CAN SPAM) needs a postal address in every marketing email.`);
  const [t] = await sql`SELECT (test_sent_at IS NOT NULL AND test_sent_at >= updated_at) AS tested FROM insights_newsletter_campaigns WHERE id = ${c.id} AND account_id = ${accountId}`;
  if (t?.tested !== "t" && t?.tested !== "true") throw new Error("Send yourself a test first, and check it in your inbox.");
  const sent = await sql`SELECT 1 FROM insights_newsletter_sends WHERE campaign_id = ${c.id} LIMIT 1`;
  if (sent.length && c.status !== "stopped") throw new Error("This email was already sent.");
  const profile = await readProfile(accountId);
  const problem = claimProblem(`${c.subject}\n${c.preview}\n${c.body}`, healthRulesApply(profile));
  if (problem) throw new Error(`Please change the email first. ${problem}`);
  if (!/^https?:\/\/[a-z0-9.:-]+$/i.test(origin)) throw new Error("Something went wrong on our side. Please try again in a minute.");
  if (welcome) {
    // One welcome email at a time: approving this one stops any earlier one (who got that one is never welcomed again).
    await sql`UPDATE insights_newsletter_campaigns SET status = 'stopped' WHERE account_id = ${accountId} AND kind = 'welcome' AND id <> ${c.id} AND status IN ('approved', 'sending')`;
    await sql`UPDATE insights_newsletter_settings SET welcome_since = coalesce(welcome_since, now()), origin = coalesce(origin, ${origin}) WHERE account_id = ${accountId}`;
    const [done] = await sql`UPDATE insights_newsletter_campaigns SET status = 'approved', approved_at = coalesce(approved_at, now()), origin = ${origin}, last_error = NULL, updated_at = updated_at
      WHERE id = ${c.id} AND account_id = ${accountId} AND status IN ('draft', 'stopped') RETURNING id`;
    if (!done) throw new Error("This email isn't a draft anymore.");
    return 0;
  }
  // A paused email carries on with the people still waiting for it (subscribed when it was first approved); a new one
  // goes to everyone subscribed now. The number must be the one the owner saw on the button.
  let subscribed: number;
  if (c.status === "stopped" && c.approved_at) {
    const [w] = await sql`SELECT count(*) AS n FROM insights_newsletter_subscribers s WHERE s.account_id = ${accountId} AND s.status = 'subscribed'
      AND s.created_at <= ${c.approved_at}::timestamptz AND NOT EXISTS (SELECT 1 FROM insights_newsletter_sends x WHERE x.campaign_id = ${c.id} AND x.subscriber_id = s.id)`;
    subscribed = Number(w?.n ?? 0);
    if (!subscribed) throw new Error("Everyone on the list already got this email.");
    if (Number(count) !== subscribed) throw new Error(`The number waiting changed: ${subscribed.toLocaleString("en-US")} people are still waiting for it. Please check and approve again.`);
  } else {
    subscribed = (await subscriberCounts(accountId)).subscribed;
    if (!subscribed) throw new Error("Nobody is subscribed yet. Import your subscribers first.");
    if (Number(count) !== subscribed) throw new Error(`Your list changed: it now has ${subscribed.toLocaleString("en-US")} subscribers. Please check and approve again.`);
  }
  // Who was subscribed at this moment gets it (and only while they stay subscribed); people added later don't. A
  // scheduled email goes to who is subscribed when it was approved, too: the owner approved that number.
  const [done] = await sql`UPDATE insights_newsletter_campaigns SET status = 'approved', approved_at = coalesce(approved_at, now()), approved_count = ${subscribed},
      origin = ${origin}, last_error = NULL, updated_at = updated_at, scheduled_at = ${at ? at.toISOString() : null}::timestamptz
    WHERE id = ${c.id} AND account_id = ${accountId} AND status IN ('draft', 'stopped') RETURNING id`;
  if (!done) throw new Error("This email isn't a draft anymore.");
  if (c.kind === "weekly") await closeNeed(accountId, "Newsletter", `newsletter:weekly:${c.id}`).catch(() => undefined);
  return subscribed;
}

/** The pause button: no more emails go out for it. Those already sent stay sent. */
export async function stopCampaign(accountId: string, id: unknown): Promise<void> {
  await schema();
  const c = await ownedCampaign(accountId, id);
  await sql`UPDATE insights_newsletter_campaigns SET status = 'stopped', updated_at = updated_at
    WHERE id = ${c.id} AND account_id = ${accountId} AND status IN ('approved', 'sending', 'failed')`;
}

/** After the owner fixed what stopped it (a key, a domain), sending carries on with whoever hasn't got it. */
export async function retryCampaign(accountId: string, id: unknown): Promise<void> {
  await schema();
  const c = await ownedCampaign(accountId, id);
  if (c.status !== "failed") throw new Error("This email isn't waiting for a retry.");
  await sql`UPDATE insights_newsletter_campaigns SET status = 'sending', last_error = NULL WHERE id = ${c.id} AND account_id = ${accountId} AND status = 'failed'`;
}


// ---------- the weekly newsletter (automatic, owner turned on) ----------

/** Sites whose weekly newsletter is due this hour (their weekday and hour, in their time zone), up to `limit`. */
export async function accountsDueForWeekly(limit = 3, now = Date.now()): Promise<string[]> {
  await schema();
  const rows = await sql`SELECT account_id, weekly_day, weekly_hour, time_zone, weekly_last_key FROM insights_newsletter_settings
    WHERE weekly_on AND weekly_paused IS NULL ORDER BY account_id`;
  return rows
    .filter((r) => weeklyDue({ now, tz: r.time_zone ?? "UTC", day: Number(r.weekly_day), hour: Number(r.weekly_hour), lastKey: r.weekly_last_key ?? null }).due)
    .slice(0, limit)
    .map((r) => String(r.account_id));
}

/**
 * The weekly newsletter: drafts from the newest article not used yet, with every check of a manual draft. With
 * "send on its own" on and a real second AI verdict, the agent approves it on the owner's standing permission;
 * otherwise it waits as a draft and the owner is told on the team board. No new article: skipped. Two failed weeks in
 * a row: it pauses itself and says why.
 */
export async function runWeekly(accountId: string, now = Date.now()): Promise<string | null> {
  await schema();
  if (isSabbath()) return null;
  const s = await readSettings(accountId);
  if (!s.weeklyOn || s.weeklyPaused) return null;
  const due = weeklyDue({ now, tz: s.timeZone ?? "UTC", day: s.weeklyDay, hour: s.weeklyHour, lastKey: s.weeklyLastKey });
  if (!due.due) return null;
  // Marked first, so a failure waits for next week instead of trying again every hour.
  const [took] = await sql`UPDATE insights_newsletter_settings SET weekly_last_key = ${due.key}
    WHERE account_id = ${accountId} AND weekly_on AND weekly_last_key IS DISTINCT FROM ${due.key} RETURNING account_id`;
  if (!took) return null;
  const note = (text: string) => sql`UPDATE insights_newsletter_settings SET weekly_note = ${text.slice(0, 500)} WHERE account_id = ${accountId}`;
  let draft: { id: string; checked: "ai" | "owner"; subject: string };
  try {
    draft = await draftFrom(accountId, { unused: true, kind: "weekly" });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (e instanceof NoNewArticle) {
      await note(`${new Date(now).toISOString().slice(0, 10)}: no new article since the last newsletter, so none was sent.`);
      return "no new article";
    }
    const failures = s.weeklyFailures + 1;
    const paused = failures >= WEEKLY_FAILURE_LIMIT;
    await sql`UPDATE insights_newsletter_settings SET weekly_failures = ${failures},
        weekly_paused = CASE WHEN ${paused ? "1" : "0"}::text = '1' THEN ${`Paused after ${WEEKLY_FAILURE_LIMIT} weeks in a row without a draft that passed the checks. Last time: ${why}`.slice(0, 500)} ELSE weekly_paused END,
        weekly_on = CASE WHEN ${paused ? "1" : "0"}::text = '1' THEN false ELSE weekly_on END
      WHERE account_id = ${accountId}`;
    await note(`${new Date(now).toISOString().slice(0, 10)}: no draft this week. ${why}`);
    // Seen by the Inspector (status board) and by the owner (team board).
    await report("newsletter", false, `Weekly newsletter for account ${accountId}: ${why}`);
    await postNote(
      accountId,
      "Newsletter",
      "needs",
      paused
        ? `The weekly newsletter paused itself after ${WEEKLY_FAILURE_LIMIT} weeks without a draft that passed the checks. ${why} Turn it on again in Newsletter settings when it is fixed.`
        : `This week's newsletter wasn't drafted. ${why}`,
      { ref: "newsletter:weekly:failed" },
    );
    return `no draft: ${why}`;
  }
  await sql`UPDATE insights_newsletter_settings SET weekly_failures = 0 WHERE account_id = ${accountId}`;
  await closeNeed(accountId, "Newsletter", "newsletter:weekly:failed").catch(() => undefined);
  const { subscribed } = await subscriberCounts(accountId);
  const missing = missingSetup(s);
  // Sent on its own only with the owner's standing permission, a real second AI verdict (never the owner standing in
  // for it), a complete setup, someone to send it to and the app's address for the unsubscribe links.
  const own = s.weeklyAutoSend && draft.checked === "ai" && !missing.length && subscribed > 0 && Boolean(s.origin);
  if (own) {
    const [done] = await sql`UPDATE insights_newsletter_campaigns SET status = 'approved', approved_at = now(), approved_count = ${subscribed},
        origin = ${s.origin}, auto = true, updated_at = updated_at
      WHERE id = ${draft.id} AND account_id = ${accountId} AND status = 'draft' RETURNING id`;
    if (done) {
      await note(`${new Date(now).toISOString().slice(0, 10)}: "${draft.subject}" was checked by a second AI and is going out on its own to ${subscribed.toLocaleString("en-US")} subscribers.`);
      await postNote(accountId, "Newsletter", "did", `The weekly newsletter "${draft.subject}" passed every check, including a second AI, and is going out on its own to ${subscribed.toLocaleString("en-US")} subscribers. You can pause it in Newsletter.`, { ref: `newsletter:auto:${draft.id}` });
      return `approved on its own for ${subscribed} subscribers`;
    }
  }
  const why = !s.weeklyAutoSend
    ? "Send on its own is off"
    : draft.checked !== "ai"
      ? "no second AI was free to check it"
      : missing.length
        ? `${missing.join(", ")} still needed`
        : !subscribed
          ? "nobody is subscribed yet"
          : "the app's address isn't saved yet (save Newsletter settings once)";
  await note(`${new Date(now).toISOString().slice(0, 10)}: "${draft.subject}" is drafted and waiting for your approval (${why}).`);
  await postNote(accountId, "Newsletter", "needs", `This week's newsletter "${draft.subject}" is drafted and waiting for your test and approval in Newsletter.`, { ref: `newsletter:weekly:${draft.id}` });
  return `drafted, waiting for approval (${why})`;
}

// ---------- Resend's events and the numbers ----------

/**
 * Keeps one Resend webhook event (once per Svix message id), tied to the send it belongs to by Resend's email id.
 * A bounce (not a temporary one) or a spam complaint also takes the person off the list. Returns false for a repeat.
 */
export async function recordEvent(accountId: string, svixId: string, raw: unknown): Promise<boolean> {
  await schema();
  if (!/^\d{1,18}$/.test(accountId) || !svixId || svixId.length > 100) return false;
  const ev = eventFields(raw);
  if (!ev) return false;
  const [send] = ev.resendId
    ? await sql`SELECT campaign_id, subscriber_id FROM insights_newsletter_sends WHERE account_id = ${accountId} AND resend_id = ${ev.resendId} LIMIT 1`
    : [];
  const [made] = await sql`INSERT INTO insights_newsletter_events (account_id, svix_id, type, resend_id, campaign_id, subscriber_id, link, at)
    VALUES (${accountId}, ${svixId}, ${ev.type}, ${ev.resendId}, ${send?.campaign_id ?? null}, ${send?.subscriber_id ?? null}, ${ev.link}, coalesce(${ev.at}::timestamptz, now()))
    ON CONFLICT (account_id, svix_id) DO NOTHING RETURNING svix_id`;
  if (!made) return false;
  if (ev.type === "email.complained") await markDelivery(accountId, ev.emails, "complained");
  // A temporary bounce (a full inbox) isn't a reason to stop emailing someone.
  else if (ev.type === "email.bounced" && !/transient|temporary|soft/i.test(ev.bounceType ?? "")) await markDelivery(accountId, ev.emails, "bounced");
  return true;
}

export interface CampaignRow {
  id: string;
  subject: string;
  kind: Campaign["kind"];
  auto: boolean;
  at: string | null;
  metrics: CampaignMetrics;
  rates: ReturnType<typeof metricRates>;
  /** Orders and revenue from visits tagged with this email (Shopify, last 28 days); null when not known. */
  sales: { orders: number; revenue: number } | null;
}

const metricsOf = (r: Record<string, string | null> | undefined): CampaignMetrics => ({
  sent: Number(r?.sent ?? 0),
  delivered: Number(r?.delivered ?? 0),
  bounced: Number(r?.bounced ?? 0),
  complained: Number(r?.complained ?? 0),
  unsubscribed: Number(r?.unsubscribed ?? 0),
  opens: Number(r?.opens ?? 0),
  uniqueOpens: Number(r?.uopens ?? 0),
  clicks: Number(r?.clicks ?? 0),
  uniqueClicks: Number(r?.uclicks ?? 0),
});

/** The campaign id at the start of a utm_campaign slug ("12_spring_tips"), or null. */
export const slugCampaign = (slug: string) => slug.match(/^(\d{1,18})(?:_|$)/)?.[1] ?? null;

/**
 * The Newsletter's numbers, from this site's own records: sends, Resend's events, our unsubscribe records, the
 * subscriber list by week, and (for a Shopify store) orders from newsletter visits. Nothing is estimated.
 */
export async function newsletterMetrics(accountId: string) {
  await schema();
  const [camps, events, unsubs, growth] = await Promise.all([
    sql`SELECT c.id, c.subject, c.kind, c.auto, coalesce(c.finished_at, c.approved_at) AS at,
        (SELECT count(*) FROM insights_newsletter_sends x WHERE x.campaign_id = c.id AND x.status = 'sent') AS sent
      FROM insights_newsletter_campaigns c WHERE c.account_id = ${accountId}
        AND EXISTS (SELECT 1 FROM insights_newsletter_sends x WHERE x.campaign_id = c.id AND x.status = 'sent')
      ORDER BY coalesce(c.finished_at, c.approved_at) DESC NULLS LAST LIMIT 30`,
    sql`SELECT campaign_id,
        count(DISTINCT subscriber_id) FILTER (WHERE type = 'email.delivered') AS delivered,
        count(DISTINCT subscriber_id) FILTER (WHERE type = 'email.bounced') AS bounced,
        count(DISTINCT subscriber_id) FILTER (WHERE type = 'email.complained') AS complained,
        count(*) FILTER (WHERE type = 'email.opened') AS opens,
        count(DISTINCT subscriber_id) FILTER (WHERE type = 'email.opened') AS uopens,
        count(*) FILTER (WHERE type = 'email.clicked') AS clicks,
        count(DISTINCT subscriber_id) FILTER (WHERE type = 'email.clicked') AS uclicks
      FROM insights_newsletter_events WHERE account_id = ${accountId} AND campaign_id IS NOT NULL GROUP BY campaign_id`,
    sql`SELECT unsub_campaign_id AS campaign_id, count(*) AS n FROM insights_newsletter_subscribers
      WHERE account_id = ${accountId} AND unsub_campaign_id IS NOT NULL GROUP BY unsub_campaign_id`,
    sql`WITH w AS (SELECT generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') AS week)
      SELECT to_char(w.week, 'YYYY-MM-DD') AS week,
        (SELECT count(*) FROM insights_newsletter_subscribers s WHERE s.account_id = ${accountId} AND s.created_at >= w.week AND s.created_at < w.week + interval '1 week') AS subscribed,
        (SELECT count(*) FROM insights_newsletter_subscribers s WHERE s.account_id = ${accountId} AND s.status = 'unsubscribed'
          AND coalesce(s.unsub_at, s.updated_at) >= w.week AND coalesce(s.unsub_at, s.updated_at) < w.week + interval '1 week') AS unsubscribed
      FROM w ORDER BY w.week`,
  ]);
  const ev = new Map(events.map((r) => [String(r.campaign_id), r]));
  const un = new Map(unsubs.map((r) => [String(r.campaign_id), Number(r.n ?? 0)]));
  // Sales from newsletter visits: only for a Shopify store, read from Shopify, never estimated.
  let sales: { orders: number; revenue: number; currency: string | null; days: number; capped: boolean; byCampaign: Map<string, { orders: number; revenue: number }> } | "access" | "failed" | null = null;
  try {
    const got = await salesFor(accountId);
    if (got === "access") sales = "access";
    else if (got) {
      // Summed from every newsletter order (the sources list folds small sources into Other).
      const list = got.newsletter ?? [];
      const src = { orders: list.reduce((n, x) => n + x.orders, 0), revenue: list.reduce((n, x) => n + x.revenue, 0) };
      const byCampaign = new Map<string, { orders: number; revenue: number }>();
      for (const n of got.newsletter ?? []) {
        const id = slugCampaign(n.campaign);
        if (!id) continue;
        const cur = byCampaign.get(id) ?? { orders: 0, revenue: 0 };
        byCampaign.set(id, { orders: cur.orders + n.orders, revenue: cur.revenue + n.revenue });
      }
      sales = { orders: src.orders, revenue: src.revenue, currency: got.currency, days: got.days, capped: Boolean(got.capped), byCampaign };
    }
  } catch {
    sales = "failed";
  }
  const rows: CampaignRow[] = camps.map((c) => {
    const m = metricsOf({ ...(ev.get(String(c.id)) ?? {}), sent: c.sent, unsubscribed: String(un.get(String(c.id)) ?? 0) });
    return {
      id: String(c.id),
      subject: c.subject ?? "",
      kind: c.kind === "welcome" || c.kind === "weekly" ? c.kind : "campaign",
      auto: c.auto === "t" || c.auto === "true",
      at: iso(c.at),
      metrics: m,
      rates: metricRates(m),
      sales: sales && typeof sales === "object" ? sales.byCampaign.get(String(c.id)) ?? { orders: 0, revenue: 0 } : null,
    };
  });
  // Every email ever sent counts in the totals, not only the 30 listed.
  const [tot] = await sql`SELECT (SELECT count(*) FROM insights_newsletter_sends WHERE account_id = ${accountId} AND status = 'sent') AS sent,
      (SELECT count(*) FROM insights_newsletter_subscribers WHERE account_id = ${accountId} AND unsub_campaign_id IS NOT NULL) AS unsubscribed`;
  let total = metricsOf({ sent: tot?.sent ?? "0", unsubscribed: tot?.unsubscribed ?? "0" });
  for (const r of events) total = addMetrics(total, { ...metricsOf(r), sent: 0, unsubscribed: 0 });
  return {
    total,
    rates: metricRates(total),
    campaigns: rows,
    growth: weekSeries(growth.map((g) => ({ week: g.week ?? "", subscribed: Number(g.subscribed ?? 0), unsubscribed: Number(g.unsubscribed ?? 0) }))),
    sales: sales && typeof sales === "object" ? { orders: sales.orders, revenue: sales.revenue, currency: sales.currency, days: sales.days, capped: sales.capped } : sales,
    tracking: { events: events.length > 0 },
  };
}

/** The Newsletter's line on the agents' scorecard: what went out (and how much of it on its own), and what came of it. */
export async function newsletterScore(accountId: string): Promise<{ agent: string; did: string; result: string | null } | null> {
  await schema();
  const [r] = await sql`SELECT count(*) FILTER (WHERE x.status = 'sent') AS sent,
      count(*) FILTER (WHERE x.status = 'sent' AND (c.auto OR c.kind = 'welcome')) AS auto,
      count(DISTINCT x.campaign_id) FILTER (WHERE x.status = 'sent') AS emails
    FROM insights_newsletter_sends x JOIN insights_newsletter_campaigns c ON c.id = x.campaign_id
    WHERE x.account_id = ${accountId} AND x.sent_at > now() - interval '30 days'`;
  const sent = Number(r?.sent ?? 0);
  if (!sent) return null;
  const [e] = await sql`SELECT count(DISTINCT (campaign_id, subscriber_id)) FILTER (WHERE type = 'email.opened') AS opened,
      count(DISTINCT (campaign_id, subscriber_id)) FILTER (WHERE type = 'email.clicked') AS clicked
    FROM insights_newsletter_events WHERE account_id = ${accountId} AND campaign_id IS NOT NULL AND at > now() - interval '30 days'`;
  const opened = Number(e?.opened ?? 0);
  const clicked = Number(e?.clicked ?? 0);
  const auto = Number(r?.auto ?? 0);
  return {
    agent: "Newsletter",
    did: `${sent.toLocaleString("en-US")} emails sent in the last 30 days (${Number(r?.emails ?? 0)} different), ${auto.toLocaleString("en-US")} of them automatic`,
    result: opened || clicked
      ? `${opened.toLocaleString("en-US")} opened (approximate) and ${clicked.toLocaleString("en-US")} clicked, from Resend's reports.`
      : "No opens or clicks reported yet. They need Resend's webhook and tracking turned on.",
  };
}

// ---------- sending (the hourly run) ----------

/**
 * Sites with an email to send now and room left in today's cap, the one whose turn came longest ago first, so a site
 * at its daily cap never takes the turns of the others. A scheduled email counts from its time on; the welcome email
 * only while it is turned on and someone new is waiting for it (or a batch is waiting for Resend's answer).
 */
export async function accountsDueForNewsletter(limit = 5): Promise<string[]> {
  await schema();
  const rows = await sql`SELECT c.account_id, max(c.last_run_at) AS at FROM insights_newsletter_campaigns c
    LEFT JOIN insights_newsletter_settings st ON st.account_id = c.account_id
    WHERE c.status IN ('approved', 'sending') AND (c.scheduled_at IS NULL OR c.scheduled_at <= now())
      AND (c.kind <> 'welcome'
        OR EXISTS (SELECT 1 FROM insights_newsletter_sends x WHERE x.campaign_id = c.id AND x.status = 'pending')
        OR (coalesce(st.welcome_on, false) AND st.welcome_since IS NOT NULL AND EXISTS (SELECT 1 FROM insights_newsletter_subscribers s
          WHERE s.account_id = c.account_id AND s.status = 'subscribed' AND s.welcomed_at IS NULL AND s.created_at >= st.welcome_since
            AND NOT EXISTS (SELECT 1 FROM insights_newsletter_sends x WHERE x.campaign_id = c.id AND x.subscriber_id = s.id))))
      AND (SELECT count(*) FROM insights_newsletter_sends x WHERE x.account_id = c.account_id AND x.status IN ('pending', 'sent', 'unknown')
        AND x.sent_at >= ((now() AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC')) < coalesce(st.daily_cap, ${DEFAULT_DAILY_CAP})
    GROUP BY c.account_id ORDER BY max(c.last_run_at) NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}

export type ResendSender = (key: string, path: "/emails" | "/emails/batch", payload: unknown, idempotencyKey: string) => Promise<ResendAnswer>;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * One run at a time per site. The database is reached over HTTP (a new connection each query), so a Postgres advisory
 * lock would not hold between queries; a lease row does, and frees itself after 15 minutes if a run dies.
 */
async function takeLease(accountId: string): Promise<string | null> {
  const token = crypto.randomBytes(16).toString("base64url");
  const [row] = await sql`INSERT INTO insights_settings (key, value) VALUES (${`newsletter_lock:${accountId}`}, ${token})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    WHERE insights_settings.updated_at < now() - interval '15 minutes' RETURNING key`;
  return row ? token : null;
}
/** Frees the lease only if it is still this run's (a run that outlived its lease never frees the next run's). */
const dropLease = (accountId: string, token: string) =>
  sql`DELETE FROM insights_settings WHERE key = ${`newsletter_lock:${accountId}`} AND value = ${token}`;

/**
 * Sends the site's emails that are due (the welcome email first, then approved emails oldest first) to the next people
 * on its list, in batches of up to 100, within the daily cap. Each person is claimed (with the batch's idempotency
 * key) before the call, so nobody gets an email twice; a batch with no clear answer is sent again with the same key,
 * which Resend never delivers twice. A failure stops the run and goes on the status board for the Inspector.
 */
export async function runNewsletter(accountId: string, deadline = Date.now() + 60_000, send: ResendSender = resendPost, wait: (ms: number) => Promise<void> = sleep): Promise<string | null> {
  await schema();
  if (isSabbath()) return null;
  const lease = await takeLease(accountId);
  if (!lease) return "another run is sending for this site";
  try {
    const s = await readSettings(accountId);
    const due = await sql`SELECT * FROM insights_newsletter_campaigns WHERE account_id = ${accountId} AND status IN ('approved', 'sending')
      AND (scheduled_at IS NULL OR scheduled_at <= now()) ORDER BY (kind = 'welcome') DESC, approved_at LIMIT 10`;
    if (!due.length) return null;
    await sql`UPDATE insights_newsletter_campaigns SET last_run_at = now() WHERE account_id = ${accountId} AND status IN ('approved', 'sending')`;
    const budget = { runLeft: PER_RUN, calls: 0 };
    const notes: string[] = [];
    for (const c of due) {
      // The welcome email waits while the owner has it turned off; nothing else about it changes.
      if (c.kind === "welcome" && (!s.welcomeOn || !s.welcomeSince)) continue;
      const r = await sendCampaign(accountId, c, s, deadline, send, wait, budget);
      notes.push(`${c.kind === "welcome" ? "welcome" : `email ${c.id}`}: ${r.note}`);
      if (!r.more || Date.now() > deadline || budget.runLeft <= 0) break;
    }
    return notes.join("; ") || null;
  } finally {
    await dropLease(accountId, lease).catch(() => undefined);
  }
}

interface Person {
  id: string;
  email: string;
  token: string;
}

/** What one email's turn did, and whether the run may go on to the next email. */
interface Turn {
  note: string;
  more: boolean;
}

async function sendCampaign(
  accountId: string,
  c: Record<string, string | null>,
  s: Settings,
  deadline: number,
  send: ResendSender,
  wait: (ms: number) => Promise<void>,
  budget: { runLeft: number; calls: number },
): Promise<Turn> {
  const cid = String(c.id);
  const welcome = c.kind === "welcome";
  const missing = missingSetup(s);
  const fail = async (why: string, final: boolean) => {
    await sql`UPDATE insights_newsletter_campaigns SET last_error = ${why.slice(0, 500)}, status = CASE WHEN ${final ? "1" : "0"}::text = '1' AND status = 'sending' THEN 'failed' ELSE status END
      WHERE id = ${cid} AND account_id = ${accountId}`.catch(() => undefined);
    await report("newsletter", false, `Newsletter for account ${accountId}: ${why}`);
  };
  const stop = (note: string): Turn => ({ note, more: false });
  const toSending = () => sql`UPDATE insights_newsletter_campaigns SET status = 'sending' WHERE id = ${cid} AND account_id = ${accountId} AND status = 'approved'`;
  if (missing.length) {
    await toSending();
    await fail(`Sending waits: add ${missing.join(", ")} in Newsletter settings.`, true);
    return stop(`waiting for setup (${missing.join(", ")})`);
  }
  const origin = c.origin || s.origin;
  if (!origin) {
    await toSending();
    await fail("The unsubscribe address is missing. Approve the email again.", true);
    return stop("no unsubscribe address");
  }
  if (c.status === "approved") {
    await toSending();
    // An email the agent approved on the owner's standing permission shows on the team board when it starts.
    if (c.auto === "t" || c.auto === "true") await postNote(accountId, "Newsletter", "did", `Started sending "${c.subject ?? ""}" on its own, as you allowed in Newsletter settings.`, { ref: `newsletter:auto:${cid}` });
  }
  const profile = await readProfile(accountId).catch(() => null);
  const brand = s.fromName || profile?.brandName || profile?.siteDomain || "us";
  const from = fromHeader(s.fromName, s.fromAddress);
  const domain = s.fromAddress.split("@")[1];
  const utm = { domain: profile?.siteDomain ?? null, slug: campaignSlug(cid, c.subject ?? "") };
  const emailFor = (p: Person) =>
    buildEmail({
      from,
      replyTo: s.replyTo || null,
      to: p.email,
      subject: c.subject ?? "",
      preview: c.preview ?? "",
      body: c.body ?? "",
      brand,
      postalAddress: s.postalAddress,
      unsubscribe: unsubscribeUrl(origin, p.token, cid),
      utm,
    });
  const stillSending = async () => {
    const [x] = await sql`SELECT status FROM insights_newsletter_campaigns WHERE id = ${cid} AND account_id = ${accountId}`;
    return x?.status === "sending";
  };
  const inIds = (ids: string[]) => ids.join(",");
  const drop = (ids: string[]) =>
    ids.length ? sql`DELETE FROM insights_newsletter_sends WHERE campaign_id = ${cid} AND status = 'pending' AND subscriber_id = ANY(string_to_array(${inIds(ids)}, ',')::bigint[])` : Promise.resolve([]);
  const welcomed = (ids: string[]) =>
    welcome && ids.length
      ? sql`UPDATE insights_newsletter_subscribers SET welcomed_at = coalesce(welcomed_at, now()) WHERE account_id = ${accountId} AND id = ANY(string_to_array(${inIds(ids)}, ',')::bigint[])`
      : Promise.resolve([]);
  const mark = async (ids: string[], status: "unknown" | "failed", note: string | null = null) => {
    if (!ids.length) return;
    await sql`UPDATE insights_newsletter_sends SET status = ${status}, note = ${note} WHERE campaign_id = ${cid} AND status = 'pending' AND subscriber_id = ANY(string_to_array(${inIds(ids)}, ',')::bigint[])`;
    // A welcome email that may have reached them counts as sent: nobody is welcomed twice.
    if (status === "unknown") await welcomed(ids);
  };
  /** Rows that stay pending (to be sent again with their key) remember what their own attempt got. */
  const keepPending = (ids: string[], status: number | null) =>
    ids.length
      ? sql`UPDATE insights_newsletter_sends SET last_status = ${status ?? 0} WHERE campaign_id = ${cid} AND status = 'pending' AND subscriber_id = ANY(string_to_array(${inIds(ids)}, ',')::bigint[])`
      : Promise.resolve([]);
  let sentNow = 0;
  const markSent = async (pairs: { id: string; rid: string | null }[]) => {
    await sql`UPDATE insights_newsletter_sends x SET status = 'sent', resend_id = y.rid, sent_at = now()
      FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS y(id bigint, rid text)
      WHERE x.campaign_id = ${cid} AND x.subscriber_id = y.id AND x.status = 'pending'`;
    await welcomed(pairs.map((p) => p.id));
    sentNow += pairs.length;
    budget.runLeft -= pairs.length;
  };
  // Paced, and a rate limit's Retry-After is waited out within the run's time.
  const call = async (path: "/emails" | "/emails/batch", payload: unknown, key: string): Promise<ResendAnswer> => {
    for (let tries = 0; ; tries++) {
      if (budget.calls++ > 0) await wait(BATCH_PAUSE_MS);
      const r = await send(s.resendKey!, path, payload, key);
      const ra = r.status === 429 ? retryAfterMs(r.retryAfter) ?? 1_000 : null;
      if (ra === null || tries >= 2 || Date.now() + ra + 5_000 > deadline) return r;
      await wait(ra);
    }
  };
  const refusedWhy = (why: string) => `Resend refused the emails (${why}). Check your Resend key and that ${domain} is verified in Resend, then click Try again.`;
  const idsFromBatch = (r: ResendAnswer) => ((r.body as { data?: { id?: string }[] } | null)?.data ?? []).map((x) => x?.id ?? null);
  const idFromOne = (r: ResendAnswer) => (r.body as { id?: string } | null)?.id ?? null;

  // 1. Batches with no clear answer from an earlier run: exactly those rows again, with the same key, within 24 hours.
  const unanswered = await sql`SELECT batch_key, min(sent_at) AS at, string_agg(subscriber_id::text, ',' ORDER BY subscriber_id) AS ids,
      bool_and(last_status = 422) AS own422
    FROM insights_newsletter_sends WHERE campaign_id = ${cid} AND status = 'pending' GROUP BY batch_key ORDER BY min(sent_at) LIMIT 100`;
  for (const g of unanswered) {
    const ids = String(g.ids ?? "").split(",").filter(Boolean);
    const key = g.batch_key;
    const at = Date.parse(iso(g.at) ?? "");
    if (!key || Number.isNaN(at) || pendingAction(at) === "unknown") {
      // Past the 24 hours Resend remembers a key (or no key at all): they may have got it, so they never get it again.
      await mark(ids, "unknown", "No clear answer from Resend within 24 hours");
      continue;
    }
    if (Date.now() > deadline || isSabbath() || budget.runLeft <= 0) return stop(`${sentNow} sent; the rest goes next hour`);
    // Within today's cap: rows claimed on an earlier day count as new sends today.
    if (!resendFits(ids.length, at, allowance(s.dailyCap, await sentToday(accountId)), budget.runLeft)) {
      return stop(budget.runLeft < ids.length ? `${sentNow} sent; the rest goes next hour` : `${sentNow} sent, daily limit reached; the rest goes tomorrow`);
    }
    if (!(await stillSending())) return { note: `${sentNow} sent, then paused`, more: true };
    const rows = await sql`SELECT id, email, token, status FROM insights_newsletter_subscribers WHERE account_id = ${accountId}
      AND id = ANY(string_to_array(${inIds(ids)}, ',')::bigint[]) ORDER BY id`;
    // Someone who unsubscribed meanwhile is never emailed again; the first try may have reached them already.
    const people: Person[] = rows.filter((r) => r.status === "subscribed").map((r) => ({ id: String(r.id), email: r.email ?? "", token: r.token ?? "" }));
    await mark(ids.filter((id) => !people.some((p) => p.id === id)), "unknown", "Unsubscribed before Resend answered");
    if (!people.length) continue;
    const single = isSingleKey(key);
    const r = await call(single ? "/emails" : "/emails/batch", single ? emailFor(people[0]) : people.map(emailFor), key);
    if (r.ok) {
      const got = single ? [idFromOne(r)] : idsFromBatch(r);
      await markSent(people.map((p, i) => ({ id: p.id, rid: got[i] ?? null })));
      continue;
    }
    const why = resendWhy(r);
    const kind = failureKind(r.status);
    const pids = people.map((p) => p.id);
    if (kind === "invalid" && (String(g.own422) === "t" || String(g.own422) === "true")) {
      // The row's own first attempt was refused the same way, so it never went out: the claims go and are made again.
      await drop(pids);
      continue;
    }
    if ((r.status === 409 && !/concurrent/i.test(why)) || kind === "invalid") {
      // The same key with a different request, or a refusal Resend gives before it looks the key up (the list or the
      // settings changed): it can't be known whether the first try went out, so these people are never sent it again.
      await mark(pids, "unknown", `Resend: ${why}`);
      continue;
    }
    await keepPending(pids, r.status);
    if (kind === "fatal") await fail(refusedWhy(why), true);
    else await fail(`Resend gave no clear answer or asked to wait (${why}). The same emails are sent again next hour; nobody gets one twice.`, false);
    return stop(`${sentNow} sent, then stopped: ${why}`);
  }

  // 2. The next people, claimed with a fresh key, a batch at a time.
  while (budget.runLeft > 0 && Date.now() < deadline && !isSabbath()) {
    // Counted again before every batch, so the cap holds whatever else was sent today.
    const left = allowance(s.dailyCap, await sentToday(accountId));
    if (!left) return stop(`${sentNow} sent, daily limit reached; the rest goes tomorrow`);
    const size = batchSizes(Number.MAX_SAFE_INTEGER, left, budget.runLeft)[0] ?? 0;
    if (!size) break;
    const key = batchKey(cid);
    // Claimed only while the email is still sending, so Pause stops the next batch at once. A campaign goes to who was
    // subscribed when it was approved; the welcome email to who joined since it was first turned on and was never
    // welcomed (by this or an earlier welcome email).
    const claimed = welcome
      ? await sql`WITH pick AS (
          SELECT s.id FROM insights_newsletter_subscribers s
          WHERE s.account_id = ${accountId} AND s.status = 'subscribed' AND s.welcomed_at IS NULL AND s.created_at >= ${s.welcomeSince}::timestamptz
            AND EXISTS (SELECT 1 FROM insights_newsletter_campaigns k WHERE k.id = ${cid} AND k.account_id = ${accountId} AND k.status = 'sending')
            AND EXISTS (SELECT 1 FROM insights_newsletter_settings st WHERE st.account_id = ${accountId} AND st.welcome_on)
            AND NOT EXISTS (SELECT 1 FROM insights_newsletter_sends x WHERE x.campaign_id = ${cid} AND x.subscriber_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM insights_newsletter_sends x JOIN insights_newsletter_campaigns w ON w.id = x.campaign_id
              WHERE x.subscriber_id = s.id AND w.account_id = ${accountId} AND w.kind = 'welcome' AND x.status IN ('pending', 'sent', 'unknown'))
          ORDER BY s.id LIMIT ${size})
        INSERT INTO insights_newsletter_sends (campaign_id, subscriber_id, account_id, status, batch_key)
        SELECT ${cid}, id, ${accountId}, 'pending', ${key} FROM pick ON CONFLICT DO NOTHING RETURNING subscriber_id`
      : await sql`WITH pick AS (
          SELECT s.id FROM insights_newsletter_subscribers s
          WHERE s.account_id = ${accountId} AND s.status = 'subscribed' AND s.created_at <= ${c.approved_at}::timestamptz
            AND EXISTS (SELECT 1 FROM insights_newsletter_campaigns k WHERE k.id = ${cid} AND k.account_id = ${accountId} AND k.status = 'sending')
            AND NOT EXISTS (SELECT 1 FROM insights_newsletter_sends x WHERE x.campaign_id = ${cid} AND x.subscriber_id = s.id)
          ORDER BY s.id LIMIT ${size})
        INSERT INTO insights_newsletter_sends (campaign_id, subscriber_id, account_id, status, batch_key)
        SELECT ${cid}, id, ${accountId}, 'pending', ${key} FROM pick ON CONFLICT DO NOTHING RETURNING subscriber_id`;
    if (!claimed.length) {
      if (!(await stillSending())) return { note: `${sentNow} sent, then paused`, more: true };
      // The welcome email stays on for the next new subscriber; it is never "done".
      if (welcome) {
        if (sentNow) await postNote(accountId, "Newsletter", "did", `Sent the welcome email to ${sentNow} new ${sentNow === 1 ? "subscriber" : "subscribers"}.`);
        return { note: `${sentNow} welcomed`, more: true };
      }
      // Nobody left to claim. Done once no batch is still waiting for a clear answer from Resend.
      const [open] = await sql`SELECT 1 AS x FROM insights_newsletter_sends WHERE campaign_id = ${cid} AND status = 'pending' LIMIT 1`;
      if (open) break;
      await sql`UPDATE insights_newsletter_campaigns SET status = 'sent', finished_at = now(), last_error = NULL
        WHERE id = ${cid} AND account_id = ${accountId} AND status = 'sending'`;
      await report("newsletter", true);
      const [t] = await sql`SELECT count(*) AS n FROM insights_newsletter_sends WHERE campaign_id = ${cid} AND status = 'sent'`;
      await postNote(accountId, "Newsletter", "did", `Finished sending "${c.subject ?? ""}" to ${Number(t?.n ?? 0).toLocaleString("en-US")} subscribers${c.auto === "t" || c.auto === "true" ? ", on its own as you allowed" : ""}.`, { ref: `newsletter:done:${cid}` });
      return { note: `${sentNow} sent, the email is done`, more: true };
    }
    const ids = claimed.map((r) => String(r.subscriber_id));
    const rows = await sql`SELECT id, email, token FROM insights_newsletter_subscribers
      WHERE account_id = ${accountId} AND status = 'subscribed' AND id = ANY(string_to_array(${inIds(ids)}, ',')::bigint[]) ORDER BY id`;
    const people: Person[] = rows.map((r) => ({ id: String(r.id), email: r.email ?? "", token: r.token ?? "" }));
    // Unsubscribed in the moment between the claim and now: they are never emailed, and their claim is dropped.
    await drop(ids.filter((id) => !people.some((p) => p.id === id)));
    if (!people.length) continue;
    const pids = people.map((p) => p.id);
    const r = await call("/emails/batch", people.map(emailFor), key);
    if (r.ok) {
      const got = idsFromBatch(r);
      await markSent(people.map((p, i) => ({ id: p.id, rid: got[i] ?? null })));
      continue;
    }
    const why = resendWhy(r);
    const kind = failureKind(r.status);
    if (kind === "unknown") {
      // No clear answer: the rows stay claimed with this key and are sent again with it next hour (Resend never
      // delivers the same key twice), or never, once 24 hours have passed.
      await keepPending(pids, r.status);
      await fail(`Resend gave no clear answer (${why}). The same emails are sent again next hour; nobody gets one twice.`, false);
      return stop(`${sentNow} sent, then stopped: ${why}`);
    }
    if (kind === "retry" || kind === "fatal") {
      // Refused or asked to wait: nothing went out, so the claims go and these people get it later with a new key.
      await drop(pids);
      await fail(kind === "retry" ? `Resend asked to wait (${why}). Sending carries on next hour.` : refusedWhy(why), kind === "fatal");
      return stop(`${sentNow} sent, then stopped: ${why}`);
    }
    // 422: one email of the batch may be the problem (one bad address). They are sent one at a time; a person whose
    // address Resend refuses is skipped, the rest go out.
    // Remembered first: if the run dies partway, the rows not tried yet are known never to have gone out.
    await keepPending(people.map((p) => p.id), 422);
    const stopped = await oneByOne(people, key);
    if (stopped) return stop(stopped);
  }
  await sql`UPDATE insights_newsletter_campaigns SET last_error = NULL WHERE id = ${cid} AND account_id = ${accountId} AND status = 'sending'`;
  await report("newsletter", true);
  return stop(`${sentNow} sent; the rest goes next hour`);

  /** A refused batch, one email at a time. Returns why the run stops, or null to carry on. */
  async function oneByOne(people: Person[], key: string): Promise<string | null> {
    let refusedInARow = 0;
    let streak: string[] = [];
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      const rest = people.slice(i).map((x) => x.id);
      if (Date.now() > deadline || isSabbath()) {
        await drop(rest);
        return `${sentNow} sent; the rest goes next hour`;
      }
      if (!(await stillSending())) {
        await drop(rest);
        return `${sentNow} sent, then paused`;
      }
      const one = singleKey(key, p.id);
      await sql`UPDATE insights_newsletter_sends SET batch_key = ${one}, last_status = NULL WHERE campaign_id = ${cid} AND subscriber_id = ${p.id} AND status = 'pending'`;
      const r = await call("/emails", emailFor(p), one);
      if (r.ok) {
        refusedInARow = 0;
        streak = [];
        await markSent([{ id: p.id, rid: idFromOne(r) }]);
        continue;
      }
      const why = resendWhy(r);
      const kind = failureKind(r.status);
      if (kind === "invalid" && addressProblem(r.body, r.text)) {
        // Only this send is marked failed; the subscriber stays as they are (real bounces come from Resend's webhook).
        await mark([p.id], "failed", `Resend: ${why}`);
        refusedInARow++;
        streak.push(p.id);
        if (refusedInARow >= ADDRESS_REFUSAL_LIMIT) {
          // Several addresses in a row refused and none accepted: something in the setup, not the list. Stop here,
          // and free this streak too, so those people get the email after Try again.
          await sql`DELETE FROM insights_newsletter_sends WHERE campaign_id = ${cid} AND status = 'failed' AND subscriber_id = ANY(string_to_array(${inIds(streak)}, ',')::bigint[])`;
          await drop(rest.slice(1));
          await fail(`Resend refused ${ADDRESS_REFUSAL_LIMIT} addresses in a row (${why}). Check the email and your Resend settings, then click Try again.`, true);
          return `${sentNow} sent, then stopped: ${why}`;
        }
        continue;
      }
      if (kind === "unknown") {
        await keepPending([p.id], r.status);
        // This one stays claimed with its own key and is sent again next hour; the ones not tried yet are freed.
        await drop(rest.slice(1));
        await fail(`Resend gave no clear answer (${why}). The same email is sent again next hour; nobody gets one twice.`, false);
        return `${sentNow} sent, then stopped: ${why}`;
      }
      await drop(rest);
      await fail(kind === "retry" ? `Resend asked to wait (${why}). Sending carries on next hour.` : refusedWhy(why), kind !== "retry");
      return `${sentNow} sent, then stopped: ${why}`;
    }
    return null;
  }
}
