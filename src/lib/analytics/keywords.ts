import crypto from "crypto";
import type { Connection } from "./connection";
import { ensureSchema, hasDatabase, sql } from "./db";
import { ADS_SCOPE, GoogleApiError, googleRequest, hasScope, type GoogleAuth } from "./google-auth";
import type { Competition, KeywordIdea, KeywordStatus } from "./keyword-options";
import { tokenSecret } from "./oauth-client";
import { decrypt, encrypt } from "./secrets";

/**
 * Google Keyword Planner data through the Google Ads API: keyword ideas
 * and search volume. Needs a Google Ads developer token, a Google Ads
 * account ID, and a connection that granted the adwords scope.
 */

const SETTING_KEY = "google_ads";
const CACHE_HOURS = 24;

interface AdsSettings {
  developerToken?: string;
  customerId?: string;
  loginCustomerId?: string;
}

const apiBase = () => `https://googleads.googleapis.com/${process.env.GOOGLE_ADS_API_VERSION || "v26"}`;
const digits = (id?: string) => id?.replace(/\D/g, "") || undefined;

async function readSettings(): Promise<AdsSettings> {
  let stored: AdsSettings = {};
  if (hasDatabase()) {
    await ensureSchema();
    const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${SETTING_KEY}`;
    const json = row?.value ? decrypt(row.value, await tokenSecret()) : null;
    if (json) stored = JSON.parse(json);
  }
  return {
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN || stored.developerToken,
    customerId: digits(process.env.GOOGLE_ADS_CUSTOMER_ID) || stored.customerId,
    loginCustomerId: digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) || stored.loginCustomerId,
  };
}

export async function saveAdsSettings(patch: AdsSettings): Promise<void> {
  if (!hasDatabase()) throw new Error("A database is needed to save Google Ads settings.");
  const current = await readSettings();
  const next: AdsSettings = { ...current };
  if (patch.developerToken !== undefined) next.developerToken = patch.developerToken.trim() || undefined;
  if (patch.customerId !== undefined) next.customerId = digits(patch.customerId);
  if (patch.loginCustomerId !== undefined) next.loginCustomerId = digits(patch.loginCustomerId);
  // A new token or manager account can change which accounts are reachable.
  if (patch.developerToken !== undefined || patch.loginCustomerId !== undefined) {
    if (patch.customerId === undefined) next.customerId = undefined;
  }
  const value = encrypt(JSON.stringify(next), await tokenSecret());
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${SETTING_KEY}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** Turns Google Ads API errors into a plain next step. */
export function explainAdsError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const raw = err instanceof GoogleApiError ? `${err.message} ${JSON.stringify(err.details)}` : err.message;
  if (raw.includes("DEVELOPER_TOKEN_NOT_APPROVED")) {
    return "Your developer token only has test access. In Google Ads, open Admin, then API Center, and apply for Basic access. Keyword data works once Google approves it.";
  }
  if (raw.includes("DEVELOPER_TOKEN_INVALID") || raw.includes("DEVELOPER_TOKEN_PROHIBITED")) {
    return "Google didn't accept that developer token. Copy it again from Google Ads, under Admin, then API Center.";
  }
  if (raw.includes("has not been used in project") || raw.includes("SERVICE_DISABLED")) {
    return "The Google Ads API is turned off in your Google Cloud project. Enable it under APIs & Services, then try again in a few minutes.";
  }
  if (raw.includes("USER_PERMISSION_DENIED")) {
    return "Your Google account can't reach that Ads account directly. If it sits under a manager account, add the manager account ID.";
  }
  if (raw.includes("CUSTOMER_NOT_ENABLED")) {
    return "That Google Ads account isn't active yet. Finish setting it up in Google Ads, then try again.";
  }
  if (raw.includes("insufficient authentication scopes") || raw.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
    return "Reconnect your Google account to allow Keyword Planner access.";
  }
  return err.message;
}

function adsHeaders(s: AdsSettings): Record<string, string> {
  const headers: Record<string, string> = { "developer-token": s.developerToken! };
  if (s.loginCustomerId) headers["login-customer-id"] = s.loginCustomerId;
  return headers;
}

async function listAccounts(auth: GoogleAuth, s: AdsSettings): Promise<string[]> {
  const body = await googleRequest<{ resourceNames?: string[] }>(
    auth,
    `${apiBase()}/customers:listAccessibleCustomers`,
    undefined,
    adsHeaders(s)
  );
  return (body.resourceNames ?? []).map((r) => r.replace("customers/", ""));
}

export async function keywordStatus(conn: Connection | null): Promise<KeywordStatus> {
  if (!conn) return { step: "connect" };
  const auth: GoogleAuth = { kind: "oauth", refreshToken: conn.refreshToken };
  if (!(await hasScope(auth, ADS_SCOPE))) return { step: "reconnect" };

  const s = await readSettings();
  if (!s.developerToken) return { step: "token" };

  let accounts: string[];
  try {
    accounts = await listAccounts(auth, s);
  } catch (err) {
    return { step: "token", error: explainAdsError(err), loginCustomerId: s.loginCustomerId };
  }
  if (!s.customerId) {
    if (accounts.length === 1) {
      await saveAdsSettings({ customerId: accounts[0] });
      return { step: "ready", customerId: accounts[0], loginCustomerId: s.loginCustomerId, accounts };
    }
    return {
      step: "account",
      accounts,
      loginCustomerId: s.loginCustomerId,
      error: accounts.length ? undefined : "This Google account has no Google Ads accounts. Create one at ads.google.com (no ads or billing needed), then reload.",
    };
  }
  return { step: "ready", accounts, customerId: s.customerId, loginCustomerId: s.loginCustomerId };
}

/** Whether keyword research is fully set up, without calling Google Ads. */
export async function keywordsReady(conn: Connection | null): Promise<boolean> {
  if (!conn) return false;
  const s = await readSettings();
  if (!s.developerToken || !s.customerId) return false;
  return hasScope({ kind: "oauth", refreshToken: conn.refreshToken }, ADS_SCOPE).catch(() => false);
}

interface Metrics {
  avgMonthlySearches?: string;
  competition?: Competition;
  competitionIndex?: string;
  lowTopOfPageBidMicros?: string;
  highTopOfPageBidMicros?: string;
  monthlySearchVolumes?: { month: string; year: string; monthlySearches?: string }[];
}

const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
const toNum = (v?: string) => (v === undefined ? null : Number(v));
const micros = (v?: string) => (v === undefined ? null : Number(v) / 1_000_000);

function toIdea(keyword: string, m: Metrics = {}): KeywordIdea {
  return {
    keyword,
    avgMonthlySearches: toNum(m.avgMonthlySearches),
    competition: m.competition ?? "UNKNOWN",
    competitionIndex: toNum(m.competitionIndex),
    lowBid: micros(m.lowTopOfPageBidMicros),
    highBid: micros(m.highTopOfPageBidMicros),
    trend: (m.monthlySearchVolumes ?? []).map((v) => ({
      month: `${v.year}-${String(MONTHS.indexOf(v.month) + 1).padStart(2, "0")}`,
      searches: Number(v.monthlySearches ?? 0),
    })),
  };
}

export interface KeywordQuery {
  keywords: string[];
  url?: string;
  geo: string;
  language: string;
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cacheKey = `kw:${crypto.createHash("sha256").update(key).digest("hex")}`;
  const [row] = await sql`
    SELECT data FROM insights_report_cache
    WHERE cache_key = ${cacheKey} AND fetched_at > now() - make_interval(hours => ${CACHE_HOURS})`;
  if (row?.data) return JSON.parse(row.data) as T;
  const data = await load();
  await sql`
    INSERT INTO insights_report_cache (cache_key, data, fetched_at)
    VALUES (${cacheKey}, ${JSON.stringify(data)}::jsonb, now())
    ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data, fetched_at = now()`.catch(() => undefined);
  return data;
}

async function adsCall<T>(conn: Connection, method: string, body: Record<string, unknown>): Promise<T> {
  const s = await readSettings();
  if (!s.developerToken || !s.customerId) throw new Error("Finish the Keyword Planner setup first.");
  const auth: GoogleAuth = { kind: "oauth", refreshToken: conn.refreshToken };
  await ensureSchema();
  return cached(`${s.customerId}|${method}|${JSON.stringify(body)}`, () =>
    googleRequest<T>(auth, `${apiBase()}/customers/${s.customerId}:${method}`, body, adsHeaders(s))
  );
}

const targeting = (q: KeywordQuery) => ({
  language: `languageConstants/${q.language}`,
  ...(q.geo ? { geoTargetConstants: [`geoTargetConstants/${q.geo}`] } : {}),
  keywordPlanNetwork: "GOOGLE_SEARCH",
});

/** Keyword ideas from seed keywords, a website address, or both. */
export async function keywordIdeas(conn: Connection, q: KeywordQuery): Promise<KeywordIdea[]> {
  const keywords = q.keywords.slice(0, 20);
  const url = q.url ? (/^https?:\/\//.test(q.url) ? q.url : `https://${q.url}`) : undefined;
  const seed = url && keywords.length
    ? { keywordAndUrlSeed: { url, keywords } }
    : url
      ? { urlSeed: { url } }
      : { keywordSeed: { keywords } };

  const body = await adsCall<{ results?: { text: string; keywordIdeaMetrics?: Metrics }[] }>(
    conn,
    "generateKeywordIdeas",
    { ...targeting(q), includeAdultKeywords: false, pageSize: 200, ...seed }
  );
  return (body.results ?? [])
    .map((r) => toIdea(r.text, r.keywordIdeaMetrics))
    .sort((a, b) => (b.avgMonthlySearches ?? -1) - (a.avgMonthlySearches ?? -1));
}

/** Search volume and competition for an exact list of keywords. */
export async function keywordVolumes(conn: Connection, q: KeywordQuery): Promise<KeywordIdea[]> {
  const keywords = [...new Set(q.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean))].slice(0, 1000);
  const body = await adsCall<{ results?: { text: string; keywordMetrics?: Metrics }[] }>(
    conn,
    "generateKeywordHistoricalMetrics",
    { ...targeting(q), keywords }
  );
  const found = new Map((body.results ?? []).map((r) => [r.text.toLowerCase(), toIdea(r.text, r.keywordMetrics)]));
  return keywords.map((k) => found.get(k) ?? toIdea(k));
}
