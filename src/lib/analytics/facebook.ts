import { randomBytes } from "crypto";
import { ensureSchema, sql } from "./db";
import { tokenSecret } from "./oauth-client";
import { decrypt, encrypt } from "./secrets";
import { sitePage } from "./site-crawl";
import type { ShareItem } from "./autopilot/share-kit";
import { report } from "./autopilot/status";
import { shareTarget, taggedUrl } from "./threads";

/**
 * Posting a site's new articles to the owner's own Facebook Page and its linked Instagram business account (Meta's
 * Graph API, through Facebook Login). Each site connects its own Page; nothing is posted for any other site or account.
 * A post goes out only when the owner clicks Post, or when the owner turned on automatic posting for that channel.
 * One post per article per channel, three a week at most per channel, each with a tagged link back to the article.
 */

/** The Graph API version every call uses. */
export const FB_GRAPH_VERSION = "v24.0";
const GRAPH = `https://graph.facebook.com/${FB_GRAPH_VERSION}`;
/** What Facebook Login asks for: the Pages the person manages, posting to one, and publishing to its Instagram account. */
export const FACEBOOK_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish"];
/** Posts a site may make from here in seven days on each channel. */
export const SOCIAL_WEEKLY_CAP = 3;
/** Facebook's limit is far longer; posts stay short. Instagram's caption limit. */
const FACEBOOK_MAX_CHARS = 2000;
export const INSTAGRAM_MAX_CHARS = 2200;

export type MetaChannel = "facebook" | "instagram";

export interface FacebookLink {
  userId: string;
  pageId: string;
  pageName: string;
  token: string;
  igUserId: string | null;
  igUsername: string | null;
  autoFacebook: boolean;
  autoInstagram: boolean;
  lastError: string | null;
}

export interface MetaPost {
  channel: MetaChannel;
  changeId: string;
  postId: string | null;
  permalink: string | null;
  at: string;
  by: "owner" | "autopilot";
}

interface PageChoice {
  id: string;
  name: string;
  token: string;
  igId: string | null;
  igUsername: string | null;
}

async function schema() {
  await ensureSchema();
  await sql`CREATE TABLE IF NOT EXISTS insights_account_facebook (
    account_id bigint PRIMARY KEY REFERENCES insights_accounts (id) ON DELETE CASCADE,
    user_id text NOT NULL,
    page_id text NOT NULL,
    page_name text NOT NULL,
    token_enc text NOT NULL,
    ig_user_id text,
    ig_username text,
    auto_facebook boolean NOT NULL DEFAULT false,
    auto_instagram boolean NOT NULL DEFAULT false,
    last_error text,
    connected_at timestamptz NOT NULL DEFAULT now()
  )`;
  // A connection waiting for the person who allowed it to pick the Page and confirm the site.
  await sql`CREATE TABLE IF NOT EXISTS insights_facebook_pending (
    id text PRIMARY KEY,
    account_id bigint NOT NULL,
    user_id text NOT NULL,
    pages_enc text NOT NULL,
    return_to text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS insights_social_posts (
    id bigserial PRIMARY KEY,
    account_id bigint NOT NULL,
    channel text NOT NULL,
    change_id text NOT NULL,
    post_id text,
    permalink text,
    text text NOT NULL,
    by_whom text NOT NULL DEFAULT 'owner',
    posted_at timestamptz NOT NULL DEFAULT now()
  )`;
  // One post per article and channel, enforced by the database even for two clicks at the same moment.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS insights_social_posts_once ON insights_social_posts (account_id, channel, change_id)`;
  // When each of the last seven days' posts went out, per site and channel. A post takes its place here in one
  // atomic statement that refuses once the cap is reached, so the rolling seven day limit holds even for two at once.
  await sql`CREATE TABLE IF NOT EXISTS insights_social_rolling (
    account_id bigint NOT NULL,
    channel text NOT NULL,
    times timestamptz[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (account_id, channel)
  )`;
  // Why an article was left out on a channel (no image for Instagram), so it isn't tried again every run.
  await sql`CREATE TABLE IF NOT EXISTS insights_social_skips (
    account_id bigint NOT NULL,
    channel text NOT NULL,
    change_id text NOT NULL,
    reason text NOT NULL,
    at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, channel, change_id)
  )`;
}

const yes = (v: unknown) => ["t", "true"].includes(String(v));

export async function getFacebook(accountId: string): Promise<FacebookLink | null> {
  await schema();
  const [row] = await sql`SELECT * FROM insights_account_facebook WHERE account_id = ${accountId}`;
  if (!row) return null;
  const token = decrypt(String(row.token_enc), await tokenSecret());
  if (!token) return null;
  return {
    userId: String(row.user_id),
    pageId: String(row.page_id),
    pageName: String(row.page_name),
    token,
    igUserId: row.ig_user_id ? String(row.ig_user_id) : null,
    igUsername: row.ig_username ? String(row.ig_username) : null,
    autoFacebook: yes(row.auto_facebook),
    autoInstagram: yes(row.auto_instagram),
    lastError: row.last_error ? String(row.last_error) : null,
  };
}

/** Keeps the Pages from a fresh login aside until the person who allowed it picks one and confirms the site. Returns its id. */
export async function holdFacebook(accountId: string, userId: string, pages: PageChoice[], returnTo: string): Promise<string> {
  await schema();
  await sql`DELETE FROM insights_facebook_pending WHERE created_at < now() - interval '15 minutes'`.catch(() => undefined);
  const id = randomBytes(24).toString("base64url");
  const enc = encrypt(JSON.stringify(pages), await tokenSecret());
  await sql`INSERT INTO insights_facebook_pending (id, account_id, user_id, pages_enc, return_to) VALUES (${id}, ${accountId}, ${userId}, ${enc}, ${returnTo})`;
  return id;
}

async function pendingRow(id: string, take: boolean) {
  await schema();
  const [row] = take
    ? await sql`DELETE FROM insights_facebook_pending WHERE id = ${id} AND created_at > now() - interval '15 minutes' RETURNING *`
    : await sql`SELECT * FROM insights_facebook_pending WHERE id = ${id} AND created_at > now() - interval '15 minutes'`;
  if (!row) return null;
  const json = decrypt(String(row.pages_enc), await tokenSecret());
  const pages = json ? (JSON.parse(json) as PageChoice[]) : [];
  return { accountId: String(row.account_id), userId: String(row.user_id), returnTo: String(row.return_to), pages };
}

/** The held login's Pages, without their tokens, for the confirm page. */
export async function readFacebookPending(id: string): Promise<{ accountId: string; returnTo: string; pages: { id: string; name: string; igUsername: string | null }[] } | null> {
  const p = await pendingRow(id, false);
  return p ? { accountId: p.accountId, returnTo: p.returnTo, pages: p.pages.map((x) => ({ id: x.id, name: x.name, igUsername: x.igUsername })) } : null;
}

/** Confirmed: the chosen Page (and its Instagram account) is saved to its account, once. Returns where to go back to, or null. */
export async function confirmFacebookPending(id: string, pageId: string): Promise<string | null> {
  const p = await pendingRow(id, true);
  const page = p?.pages.find((x) => x.id === pageId);
  if (!p || !page) return null;
  const enc = encrypt(page.token, await tokenSecret());
  // Reconnecting the same Page keeps the owner's automatic posting choices; another Page starts with them off.
  await sql`
    INSERT INTO insights_account_facebook (account_id, user_id, page_id, page_name, token_enc, ig_user_id, ig_username)
    VALUES (${p.accountId}, ${p.userId}, ${page.id}, ${page.name}, ${enc}, ${page.igId}, ${page.igUsername})
    ON CONFLICT (account_id) DO UPDATE SET user_id = EXCLUDED.user_id, page_name = EXCLUDED.page_name, token_enc = EXCLUDED.token_enc,
      ig_user_id = EXCLUDED.ig_user_id, ig_username = EXCLUDED.ig_username,
      auto_facebook = CASE WHEN insights_account_facebook.page_id = EXCLUDED.page_id THEN insights_account_facebook.auto_facebook ELSE false END,
      auto_instagram = CASE WHEN insights_account_facebook.page_id = EXCLUDED.page_id THEN insights_account_facebook.auto_instagram ELSE false END,
      page_id = EXCLUDED.page_id, last_error = NULL, connected_at = now()`;
  return p.returnTo;
}

export async function dropFacebookPending(id: string): Promise<void> {
  await schema();
  await sql`DELETE FROM insights_facebook_pending WHERE id = ${id}`;
}

export async function setFacebookAuto(accountId: string, channel: MetaChannel, on: boolean): Promise<void> {
  await schema();
  if (channel === "facebook") await sql`UPDATE insights_account_facebook SET auto_facebook = ${on} WHERE account_id = ${accountId}`;
  else await sql`UPDATE insights_account_facebook SET auto_instagram = ${on} WHERE account_id = ${accountId}`;
}

export async function removeFacebook(accountId: string): Promise<void> {
  await schema();
  await sql`DELETE FROM insights_account_facebook WHERE account_id = ${accountId}`;
}

/** Meta said this Facebook user removed DashPatrol or asked for deletion: every saved access for them goes. */
export async function removeFacebookUser(userId: string): Promise<void> {
  await schema();
  await sql`DELETE FROM insights_account_facebook WHERE user_id = ${userId}`;
  await sql`DELETE FROM insights_facebook_pending WHERE user_id = ${userId}`;
}

async function noteError(accountId: string, error: string | null): Promise<void> {
  await sql`UPDATE insights_account_facebook SET last_error = ${error} WHERE account_id = ${accountId}`.catch(() => undefined);
}

export async function metaPosts(accountId: string): Promise<MetaPost[]> {
  await schema();
  const rows = await sql`SELECT channel, change_id, post_id, permalink, by_whom, posted_at FROM insights_social_posts WHERE account_id = ${accountId} AND channel IN ('facebook', 'instagram') ORDER BY posted_at DESC LIMIT 60`;
  return rows.map((r) => ({
    channel: r.channel === "instagram" ? "instagram" : "facebook",
    changeId: String(r.change_id),
    postId: r.post_id ? String(r.post_id) : null,
    permalink: r.permalink ? String(r.permalink) : null,
    at: new Date(String(r.posted_at)).toISOString(),
    by: r.by_whom === "autopilot" ? "autopilot" : "owner",
  }));
}

export async function metaSkips(accountId: string): Promise<{ channel: MetaChannel; changeId: string; reason: string }[]> {
  await schema();
  const rows = await sql`SELECT channel, change_id, reason FROM insights_social_skips WHERE account_id = ${accountId} ORDER BY at DESC LIMIT 30`;
  return rows.map((r) => ({ channel: r.channel === "instagram" ? "instagram" : "facebook", changeId: String(r.change_id), reason: String(r.reason) }));
}

/** Posts made from here in the last seven days on one channel: the same count that stops a post at the cap. */
export async function metaPostsThisWeek(accountId: string, channel: MetaChannel): Promise<number> {
  await schema();
  const [row] = await sql`
    SELECT (SELECT count(*) FROM unnest(times) t WHERE t > now() - interval '7 days') AS n
    FROM insights_social_rolling WHERE account_id = ${accountId} AND channel = ${channel}`;
  return Number(row?.n ?? 0);
}

// ---------- Meta's API ----------

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
  ) {
    super(message);
  }
}

/** Long lived Page tokens don't run out, but the person can remove the app or change their password: then only reconnecting fixes it. */
export const needsFbReconnect = (e: unknown) => e instanceof MetaApiError && (e.code === 190 || e.status === 401);

async function call<T>(path: string, params: Record<string, string>, method: "GET" | "POST" = "GET"): Promise<T> {
  const url = new URL(path.startsWith("http") ? path : `${GRAPH}${path}`);
  const body = new URLSearchParams(params);
  if (method === "GET") url.search = body.toString();
  const res = await fetch(url, {
    method,
    ...(method === "POST" ? { body, headers: { "Content-Type": "application/x-www-form-urlencoded" } } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_user_msg?: string } } & T;
  if (!res.ok || data.error) {
    const err = data.error ?? {};
    throw new MetaApiError(`${err.error_user_msg || err.message || `error ${res.status}`}`, res.status, typeof err.code === "number" ? err.code : null);
  }
  return data;
}

export function facebookAuthorizeUrl(appId: string, redirectUri: string, state: string): string {
  const url = new URL(`https://www.facebook.com/${FB_GRAPH_VERSION}/dialog/oauth`);
  url.search = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, scope: FACEBOOK_SCOPES.join(","), response_type: "code", state }).toString();
  return url.toString();
}

/**
 * The code from Facebook swapped for a long lived user token, then the Pages that person manages with their own
 * tokens (which don't run out when made from a long lived user token) and each Page's linked Instagram account.
 */
export async function exchangeFacebookCode(app: { id: string; secret: string }, code: string, redirectUri: string): Promise<{ userId: string; pages: PageChoice[] }> {
  const short = await call<{ access_token: string }>("/oauth/access_token", { client_id: app.id, client_secret: app.secret, redirect_uri: redirectUri, code });
  const long = await call<{ access_token: string }>("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: app.id,
    client_secret: app.secret,
    fb_exchange_token: short.access_token,
  });
  const me = await call<{ id: string }>("/me", { fields: "id", access_token: long.access_token });
  const out = await call<{ data?: { id: string; name: string; access_token?: string; instagram_business_account?: { id: string; username?: string } }[] }>("/me/accounts", {
    fields: "id,name,access_token,instagram_business_account{id,username}",
    limit: "100",
    access_token: long.access_token,
  });
  const pages = (out.data ?? [])
    .filter((p) => p.id && p.access_token)
    .map((p) => ({
      id: String(p.id),
      name: String(p.name ?? "Page"),
      token: String(p.access_token),
      igId: p.instagram_business_account?.id ? String(p.instagram_business_account.id) : null,
      igUsername: p.instagram_business_account?.username ? String(p.instagram_business_account.username) : null,
    }));
  return { userId: String(me.id), pages };
}

async function publishFacebook(link: FacebookLink, text: string, url: string): Promise<{ id: string; permalink: string | null }> {
  const post = await call<{ id: string }>(`/${link.pageId}/feed`, { message: text, link: url, access_token: link.token }, "POST");
  const permalink = await call<{ permalink_url?: string }>(`/${post.id}`, { fields: "permalink_url", access_token: link.token })
    .then((r) => r.permalink_url ?? null)
    .catch(() => null);
  return { id: post.id, permalink };
}

/**
 * Waits for an Instagram media container to be ready: a few checks with short waits, never longer than about fifteen
 * seconds. ERROR or EXPIRED, or still not ready at the end, throws a clear refusal (status 400): nothing was published,
 * so the post's place is given back.
 */
export async function waitForContainer(
  check: () => Promise<{ status_code?: string; status?: string }>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  tries = 5,
  waitMs = 3000,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const s = await check();
    const code = String(s.status_code ?? "").toUpperCase();
    if (code === "FINISHED" || code === "PUBLISHED") return;
    if (code === "ERROR" || code === "EXPIRED") throw new MetaApiError(`Instagram couldn't use the article's image. ${s.status ?? ""}`.trim(), 400, null);
    if (i < tries - 1) await sleep(waitMs);
  }
  throw new MetaApiError("Instagram was still preparing the image, so nothing was posted. It tries again later.", 400, null);
}

async function publishInstagram(link: FacebookLink, caption: string, imageUrl: string): Promise<{ id: string; permalink: string | null }> {
  if (!link.igUserId) throw new MetaApiError("No Instagram business account is linked to this Page.", 400, null);
  const container = await call<{ id: string }>(`/${link.igUserId}/media`, { image_url: imageUrl, caption, access_token: link.token }, "POST");
  // Instagram fetches the image first; publishing before the container is FINISHED fails.
  await waitForContainer(() => call<{ status_code?: string; status?: string }>(`/${container.id}`, { fields: "status_code,status", access_token: link.token }));
  const post = await call<{ id: string }>(`/${link.igUserId}/media_publish`, { creation_id: container.id, access_token: link.token }, "POST");
  const permalink = await call<{ permalink?: string }>(`/${post.id}`, { fields: "permalink", access_token: link.token })
    .then((r) => r.permalink ?? null)
    .catch(() => null);
  return { id: post.id, permalink };
}

// ---------- the text ----------

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Any form of the article's own link (www or not, http or https, trailing slash, query) in the text. */
function ownLink(url: string): RegExp {
  const u = new URL(url);
  return new RegExp(`https?://(www\\.)?${esc(u.hostname.replace(/^www\./, ""))}${esc(u.pathname.replace(/\/$/, ""))}(?![\\w-])/?(\\?[^\\s]*)?`, "gi");
}

/**
 * The Facebook post for an article: the post already written and checked for it, with the article's link tagged
 * (utm_source=facebook) once at the end.
 */
export function facebookText(item: Pick<ShareItem, "url" | "kit">, target?: string): string {
  const link = taggedUrl(target ?? item.url, "facebook");
  const words = String(item.kit.facebook ?? "").replace(ownLink(item.url), " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  const room = FACEBOOK_MAX_CHARS - link.length - 1;
  const body = words.length <= room ? words : words.slice(0, room).replace(/\s+\S*$/, "");
  return body ? `${body}\n${link}` : link;
}

/**
 * The Instagram caption: links can't be clicked there, so every link is taken out and the caption keeps the checked
 * text as written (which already says the link is in the bio). Nothing is added that the article didn't give.
 */
export function instagramCaption(item: Pick<ShareItem, "title" | "kit">): string {
  const words = String(item.kit.instagram ?? "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  const text = words || item.title;
  return text.length <= INSTAGRAM_MAX_CHARS ? text : text.slice(0, INSTAGRAM_MAX_CHARS).replace(/\s+\S*$/, "");
}

/** The article's own image as a full https address Instagram can fetch, or null. */
export function imageUrlOf(image: string | null | undefined, pageUrl: string): string | null {
  if (!image?.trim()) return null;
  try {
    const u = new URL(image.trim(), pageUrl);
    if (u.protocol === "http:") u.protocol = "https:";
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export const NO_IMAGE = "This article has no image of its own, so it can't go on Instagram.";

/** What goes to Instagram for an article: its own image and the caption, or why it is skipped. */
export function instagramPlan(item: Pick<ShareItem, "url" | "title" | "kit">, pageImage: string | null | undefined): { caption: string; image: string } | { skip: string } {
  const image = imageUrlOf(pageImage, item.url);
  return image ? { caption: instagramCaption(item), image } : { skip: NO_IMAGE };
}

// ---------- posting ----------

export type MetaResult = { ok: true; post: MetaPost } | { ok: false; error: string; status: number };

const NAME: Record<MetaChannel, string> = { facebook: "Facebook", instagram: "Instagram" };

async function skip(accountId: string, channel: MetaChannel, changeId: string, reason: string): Promise<void> {
  await sql`
    INSERT INTO insights_social_skips (account_id, channel, change_id, reason) VALUES (${accountId}, ${channel}, ${changeId}, ${reason})
    ON CONFLICT (account_id, channel, change_id) DO UPDATE SET reason = EXCLUDED.reason, at = now()`.catch(() => undefined);
}

/**
 * Posts one article to the site's own Facebook Page or Instagram account. Claims the article first, so it can never be
 * posted twice on a channel, then takes one of the week's posts in one atomic step, so two posts at once can't pass the cap.
 */
export async function postToMeta(
  accountId: string,
  channel: MetaChannel,
  item: Pick<ShareItem, "changeId" | "url" | "title" | "kit">,
  by: "owner" | "autopilot",
  publish?: (link: FacebookLink, text: string, extra: string) => Promise<{ id: string; permalink: string | null }>,
): Promise<MetaResult> {
  const link = await getFacebook(accountId);
  if (!link) return { ok: false, status: 400, error: "Connect Facebook first." };
  if (channel === "instagram" && !link.igUserId) return { ok: false, status: 400, error: "No Instagram business account is linked to your Facebook Page." };
  let text: string;
  let extra: string;
  if (channel === "instagram") {
    const page = await sitePage(accountId, item.url).catch(() => null);
    const plan = instagramPlan(item, page?.image);
    if ("skip" in plan) {
      await skip(accountId, channel, item.changeId, plan.skip);
      return { ok: false, status: 422, error: plan.skip };
    }
    text = plan.caption;
    extra = plan.image;
  } else {
    // The site's own landing or product page when it is exactly about the article's topic, otherwise the article.
    const target = await shareTarget(accountId, item);
    text = facebookText(item, target);
    extra = taggedUrl(target, "facebook");
  }
  await schema();
  const [slot] = await sql`
    INSERT INTO insights_social_posts (account_id, channel, change_id, text, by_whom) VALUES (${accountId}, ${channel}, ${item.changeId}, ${text}, ${by})
    ON CONFLICT (account_id, channel, change_id) DO NOTHING RETURNING id, posted_at`;
  if (!slot?.id) return { ok: false, status: 409, error: `This article is already on ${NAME[channel]}.` };
  // One of the last seven days' posts, taken in one statement: the WHERE is checked on the locked, latest row, so two
  // posts at the same moment can't both pass the cap. Times older than seven days fall out as it goes.
  const stamp = new Date().toISOString();
  const [count] = await sql`
    INSERT INTO insights_social_rolling (account_id, channel, times) VALUES (${accountId}, ${channel}, ARRAY[${stamp}::timestamptz])
    ON CONFLICT (account_id, channel) DO UPDATE
      SET times = array_append(ARRAY(SELECT t FROM unnest(insights_social_rolling.times) t WHERE t > now() - interval '7 days'), ${stamp}::timestamptz)
      WHERE (SELECT count(*) FROM unnest(insights_social_rolling.times) t WHERE t > now() - interval '7 days') < ${SOCIAL_WEEKLY_CAP}
    RETURNING cardinality(times) AS n`;
  const giveBack = async (counted: boolean) => {
    await sql`DELETE FROM insights_social_posts WHERE id = ${slot.id}`.catch(() => undefined);
    if (counted) {
      await sql`UPDATE insights_social_rolling SET times = array_remove(times, ${stamp}::timestamptz) WHERE account_id = ${accountId} AND channel = ${channel}`.catch(() => undefined);
    }
  };
  if (!count?.n) {
    await giveBack(false);
    return { ok: false, status: 429, error: `${SOCIAL_WEEKLY_CAP} posts went to ${NAME[channel]} in the last seven days, the most allowed. The next one goes out in a few days.` };
  }
  try {
    const send = publish ?? (channel === "instagram" ? publishInstagram : publishFacebook);
    const out = await send(link, text, extra);
    await sql`UPDATE insights_social_posts SET post_id = ${out.id}, permalink = ${out.permalink} WHERE id = ${slot.id}`.catch(() => undefined);
    await noteError(accountId, null);
    void report(channel, true);
    return { ok: true, post: { channel, changeId: item.changeId, postId: out.id, permalink: out.permalink, at: new Date(String(slot.posted_at)).toISOString(), by } };
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`${channel} post failed for account ${accountId}: ${msg}`);
    const reconnect = needsFbReconnect(e);
    // One site's removed connection is for its owner; anything else may be Meta or the platform's app, so the Inspector sees it.
    if (!reconnect) void report(channel, false, msg);
    // Meta clearly refused: nothing is live and the article is free to post again. No clear answer: it may be live.
    if (e instanceof MetaApiError && e.status < 500) {
      await giveBack(true);
      await noteError(accountId, reconnect ? "Facebook needs to be connected again." : `${NAME[channel]}: ${msg}`);
      return { ok: false, status: 502, error: reconnect ? "Facebook needs to be connected again. Nothing was posted." : `${NAME[channel]} didn't post it. Nothing was posted. ${msg}` };
    }
    await noteError(accountId, `${NAME[channel]} didn't answer clearly on the last post. Check it there.`);
    return { ok: false, status: 502, error: `${NAME[channel]} didn't answer clearly, so it may have been posted. Check it there.` };
  }
}

/**
 * The autopilot's part, once a run: for each channel the owner turned on, the newest article from the last two weeks
 * that isn't on that channel yet, wasn't skipped there, and wasn't marked posted by hand. One post per channel per run.
 */
export async function autoPostMeta(accountId: string, items: ShareItem[]): Promise<string | null> {
  const link = await getFacebook(accountId);
  if (!link || (!link.autoFacebook && !link.autoInstagram)) return null;
  const done = new Set((await metaPosts(accountId)).map((p) => `${p.channel}:${p.changeId}`));
  const skipped = new Set((await metaSkips(accountId)).map((s) => `${s.channel}:${s.changeId}`));
  const lines: string[] = [];
  const errors: string[] = [];
  for (const channel of ["facebook", "instagram"] as const) {
    if (channel === "facebook" ? !link.autoFacebook : !link.autoInstagram || !link.igUserId) continue;
    // Only posts a second AI checked go out by themselves; the rest wait for the owner's click.
    const next = items.find((i) => !i.postedAt && i.checkedBy === "ai" && !done.has(`${channel}:${i.changeId}`) && !skipped.has(`${channel}:${i.changeId}`) && Date.now() - Date.parse(i.at) < 14 * 86400_000);
    if (!next) continue;
    const out = await postToMeta(accountId, channel, next, "autopilot");
    if (out.ok) lines.push(`Posted "${next.title}" to ${NAME[channel]}.`);
    else if (out.status === 422) lines.push(`"${next.title}" left off ${NAME[channel]}: ${out.error}`);
    else if (out.status !== 429 && out.status !== 409) errors.push(out.error);
  }
  if (errors.length) throw new Error([...lines, ...errors].join(" "));
  return lines.join(" ") || null;
}
