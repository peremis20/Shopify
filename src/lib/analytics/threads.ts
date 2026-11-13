import { randomBytes } from "crypto";
import { ensureSchema, sql } from "./db";
import { tokenSecret } from "./oauth-client";
import { decrypt, encrypt } from "./secrets";
import type { ShareItem } from "./autopilot/share-kit";
import { report } from "./autopilot/status";

/**
 * Posting a site's new articles to the owner's own Threads account (Meta's Threads API).
 * Each site connects its own Threads profile; nothing is posted for any other site or account.
 * A post goes out only when the owner clicks Post to Threads, or when the owner turned on
 * automatic posting for their own account. One post per article, a few a week at most.
 */

const GRAPH = "https://graph.threads.net";
export const THREADS_SCOPES = ["threads_basic", "threads_content_publish", "threads_read_replies", "threads_manage_replies", "threads_keyword_search"];
/** Threads' own limit for one post's text. */
export const THREADS_MAX_CHARS = 500;
/** Posts a site may make from here in seven days, so a feed never reads like a bot. */
export const WEEKLY_POST_CAP = 3;

export interface ThreadsLink {
  token: string;
  userId: string;
  username: string;
  expiresAt: string;
  auto: boolean;
  lastError: string | null;
}

export interface ThreadsPost {
  changeId: string;
  postId: string | null;
  permalink: string | null;
  at: string;
  by: "owner" | "autopilot";
}

async function schema() {
  await ensureSchema();
  await sql`CREATE TABLE IF NOT EXISTS insights_account_threads (
    account_id bigint PRIMARY KEY REFERENCES insights_accounts (id) ON DELETE CASCADE,
    token_enc text NOT NULL,
    user_id text NOT NULL,
    username text NOT NULL,
    expires_at timestamptz NOT NULL,
    auto boolean NOT NULL DEFAULT false,
    last_error text,
    connected_at timestamptz NOT NULL DEFAULT now(),
    refreshed_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS insights_threads_posts (
    id bigserial PRIMARY KEY,
    account_id bigint NOT NULL,
    change_id text NOT NULL,
    post_id text,
    permalink text,
    text text NOT NULL,
    by_whom text NOT NULL DEFAULT 'owner',
    posted_at timestamptz NOT NULL DEFAULT now()
  )`;
  // One post per article, enforced by the database even for two clicks at the same moment.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS insights_threads_posts_once ON insights_threads_posts (account_id, change_id)`;
  // The week's count, raised in one atomic step that refuses once the cap is reached (weeks start Monday, UTC).
  await sql`CREATE TABLE IF NOT EXISTS insights_threads_weekly (
    account_id bigint NOT NULL,
    week date NOT NULL,
    n integer NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, week)
  )`;
  // A connection waiting for the person who allowed it on Threads to confirm which site it is for.
  await sql`CREATE TABLE IF NOT EXISTS insights_threads_pending (
    id text PRIMARY KEY,
    account_id bigint NOT NULL,
    token_enc text NOT NULL,
    user_id text NOT NULL,
    username text NOT NULL,
    expires_in integer NOT NULL,
    return_to text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
}

export async function getThreads(accountId: string): Promise<ThreadsLink | null> {
  await schema();
  const [row] = await sql`SELECT * FROM insights_account_threads WHERE account_id = ${accountId}`;
  if (!row) return null;
  const token = decrypt(String(row.token_enc), await tokenSecret());
  if (!token) return null;
  return {
    token,
    userId: String(row.user_id),
    username: String(row.username),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    auto: row.auto === "t" || row.auto === "true",
    lastError: row.last_error ? String(row.last_error) : null,
  };
}

export async function saveThreads(accountId: string, link: { token: string; userId: string; username: string; expiresIn: number }): Promise<void> {
  await schema();
  const enc = encrypt(link.token, await tokenSecret());
  const expires = new Date(Date.now() + Math.max(link.expiresIn, 3600) * 1000).toISOString();
  // Reconnecting the same profile keeps the owner's automatic posting choice; a different profile starts with it off.
  await sql`
    INSERT INTO insights_account_threads (account_id, token_enc, user_id, username, expires_at)
    VALUES (${accountId}, ${enc}, ${link.userId}, ${link.username}, ${expires})
    ON CONFLICT (account_id) DO UPDATE SET token_enc = EXCLUDED.token_enc, user_id = EXCLUDED.user_id, username = EXCLUDED.username,
      auto = CASE WHEN insights_account_threads.user_id = EXCLUDED.user_id THEN insights_account_threads.auto ELSE false END,
      expires_at = EXCLUDED.expires_at, last_error = NULL, connected_at = now(), refreshed_at = now()`;
}

/** Keeps a fresh Threads connection aside until the person who allowed it confirms the site. Returns its id. */
export async function holdThreads(accountId: string, link: { token: string; userId: string; username: string; expiresIn: number }, returnTo: string): Promise<string> {
  await schema();
  await sql`DELETE FROM insights_threads_pending WHERE created_at < now() - interval '15 minutes'`.catch(() => undefined);
  const id = randomBytes(24).toString("base64url");
  const enc = encrypt(link.token, await tokenSecret());
  await sql`
    INSERT INTO insights_threads_pending (id, account_id, token_enc, user_id, username, expires_in, return_to)
    VALUES (${id}, ${accountId}, ${enc}, ${link.userId}, ${link.username}, ${link.expiresIn}, ${returnTo})`;
  return id;
}

export async function readPending(id: string): Promise<{ accountId: string; username: string; returnTo: string } | null> {
  await schema();
  const [row] = await sql`SELECT account_id, username, return_to FROM insights_threads_pending WHERE id = ${id} AND created_at > now() - interval '15 minutes'`;
  return row ? { accountId: String(row.account_id), username: String(row.username), returnTo: String(row.return_to) } : null;
}

/** Confirmed: the held connection is saved to its account, once. Returns where to go back to, or null. */
export async function confirmPending(id: string): Promise<string | null> {
  await schema();
  const [row] = await sql`DELETE FROM insights_threads_pending WHERE id = ${id} AND created_at > now() - interval '15 minutes' RETURNING *`;
  if (!row) return null;
  const token = decrypt(String(row.token_enc), await tokenSecret());
  if (!token) return null;
  await saveThreads(String(row.account_id), { token, userId: String(row.user_id), username: String(row.username), expiresIn: Number(row.expires_in) });
  return String(row.return_to);
}

export async function dropPending(id: string): Promise<void> {
  await schema();
  await sql`DELETE FROM insights_threads_pending WHERE id = ${id}`;
}

export async function setThreadsAuto(accountId: string, auto: boolean): Promise<void> {
  await schema();
  await sql`UPDATE insights_account_threads SET auto = ${auto} WHERE account_id = ${accountId}`;
}

export async function removeThreads(accountId: string): Promise<void> {
  await schema();
  await sql`DELETE FROM insights_account_threads WHERE account_id = ${accountId}`;
}

/** Meta said this Threads user removed DashPatrol or asked for deletion: every saved access for them goes. */
export async function removeThreadsUser(userId: string): Promise<void> {
  await schema();
  await sql`DELETE FROM insights_account_threads WHERE user_id = ${userId}`;
  await sql`DELETE FROM insights_threads_pending WHERE user_id = ${userId}`;
}

async function noteError(accountId: string, error: string | null): Promise<void> {
  await sql`UPDATE insights_account_threads SET last_error = ${error} WHERE account_id = ${accountId}`.catch(() => undefined);
}

export async function threadsPosts(accountId: string): Promise<ThreadsPost[]> {
  await schema();
  const rows = await sql`SELECT change_id, post_id, permalink, by_whom, posted_at FROM insights_threads_posts WHERE account_id = ${accountId} ORDER BY posted_at DESC LIMIT 30`;
  return rows.map((r) => ({
    changeId: String(r.change_id),
    postId: r.post_id ? String(r.post_id) : null,
    permalink: r.permalink ? String(r.permalink) : null,
    at: new Date(String(r.posted_at)).toISOString(),
    by: r.by_whom === "autopilot" ? "autopilot" : "owner",
  }));
}

/** Posts made from here this week (weeks start Monday, UTC). */
export async function postsThisWeek(accountId: string): Promise<number> {
  await schema();
  const [row] = await sql`SELECT n FROM insights_threads_weekly WHERE account_id = ${accountId} AND week = date_trunc('week', now() AT TIME ZONE 'UTC')::date`;
  return Number(row?.n ?? 0);
}

// ---------- Meta's API ----------

export class ThreadsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
  ) {
    super(message);
  }
}

/**
 * The owner's token expired or was removed: only reconnecting fixes it. Permission errors (codes 10 and 200) are usually
 * the platform's Meta app (not yet approved, or the person isn't a tester), so they go to the Inspector instead.
 */
export const needsReconnect = (e: unknown) => e instanceof ThreadsApiError && (e.code === 190 || e.status === 401);

async function call<T>(path: string, params: Record<string, string>, method: "GET" | "POST" = "GET"): Promise<T> {
  const url = new URL(path.startsWith("http") ? path : `${GRAPH}${path}`);
  const body = new URLSearchParams(params);
  if (method === "GET") url.search = body.toString();
  const res = await fetch(url, {
    method,
    ...(method === "POST" ? { body, headers: { "Content-Type": "application/x-www-form-urlencoded" } } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_user_msg?: string } } & T;
  if (!res.ok || data.error) {
    const err = data.error ?? {};
    throw new ThreadsApiError(`Threads: ${err.error_user_msg || err.message || `error ${res.status}`}`, res.status, typeof err.code === "number" ? err.code : null);
  }
  return data;
}

export function authorizeUrl(appId: string, redirectUri: string, state: string): string {
  const url = new URL("https://threads.net/oauth/authorize");
  url.search = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, scope: THREADS_SCOPES.join(","), response_type: "code", state }).toString();
  return url.toString();
}

/** The code from Threads, swapped for a long lived token (about sixty days) and the profile it belongs to. */
export async function exchangeThreadsCode(app: { id: string; secret: string }, code: string, redirectUri: string) {
  const short = await call<{ access_token: string; user_id: string | number }>(
    "/oauth/access_token",
    { client_id: app.id, client_secret: app.secret, grant_type: "authorization_code", redirect_uri: redirectUri, code },
    "POST",
  );
  const long = await call<{ access_token: string; expires_in: number }>("/access_token", {
    grant_type: "th_exchange_token",
    client_secret: app.secret,
    access_token: short.access_token,
  });
  const me = await call<{ id: string; username: string }>("/v1.0/me", { fields: "id,username", access_token: long.access_token });
  return { token: long.access_token, userId: String(me.id || short.user_id), username: me.username, expiresIn: Number(long.expires_in) || 60 * 86400 };
}

/** Keeps the token alive: refreshed when fewer than ten days are left (Threads allows it once the token is a day old). */
export async function freshLink(accountId: string): Promise<ThreadsLink | null> {
  const link = await getThreads(accountId);
  if (!link) return null;
  const left = Date.parse(link.expiresAt) - Date.now();
  if (left <= 0 || left > 10 * 86400_000) return link;
  try {
    const out = await call<{ access_token: string; expires_in: number }>("/refresh_access_token", { grant_type: "th_refresh_token", access_token: link.token });
    await schema();
    const enc = encrypt(out.access_token, await tokenSecret());
    const expires = new Date(Date.now() + (Number(out.expires_in) || 60 * 86400) * 1000).toISOString();
    await sql`UPDATE insights_account_threads SET token_enc = ${enc}, expires_at = ${expires}, refreshed_at = now() WHERE account_id = ${accountId}`;
    void report("threads", true);
    return { ...link, token: out.access_token, expiresAt: expires };
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`threads token refresh failed for account ${accountId}: ${msg}`);
    if (needsReconnect(e)) await noteError(accountId, "The Threads connection runs out soon. Connect Threads again to keep posting.");
    else void report("threads", false, `Token refresh: ${msg}`);
    return link;
  }
}

/** Where a post failed: before anything was made on Threads, or at the publish step itself. */
class PublishStepError extends Error {
  constructor(
    readonly cause: unknown,
    readonly publishing: boolean,
  ) {
    super((cause as Error).message);
  }
}

/** A text post: made as a container, then published. Returns the post and its public link. */
async function publishText(link: ThreadsLink, text: string): Promise<{ id: string; permalink: string | null }> {
  const container = await call<{ id: string }>(`/v1.0/${link.userId}/threads`, { media_type: "TEXT", text, access_token: link.token }, "POST").catch((e) => {
    throw new PublishStepError(e, false);
  });
  const post = await call<{ id: string }>(`/v1.0/${link.userId}/threads_publish`, { creation_id: container.id, access_token: link.token }, "POST").catch((e) => {
    throw new PublishStepError(e, true);
  });
  const permalink = await call<{ permalink?: string }>(`/v1.0/${post.id}`, { fields: "permalink", access_token: link.token })
    .then((r) => r.permalink ?? null)
    .catch(() => null);
  return { id: post.id, permalink };
}

// ---------- the post itself ----------

/** The article link tagged so Analytics shows visits from Threads as their own source. */
export function taggedUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("utm_source", "threads");
  u.searchParams.set("utm_medium", "social");
  u.searchParams.set("utm_campaign", "dashpatrol_share");
  return u.toString();
}

/**
 * The Threads text for an article: the short post already written and checked for it (the X one fits Threads' limit),
 * with its link tagged. Always ends with the link once; never over Threads' limit.
 */
export function threadsText(item: Pick<ShareItem, "url" | "kit">): string {
  const link = taggedUrl(item.url);
  if (link.length >= THREADS_MAX_CHARS - 1) return item.url.slice(0, THREADS_MAX_CHARS);
  const u = new URL(item.url);
  // Any form of the article's own link (www or not, http or https, trailing slash) is taken out, then the tagged one goes at the end.
  const host = u.hostname.replace(/^www\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const path = u.pathname.replace(/\/$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const own = new RegExp(`https?://(www\\.)?${host}${path}(?![\\w-])/?(\\?[^\\s]*)?`, "gi");
  const words = String(item.kit.x ?? "").replace(own, " ").replace(/\s+/g, " ").trim();
  const room = THREADS_MAX_CHARS - link.length - 1;
  const body = words.length <= room ? words : words.slice(0, Math.max(room, 0)).replace(/\s+\S*$/, "");
  return body ? `${body} ${link}` : link;
}

export type PostResult = { ok: true; post: ThreadsPost } | { ok: false; error: string; status: number };


/**
 * Posts one article's share post to the site's own Threads profile. Claims the article first, so it can never be
 * posted twice, then takes one of the week's posts in one atomic step, so two posts at once can't pass the cap.
 */
export async function postToThreads(
  accountId: string,
  item: Pick<ShareItem, "changeId" | "url" | "kit">,
  by: "owner" | "autopilot",
  publish: (link: ThreadsLink, text: string) => Promise<{ id: string; permalink: string | null }> = publishText,
): Promise<PostResult> {
  const link = await freshLink(accountId);
  if (!link) return { ok: false, status: 400, error: "Connect Threads first." };
  if (Date.parse(link.expiresAt) <= Date.now()) return { ok: false, status: 400, error: "The Threads connection ran out. Connect Threads again." };
  const text = threadsText(item);
  await schema();
  // Also no more than the cap in any seven days, so a Sunday and a Monday can't both be full.
  const [recent] = await sql`SELECT count(*) AS n FROM insights_threads_posts WHERE account_id = ${accountId} AND posted_at > now() - interval '7 days'`;
  if (Number(recent?.n ?? 0) >= WEEKLY_POST_CAP) {
    return { ok: false, status: 429, error: `${WEEKLY_POST_CAP} posts went to Threads in the last seven days, the most allowed. The next one goes out in a few days.` };
  }
  const [slot] = await sql`
    INSERT INTO insights_threads_posts (account_id, change_id, text, by_whom) VALUES (${accountId}, ${item.changeId}, ${text}, ${by})
    ON CONFLICT (account_id, change_id) DO NOTHING RETURNING id, posted_at`;
  if (!slot?.id) return { ok: false, status: 409, error: "This article is already on Threads." };
  const [count] = await sql`
    INSERT INTO insights_threads_weekly (account_id, week, n) VALUES (${accountId}, date_trunc('week', now() AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (account_id, week) DO UPDATE SET n = insights_threads_weekly.n + 1 WHERE insights_threads_weekly.n < ${WEEKLY_POST_CAP}
    RETURNING n`;
  const giveBack = async (counted: boolean) => {
    await sql`DELETE FROM insights_threads_posts WHERE id = ${slot.id}`.catch(() => undefined);
    if (counted) {
      await sql`UPDATE insights_threads_weekly SET n = greatest(n - 1, 0) WHERE account_id = ${accountId} AND week = date_trunc('week', now() AT TIME ZONE 'UTC')::date`.catch(() => undefined);
    }
  };
  if (!count?.n) {
    await giveBack(false);
    return { ok: false, status: 429, error: `${WEEKLY_POST_CAP} posts went to Threads this week, the most allowed. The next one goes out next week.` };
  }
  try {
    const out = await publish(link, text);
    await sql`UPDATE insights_threads_posts SET post_id = ${out.id}, permalink = ${out.permalink} WHERE id = ${slot.id}`.catch(() => undefined);
    await noteError(accountId, null);
    void report("threads", true);
    return { ok: true, post: { changeId: item.changeId, postId: out.id, permalink: out.permalink, at: new Date(String(slot.posted_at)).toISOString(), by } };
  } catch (e) {
    const cause = e instanceof PublishStepError ? e.cause : e;
    const msg = (cause as Error).message;
    console.error(`threads post failed for account ${accountId}: ${msg}`);
    const reconnect = needsReconnect(cause);
    // One site's expired connection is for its owner; anything else may be Threads or the platform's app, so the Inspector sees it.
    if (!reconnect) void report("threads", false, msg);
    // Nothing can be live when Threads clearly refused, or when the post was never made: the article is free to post again.
    const nothingLive = (cause instanceof ThreadsApiError && cause.status < 500) || (e instanceof PublishStepError && !e.publishing);
    if (nothingLive) {
      await giveBack(true);
      await noteError(accountId, reconnect ? "Threads needs to be connected again." : msg);
      return { ok: false, status: 502, error: reconnect ? "Threads needs to be connected again. Nothing was posted." : `Threads didn't post it. Nothing was posted. ${msg}` };
    }
    // No clear answer at the publish step: it may be live, so it isn't posted again blindly.
    await noteError(accountId, "Threads didn't answer clearly on the last post. Check your Threads profile.");
    return { ok: false, status: 502, error: "Threads didn't answer clearly, so it may have been posted. Check your Threads profile." };
  }
}

/**
 * The autopilot's part, once a run: keeps the connection alive, and when the owner turned on automatic posting, posts the
 * newest article from the last two weeks that isn't on Threads yet and that the owner didn't already post by hand.
 * Returns a line for the run summary, or null.
 */
export async function autoPostNext(accountId: string, items: ShareItem[]): Promise<string | null> {
  const link = await freshLink(accountId);
  if (!link?.auto) return null;
  const done = new Set((await threadsPosts(accountId)).map((p) => p.changeId));
  const next = items.find((i) => !i.postedAt && !done.has(i.changeId) && Date.now() - Date.parse(i.at) < 14 * 86400_000);
  if (!next) return null;
  const out = await postToThreads(accountId, next, "autopilot");
  if (out.ok) return `Posted "${next.title}" to Threads.`;
  if (out.status === 429 || out.status === 409) return null;
  throw new Error(out.error);
}
