/**
 * Team Inbox, run as the Neon Function `inbox`. Separate from DashPatrol: its own code, its own tables (inbox_*)
 * and its own secret. People sign in with Google, connect each inbox with that inbox's own Google login, and read
 * and answer all of them in one place. Replies are sent from the inbox they arrived in, as that address.
 *
 * Environment: APP_URL (this function's public address), INBOX_SECRET (seals stored logins and signs sessions),
 * SETUP_TOKEN (opens the one time setup page). DATABASE_URL is provided by Neon.
 */
import crypto from "node:crypto";
import dns from "node:dns";
import https from "node:https";
import {
  addressIn,
  attachmentsOf,
  buildMessage,
  buildReply,
  citedCids,
  contentDisposition,
  folderOf,
  forwardBody,
  forwardSubject,
  inlineImages,
  mailQuery,
  parseAddressList,
  partById,
  quoteOriginal,
  rewriteCids,
  safeFilename,
  threadAction,
  type Part,
  header,
  isEmail,
  normEmail,
  oneLine,
  replyRecipients,
  sameSecret,
  seal,
  sign,
  textOf,
  htmlOf,
  decodeEntities,
  unseal,
  verify,
  groupSenders,
  isPrivateIp,
  ruleAction,
  ruleQueries,
  ruleSender,
  ruleTargetsTeam,
  safeUnsubUrl,
  senderMatches,
  senderTotals,
  unsubscribePlan,
  type SenderRow,
} from "./core";
import { appHtml, setupHtml } from "./page";

const env = (k: string) => (process.env[k] ?? "").trim();
const secret = () => {
  const s = env("INBOX_SECRET");
  if (s.length < 32) throw new Error("INBOX_SECRET is missing.");
  return s;
};
const appUrl = () => env("APP_URL").replace(/\/+$/, "");
const REDIRECT = () => `${appUrl()}/api/auth/google/callback`;
const SESSION_DAYS = 30;
const LOGIN_SCOPES = ["openid", "email"];
const INBOX_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"];

// ---------- database (Neon HTTP endpoint, values as text) ----------

type Row = Record<string, string | null>;
async function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> {
  const url = env("DATABASE_URL");
  const query = strings.reduce((q, part, i) => q + part + (i < values.length ? `$${i + 1}` : ""), "");
  const params = values.map((v) => (v === null || v === undefined ? null : String(v)));
  const host = new URL(url).hostname.replace(/^[^.]+\./, "api.");
  const res = await fetch(`https://${host}/sql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Neon-Connection-String": url, "Neon-Raw-Text-Output": "true" },
    body: JSON.stringify({ query, params }),
  });
  const body = (await res.json().catch(() => ({}))) as { rows?: Row[]; message?: string };
  if (!res.ok) throw new Error(body.message ?? `Database error ${res.status}`);
  return body.rows ?? [];
}

let ready: Promise<void> | null = null;
function schema(): Promise<void> {
  ready ??= (async () => {
    await sql`CREATE TABLE IF NOT EXISTS inbox_settings (key text PRIMARY KEY, value text NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS inbox_members (email text PRIMARY KEY, owner boolean NOT NULL DEFAULT false, added_at timestamptz NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS inbox_accounts (
      id bigserial PRIMARY KEY,
      member text NOT NULL,
      address text NOT NULL,
      refresh_sealed text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (member, address)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS inbox_rules (
      id bigserial PRIMARY KEY,
      member text NOT NULL,
      account_id bigint NOT NULL,
      sender text NOT NULL,
      action text NOT NULL CHECK (action IN ('trash', 'archive')),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (member, account_id, sender)
    )`;
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

async function setting(key: string): Promise<string | null> {
  const [r] = await sql`SELECT value FROM inbox_settings WHERE key = ${key}`;
  return r?.value ?? null;
}

async function googleClient(): Promise<{ id: string; secret: string } | null> {
  const id = await setting("client_id");
  const sealed = await setting("client_secret");
  const sec = sealed ? unseal(sealed, secret()) : null;
  return id && sec ? { id, secret: sec } : null;
}

// ---------- http helpers ----------

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });
const redirect = (to: string, cookies: string[] = []) => {
  const h = new Headers({ Location: to, "Cache-Control": "no-store" });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers: h });
};
const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** Signed in member, or null. */
async function member(req: Request): Promise<{ email: string; owner: boolean } | null> {
  const s = verify<{ email: string }>(readCookie(req, "__Host-ti_session"), secret());
  if (!s?.email) return null;
  const [m] = await sql`SELECT email, owner FROM inbox_members WHERE email = ${s.email}`;
  return m ? { email: m.email!, owner: m.owner === "t" } : null;
}

/** State changing calls must come from this app's own page (no cross site form posts). */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return req.headers.get("x-team-inbox") === "1" && (!origin || origin === appUrl());
}

// ---------- Google ----------

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok) throw Object.assign(new Error(body.error_description || body.error || `Google said ${res.status}`), { code: body.error });
  return body;
}

/** The verified email inside an ID token received straight from Google's token endpoint over TLS. */
function emailFromIdToken(idToken: string, clientId: string): string | null {
  try {
    const p = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    const issOk = p.iss === "https://accounts.google.com" || p.iss === "accounts.google.com";
    if (!issOk || p.aud !== clientId || p.email_verified !== true || p.exp < Date.now() / 1000) return null;
    return normEmail(p.email);
  } catch {
    return null;
  }
}

const accessCache = new Map<string, { token: string; until: number }>();
async function accessToken(account: Row): Promise<string> {
  const hit = accessCache.get(account.id!);
  if (hit && hit.until > Date.now() + 60_000) return hit.token;
  const client = await googleClient();
  const refresh = unseal(account.refresh_sealed!, secret());
  if (!client || !refresh) throw Object.assign(new Error("This inbox needs to be connected again."), { reconnect: true });
  try {
    const t = await tokenRequest({ client_id: client.id, client_secret: client.secret, refresh_token: refresh, grant_type: "refresh_token" });
    accessCache.set(account.id!, { token: t.access_token, until: Date.now() + Number(t.expires_in ?? 3000) * 1000 });
    return t.access_token;
  } catch (e) {
    if ((e as { code?: string }).code === "invalid_grant") throw Object.assign(new Error("Google ended this inbox's login. Connect it again."), { reconnect: true });
    throw e;
  }
}

async function gmail<T>(account: Row, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const token = await accessToken(account);
  const call = () =>
    fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      method: init?.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
  let res = await call();
  // Too many at once: wait a moment (Google's Retry-After, at most 5 seconds) and try once more.
  if (res.status === 429) {
    const wait = Math.min(5, Math.max(1, Number(res.headers.get("retry-after")) || 1.5)) * 1000;
    await res.body?.cancel().catch(() => undefined);
    await new Promise((r) => setTimeout(r, wait));
    res = await call();
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (res.status === 401) {
    accessCache.delete(account.id!);
    throw Object.assign(new Error("This inbox needs to be connected again."), { reconnect: true });
  }
  if (!res.ok) throw new Error(body.error?.message ?? `Gmail said ${res.status}`);
  return body;
}

/** Runs tasks with at most `n` at a time. */
async function pool<T, R>(items: T[], n: number, run: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await run(items[k]);
    }
  }));
  return out;
}

/**
 * Ends the app's Google login for an address, but only when no other member still uses that address: Google's
 * revoke ends the whole grant for that Google account, so it would cut off everyone sharing the inbox.
 */
async function revokeIfUnused(address: string, refreshSealed: string): Promise<void> {
  const [{ n }] = await sql`SELECT count(*) AS n FROM inbox_accounts WHERE address = ${address}`;
  if (Number(n) > 0) return;
  const r = unseal(refreshSealed, secret());
  if (r) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(r)}`, { method: "POST" }).catch(() => undefined);
}

interface Msg {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate: string;
  labelIds?: string[];
  payload?: { headers?: { name: string; value: string }[] } & Record<string, unknown>;
}
/** Drafts, trash and spam aren't part of the conversation shown or answered. */
const isReal = (m: Msg) => !(m.labelIds ?? []).some((l) => l === "DRAFT" || l === "TRASH" || l === "SPAM");
/** In the Trash folder the trashed messages are the ones shown. */
const shownIn = (folder: string) => (folder === "trash" ? (m: Msg) => !(m.labelIds ?? []).some((l) => l === "DRAFT" || l === "SPAM") : isReal);

async function myAccount(email: string, id: unknown): Promise<Row | null> {
  if (!/^\d{1,18}$/.test(String(id ?? ""))) return null;
  const [a] = await sql`SELECT * FROM inbox_accounts WHERE id = ${String(id)} AND member = ${email}`;
  return a ?? null;
}
const gmailId = (v: unknown) => (/^[A-Za-z0-9_-]{1,64}$/.test(String(v ?? "")) ? String(v) : null);
const attachmentId = (v: unknown) => (/^[A-Za-z0-9_-]{1,4096}$/.test(String(v ?? "")) ? String(v) : null);
/** The date line of a message: its own Date header, else when Gmail received it. */
const dateLine = (h: { name: string; value: string }[] | undefined, internalDate: string | undefined) =>
  oneLine(header(h, "Date") ?? "").slice(0, 100) || new Date(Number(internalDate ?? 0)).toUTCString();

// ---------- routes ----------

async function startGoogle(req: Request, purpose: "login" | "inbox", hint?: string): Promise<Response> {
  const client = await googleClient();
  if (!client) return redirect(`${appUrl()}/?error=not_set_up`);
  const nonce = crypto.randomBytes(16).toString("hex");
  const state = sign({ purpose, nonce }, secret(), 600);
  const q = new URLSearchParams({
    client_id: client.id,
    redirect_uri: REDIRECT(),
    response_type: "code",
    scope: (purpose === "inbox" ? INBOX_SCOPES : LOGIN_SCOPES).join(" "),
    state,
    ...(purpose === "inbox" ? { access_type: "offline", prompt: "consent select_account", include_granted_scopes: "false" } : { prompt: "select_account" }),
    ...(hint && isEmail(hint) ? { login_hint: hint } : {}),
  });
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, [cookie("__Host-ti_state", nonce, 600)]);
}

async function callback(req: Request): Promise<Response> {
  try {
    return await finishSignIn(req);
  } catch (e) {
    console.error(`team inbox sign in: ${oneLine((e as Error).message)}`);
    return redirect(`${appUrl()}/`, [cookie("__Host-ti_state", "", 0), `__Host-ti_notice=${encodeURIComponent("Sign in didn't finish. Please try again.")}; Path=/; Secure; SameSite=Lax; Max-Age=60`]);
  }
}

async function finishSignIn(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // The message travels in a short lived cookie set by this app, so a crafted link can't put words on the page.
  const back = (msg: string) =>
    redirect(`${appUrl()}/`, [cookie("__Host-ti_state", "", 0), `__Host-ti_notice=${encodeURIComponent(msg)}; Path=/; Secure; SameSite=Lax; Max-Age=60`]);
  const state = verify<{ purpose: "login" | "inbox"; nonce: string }>(url.searchParams.get("state"), secret());
  const nonce = readCookie(req, "__Host-ti_state");
  if (!state || !nonce || nonce.length !== state.nonce.length || !sameSecret(state.nonce, nonce)) return back("That sign in expired. Please try again.");
  if (url.searchParams.get("error")) return back("Google sign in was cancelled.");
  const client = await googleClient();
  if (!client) return back("Team Inbox isn't set up yet.");
  const t = await tokenRequest({ client_id: client.id, client_secret: client.secret, code: url.searchParams.get("code") ?? "", redirect_uri: REDIRECT(), grant_type: "authorization_code" });
  const email = emailFromIdToken(t.id_token ?? "", client.id);
  if (!email) return back("Google didn't confirm the email address. Please try again.");

  if (state.purpose === "login") {
    const [m] = await sql`SELECT email FROM inbox_members WHERE email = ${email}`;
    if (!m) return back(`${email} isn't on the team yet. Ask the owner to add you.`);
    const session = sign({ email }, secret(), SESSION_DAYS * 86400);
    return redirect(`${appUrl()}/`, [cookie("__Host-ti_state", "", 0), cookie("__Host-ti_session", session, SESSION_DAYS * 86400)]);
  }

  // Connecting an inbox: only for a signed in member, and only with the permissions the app needs.
  const me = await member(req);
  if (!me) return back("Sign in first, then connect the inbox.");
  const granted = String(t.scope ?? "").split(" ");
  if (!INBOX_SCOPES.slice(2).every((s) => granted.includes(s))) return back("Please allow reading and sending mail, so the inbox can be used here.");
  if (!t.refresh_token) return back("Google didn't give a lasting login. Remove Team Inbox at myaccount.google.com/permissions and connect again.");
  await sql`
    INSERT INTO inbox_accounts (member, address, refresh_sealed) VALUES (${me.email}, ${email}, ${seal(t.refresh_token, secret())})
    ON CONFLICT (member, address) DO UPDATE SET refresh_sealed = EXCLUDED.refresh_sealed`;
  // A reconnect must take effect now, not when an old cached access token runs out.
  accessCache.clear();
  return back(`Connected ${email}.`);
}

async function listMail(me: { email: string }, url: URL): Promise<Response> {
  const accounts = await sql`SELECT * FROM inbox_accounts WHERE member = ${me.email} ORDER BY address`;
  const only = url.searchParams.get("inbox");
  const folder = folderOf(url.searchParams.get("folder"));
  const q = mailQuery(folder, url.searchParams.get("unread") === "1", url.searchParams.get("q"), url.searchParams.get("primary") === "1");
  // Paging: the next page token of each inbox, so "Load more" works across all inboxes too.
  let pages: Record<string, string> | null = null;
  if (url.searchParams.get("pages")) {
    try {
      const p = JSON.parse(url.searchParams.get("pages")!) as Record<string, unknown>;
      pages = {};
      for (const [k, v] of Object.entries(p && typeof p === "object" ? p : {})) if (typeof v === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(v)) pages[k] = v;
    } catch {
      pages = {};
    }
  }
  const chosen = accounts.filter((a) => (!only || a.id === only) && (!pages || pages[a.id!]));
  // The member's "always delete" rules run first on recent inbox mail, so the list already reflects them.
  const swept = pages ? 0 : await quickRules(me.email, chosen);
  const keep = shownIn(folder);
  const results = await pool(chosen, 3, async (a) => {
    try {
      // One row per conversation: the latest real message (no drafts) speaks for the thread.
      const pageToken = pages?.[a.id!] ? `&pageToken=${encodeURIComponent(pages[a.id!])}` : "";
      const list = await gmail<{ threads?: { id: string }[]; nextPageToken?: string }>(a, `threads?maxResults=25&q=${encodeURIComponent(q)}${pageToken}`);
      // One thread that fails (deleted meanwhile) must not hide the whole inbox.
      const threads = (
        await pool(list.threads ?? [], 6, (t) =>
          gmail<{ id: string; messages?: Msg[] }>(a, `threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`).catch(() => null)
        )
      ).filter((t): t is { id: string; messages?: Msg[] } => t !== null);
      const self = normEmail(a.address);
      // Gmail's own counts for the whole inbox (one cheap call), shown next to each inbox.
      const counts = pageToken ? null : await gmail<{ messagesTotal?: number; messagesUnread?: number }>(a, "labels/INBOX").catch(() => null);
      return {
        inbox: { id: a.id, address: a.address, error: null as string | null, next: list.nextPageToken ?? null, total: counts?.messagesTotal ?? null, unread: counts?.messagesUnread ?? null },
        messages: threads.flatMap((t) => {
          const real = (t.messages ?? []).filter(keep);
          const last = real[real.length - 1];
          if (!last) return [];
          // The row names the other person: the latest message not sent by this inbox, when there is one.
          const theirs = [...real].reverse().find((m) => addressIn(header(m.payload?.headers, "From")) !== self) ?? last;
          return [{
            inboxId: a.id,
            id: last.id,
            threadId: t.id,
            from: header(theirs.payload?.headers, "From") ?? "",
            // The outside sender's bare address, for Unsubscribe and Block; null when only this inbox wrote.
            sender: ((x) => (x && x !== self ? x : null))(addressIn(header(theirs.payload?.headers, "From"))),
            to: header(last.payload?.headers, "To") ?? "",
            subject: header(real[0].payload?.headers, "Subject") || "(no subject)",
            snippet: decodeEntities(last.snippet ?? ""),
            date: Number(last.internalDate),
            unread: real.some((m) => (m.labelIds ?? []).includes("UNREAD")),
            starred: real.some((m) => (m.labelIds ?? []).includes("STARRED")),
            count: real.length,
          }];
        }),
      };
    } catch (e) {
      return { inbox: { id: a.id, address: a.address, error: (e as Error).message, reconnect: Boolean((e as { reconnect?: boolean }).reconnect) }, messages: [] };
    }
  });
  const all = results.flatMap((r) => r.messages).sort((x, y) => y.date - x.date);
  return json({ inboxes: accounts.map((a) => results.find((r) => r.inbox.id === a.id)?.inbox ?? { id: a.id, address: a.address, error: null }), messages: all, swept });
}

const CID_MESSAGE_BYTES = 5 * 1024 * 1024;
const CID_THREAD_BYTES = 15 * 1024 * 1024;

/**
 * Inline images (cid:) are fetched and put into the HTML as data: addresses, up to 5 MB a message and 15 MB a
 * thread, so they show inside the sandboxed frame without it reaching Gmail. Returns the cids that were shown.
 */
async function inlineCids(a: Row, m: Msg, html: string, budget: { left: number }): Promise<{ html: string; shown: Set<string> }> {
  const cited = citedCids(html);
  const images = new Map<string, string>();
  if (!cited.size) return { html, shown: new Set() };
  let used = 0;
  for (const img of inlineImages(m.payload as Part)) {
    if (!cited.has(img.cid) || images.has(img.cid)) continue;
    if (used + img.size > CID_MESSAGE_BYTES || img.size > budget.left) continue;
    try {
      const id = img.data ? null : attachmentId(img.attachmentId);
      const data = img.data ?? (id ? (await gmail<{ data?: string }>(a, `messages/${m.id}/attachments/${id}`)).data : undefined);
      if (!data) continue;
      const bytes = Buffer.from(data, "base64url");
      if (used + bytes.length > CID_MESSAGE_BYTES || bytes.length > budget.left) continue;
      used += bytes.length;
      budget.left -= bytes.length;
      images.set(img.cid, `data:${img.type};base64,${bytes.toString("base64")}`);
    } catch {
      // One image that can't be fetched leaves its place empty; the email still opens.
    }
  }
  return { html: images.size ? rewriteCids(html, images) : html, shown: new Set(images.keys()) };
}

async function readThread(me: { email: string }, url: URL): Promise<Response> {
  const a = await myAccount(me.email, url.searchParams.get("inbox"));
  const id = gmailId(url.searchParams.get("thread"));
  if (!a || !id) return json({ error: "Not found." }, 404);
  const t = await gmail<{ messages?: Msg[] }>(a, `threads/${id}?format=full`);
  const shown = (t.messages ?? []).filter(shownIn(folderOf(url.searchParams.get("folder"))));
  const budget = { left: CID_THREAD_BYTES };
  const messages = await pool(shown, 3, async (m) => {
    const raw = (htmlOf(m.payload as never) ?? "").slice(0, 600_000) || null;
    const inl = raw ? await inlineCids(a, m, raw, budget) : { html: null, shown: new Set<string>() };
    return {
      id: m.id,
      from: header(m.payload?.headers, "From") ?? "",
      to: header(m.payload?.headers, "To") ?? "",
      cc: header(m.payload?.headers, "Cc") ?? "",
      subject: header(m.payload?.headers, "Subject") ?? "",
      date: Number(m.internalDate),
      text: textOf(m.payload as never).slice(0, 100_000),
      html: inl.html,
      attachments: attachmentsOf(m.payload as Part, inl.shown).slice(0, 50),
      starred: (m.labelIds ?? []).includes("STARRED"),
      trashed: (m.labelIds ?? []).includes("TRASH"),
    };
  });
  return json({
    inbox: { id: a.id, address: a.address },
    threadId: id,
    // Who a reply goes to, worked out the same way the send does (Reply-To first, never this inbox itself).
    answer: (() => {
      const real = (t.messages ?? []).filter(isReal);
      const self = normEmail(a.address);
      const m = [...real].reverse().find((x) => addressIn(header(x.payload?.headers, "From")) !== self) ?? real[real.length - 1];
      if (!m) return null;
      const h = m.payload?.headers;
      const who = replyRecipients(a.address!, { from: header(h, "From"), replyTo: header(h, "Reply-To"), to: header(h, "To"), cc: header(h, "Cc") }, false);
      return { id: m.id, to: who.to };
    })(),
    // The latest outside sender, for Unsubscribe and Block sender, and whether their mail says how to unsubscribe.
    sender: (() => {
      const self = normEmail(a.address);
      const m = (t.messages ?? []).filter(isReal).reverse().find((x) => {
        const f = addressIn(header(x.payload?.headers, "From"));
        return f && f !== self;
      });
      if (!m) return null;
      const h = m.payload?.headers;
      return { address: addressIn(header(h, "From")), canUnsubscribe: Boolean(unsubscribePlan(header(h, "List-Unsubscribe"), header(h, "List-Unsubscribe-Post"))) };
    })(),
    messages,
  });
}

/** Streams one attachment as a download, never shown in the page. The name comes from Gmail, made safe. */
async function attachment(me: { email: string }, url: URL): Promise<Response> {
  const a = await myAccount(me.email, url.searchParams.get("inbox"));
  const id = gmailId(url.searchParams.get("message"));
  const part = url.searchParams.get("part") ?? "";
  if (!a || !id || !/^\d{1,6}(\.\d{1,6}){0,10}$/.test(part)) return json({ error: "Not found." }, 404);
  const m = await gmail<Msg>(a, `messages/${id}?format=full`);
  const p = partById(m.payload as Part, part);
  const attId = attachmentId(p?.body?.attachmentId);
  if (!p || (!attId && !p.body?.data)) return json({ error: "Not found." }, 404);
  const data = p.body?.data ?? (await gmail<{ data?: string }>(a, `messages/${id}/attachments/${attId}`)).data ?? "";
  return new Response(Buffer.from(data, "base64url"), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": contentDisposition(safeFilename(p.filename)),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Referrer-Policy": "no-referrer",
    },
  });
}

type FullMsg = { id: string; threadId: string; internalDate?: string; labelIds?: string[]; payload?: Part & { headers?: { name: string; value: string }[] } };

async function reply(me: { email: string }, body: Record<string, unknown>): Promise<Response> {
  const a = await myAccount(me.email, body.inbox);
  const threadId = gmailId(body.thread);
  const messageId = gmailId(body.message);
  const text = typeof body.text === "string" ? body.text : "";
  if (!a || !threadId || !messageId) return json({ error: "Not found." }, 404);
  if (!text.trim() || text.length > 50_000) return json({ error: "Write a reply first (up to 50,000 characters)." }, 400);
  const m = await gmail<FullMsg>(a, `messages/${messageId}?format=full`);
  if (m.threadId !== threadId || !isReal({ id: messageId, internalDate: "0", labelIds: m.labelIds })) return json({ error: "Not found." }, 404);
  const h = m.payload?.headers;
  const who = replyRecipients(a.address!, { from: header(h, "From"), replyTo: header(h, "Reply-To"), to: header(h, "To"), cc: header(h, "Cc") }, body.all === true);
  if (!who.to.length) return json({ error: "There's no one to reply to on this message." }, 400);
  // The original goes under the reply, unless the person turned it off.
  const original = body.quote === false ? "" : textOf(m.payload).slice(0, 30_000);
  const raw = buildReply({
    from: a.address!,
    to: who.to,
    cc: who.cc,
    subject: header(h, "Subject") ?? "",
    inReplyTo: header(h, "Message-ID") ?? null,
    references: header(h, "References") ?? null,
    body: original ? `${text.trimEnd()}\n\n${quoteOriginal(original, header(h, "From") ?? "", dateLine(h, m.internalDate))}` : text,
  });
  const sent = await gmail<{ id: string }>(a, "messages/send", { method: "POST", body: { raw, threadId } });
  return json({ sent: sent.id, to: who.to, cc: who.cc, from: a.address });
}

/** To and Cc typed by a person: real addresses only, at least one To, at most 50 in all. */
function recipients(body: Record<string, unknown>): { to: string[]; cc: string[] } | { error: string } {
  const to = parseAddressList(body.to);
  const cc = parseAddressList(body.cc);
  const bad = [...to.bad, ...cc.bad];
  if (bad.length) return { error: `This isn't an email address: ${oneLine(bad[0]).slice(0, 80)}` };
  if (!to.ok.length) return { error: "Add who it goes to." };
  if (to.ok.length + cc.ok.length > 50) return { error: "Send to at most 50 people at once." };
  return { to: to.ok, cc: cc.ok.filter((e) => !to.ok.includes(e)) };
}

/** A new email from any inbox the member connected. */
async function send(me: { email: string }, body: Record<string, unknown>): Promise<Response> {
  const a = await myAccount(me.email, body.inbox);
  if (!a) return json({ error: "Pick the inbox to send from." }, 404);
  const who = recipients(body);
  if ("error" in who) return json({ error: who.error }, 400);
  const subject = typeof body.subject === "string" ? oneLine(body.subject).slice(0, 500) : "";
  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim() && !subject) return json({ error: "Write a subject or a message first." }, 400);
  if (text.length > 50_000) return json({ error: "Keep the message under 50,000 characters." }, 400);
  const raw = buildMessage({ from: a.address!, to: who.to, cc: who.cc, subject, body: text });
  const sent = await gmail<{ id: string }>(a, "messages/send", { method: "POST", body: { raw } });
  return json({ sent: sent.id, to: who.to, cc: who.cc, from: a.address });
}

/** Forwards one message as plain text (its attachments are not included), from the inbox it is in. */
async function forward(me: { email: string }, body: Record<string, unknown>): Promise<Response> {
  const a = await myAccount(me.email, body.inbox);
  const threadId = gmailId(body.thread);
  const messageId = gmailId(body.message);
  if (!a || !threadId || !messageId) return json({ error: "Not found." }, 404);
  const who = recipients(body);
  if ("error" in who) return json({ error: who.error }, 400);
  const note = typeof body.text === "string" ? body.text : "";
  if (note.length > 50_000) return json({ error: "Keep the note under 50,000 characters." }, 400);
  const m = await gmail<FullMsg>(a, `messages/${messageId}?format=full`);
  if (m.threadId !== threadId || (m.labelIds ?? []).includes("DRAFT")) return json({ error: "Not found." }, 404);
  const h = m.payload?.headers;
  const raw = buildMessage({
    from: a.address!,
    to: who.to,
    cc: who.cc,
    subject: forwardSubject(header(h, "Subject") ?? ""),
    body: forwardBody(note, {
      from: header(h, "From") ?? "",
      date: dateLine(h, m.internalDate),
      subject: header(h, "Subject") ?? "",
      to: header(h, "To") ?? "",
      cc: header(h, "Cc") ?? "",
      text: textOf(m.payload).slice(0, 100_000),
    }),
  });
  const sent = await gmail<{ id: string }>(a, "messages/send", { method: "POST", body: { raw } });
  return json({ sent: sent.id, to: who.to, cc: who.cc, from: a.address });
}

async function modify(me: { email: string }, body: Record<string, unknown>): Promise<Response> {
  const a = await myAccount(me.email, body.inbox);
  const id = gmailId(body.thread);
  if (!a || !id) return json({ error: "Not found." }, 404);
  const change = threadAction(body.action, id);
  if (!change) return json({ error: "Unknown action." }, 400);
  await gmail(a, change.path, { method: "POST", body: change.body });
  return json({ ok: true });
}

const BULK_MAX = 100;
/** One action on many conversations, each in its own inbox. Each inbox is looked up as this member's own. */
async function bulk(me: { email: string }, body: Record<string, unknown>): Promise<Response> {
  const items = Array.isArray(body.items) ? (body.items as { inbox?: unknown; thread?: unknown }[]) : [];
  if (!items.length) return json({ error: "Pick at least one email." }, 400);
  if (items.length > BULK_MAX) return json({ error: `Pick up to ${BULK_MAX} at a time.` }, 400);
  if (!threadAction(body.action, "x")) return json({ error: "Unknown action." }, 400);
  const accounts = new Map<string, Row | null>();
  for (const it of items) {
    const k = String(it?.inbox ?? "");
    if (!accounts.has(k)) accounts.set(k, await myAccount(me.email, k));
  }
  const results = await pool(items, 5, async (it) => {
    const inbox = String(it?.inbox ?? "");
    const a = accounts.get(inbox);
    const id = gmailId(it?.thread);
    if (!a || !id) return { inbox, thread: String(it?.thread ?? ""), ok: false, error: "Not found." };
    try {
      const change = threadAction(body.action, id)!;
      await gmail(a, change.path, { method: "POST", body: change.body });
      return { inbox, thread: id, ok: true, error: null as string | null };
    } catch (e) {
      return { inbox, thread: id, ok: false, error: (e as Error).message };
    }
  });
  const failed = results.filter((r) => !r.ok);
  return json({ done: results.filter((r) => r.ok).map((r) => ({ inbox: r.inbox, thread: r.thread })), failed: failed.length, error: failed[0]?.error ?? null });
}

// ---------- junk mail: senders, unsubscribe, delete all, rules ----------

/** Ids of messages or threads matching a search, page by page, up to `cap`. */
async function listIds(a: Row, kind: "messages" | "threads", q: string, cap: number): Promise<{ ids: { id: string; threadId?: string }[]; more: boolean }> {
  const ids: { id: string; threadId?: string }[] = [];
  let token = "";
  do {
    const page = await gmail<{ messages?: { id: string; threadId?: string }[]; threads?: { id: string }[]; nextPageToken?: string }>(
      a,
      `${kind}?maxResults=${Math.min(500, cap - ids.length)}&q=${encodeURIComponent(q)}${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`
    );
    ids.push(...((kind === "messages" ? page.messages : page.threads) ?? []));
    token = page.nextPageToken ?? "";
  } while (token && ids.length < cap);
  return { ids: ids.slice(0, cap), more: Boolean(token) || ids.length > cap };
}

/** Gmail calls at once for one inbox in the clean up work. */
const GMAIL_PARALLEL = 4;
const UNSUB_HEADERS = "metadataHeaders=From&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post";
const SENDERS_CAP = 500;
const sendersCache = new Map<string, { at: number; rows: SenderRow[]; partial: boolean; skipped: number }>();

/** One inbox's last 30 days of inbox mail, as sender rows. Kept for 10 minutes so the screen opens fast again. */
async function senderRows(a: Row, fresh: boolean): Promise<{ rows: SenderRow[]; partial: boolean; skipped: number }> {
  const hit = sendersCache.get(a.id!);
  if (hit && !fresh && Date.now() - hit.at < 600_000) return hit;
  const list = await listIds(a, "messages", "in:inbox newer_than:30d", SENDERS_CAP);
  let skipped = 0;
  const rows = (
    await pool(list.ids, GMAIL_PARALLEL, async (m) => {
      try {
        const full = await gmail<Msg>(a, `messages/${m.id}?format=metadata&${UNSUB_HEADERS}`);
        const h = full.payload?.headers;
        return { inboxId: a.id!, from: header(h, "From"), date: Number(full.internalDate), listUnsubscribe: header(h, "List-Unsubscribe"), listUnsubscribePost: header(h, "List-Unsubscribe-Post"), self: a.address! } as SenderRow;
      } catch {
        skipped++;
        return null;
      }
    })
  ).filter((r): r is SenderRow => r !== null);
  const out = { at: Date.now(), rows, partial: list.more, skipped };
  sendersCache.set(a.id!, out);
  return out;
}

async function senders(me: { email: string }, url: URL): Promise<Response> {
  const accounts = await sql`SELECT * FROM inbox_accounts WHERE member = ${me.email} ORDER BY address`;
  const only = url.searchParams.get("inbox");
  const chosen = accounts.filter((a) => !only || a.id === only);
  const fresh = url.searchParams.get("fresh") === "1";
  const results = await pool(chosen, 3, async (a) => {
    try {
      const r = await senderRows(a, fresh);
      return { inbox: { id: a.id, address: a.address, error: null as string | null, partial: r.partial, skipped: r.skipped }, rows: r.rows };
    } catch (e) {
      console.error(`team inbox senders: ${oneLine((e as Error).message)}`);
      return { inbox: { id: a.id, address: a.address, error: (e as Error).message, partial: false, skipped: 0, reconnect: Boolean((e as { reconnect?: boolean }).reconnect) }, rows: [] };
    }
  });
  const groups = groupSenders(results.flatMap((r) => r.rows));
  return json({ ...senderTotals(groups), senders: groups.slice(0, 300), inboxes: results.map((r) => r.inbox) });
}

/** Called with every address a host name points to: any private one stops the request, so a name can't lead inside. */
function guardedLookup(hostname: string, opts: { all?: boolean }, cb: (err: Error | null, address?: unknown, family?: number) => void) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((x) => isPrivateIp(x.address))) return cb(Object.assign(new Error("That address isn't allowed."), { code: "EBLOCKED" }));
    if (opts?.all) cb(null, addrs);
    else cb(null, addrs[0].address, addrs[0].family);
  });
}

/** RFC 8058 one click unsubscribe, made by the server: https only, public hosts only, 10 seconds in all, at most 3 redirects. */
function oneClickPost(raw: string, deadline = Date.now() + 10_000, hops = 0): Promise<number> {
  const target = safeUnsubUrl(raw);
  if (!target) return Promise.reject(new Error("That unsubscribe address isn't allowed."));
  const left = deadline - Date.now();
  if (left <= 0) return Promise.reject(new Error("The sender's site took too long."));
  return new Promise((resolve, reject) => {
    const body = "List-Unsubscribe=One-Click";
    const req = https.request(
      target,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(Buffer.byteLength(body)), "User-Agent": "TeamInbox/1.0" },
        // Its own agent, so no shared or proxy agent can skip the address check.
        agent: new https.Agent({ keepAlive: false }),
        lookup: guardedLookup as unknown as https.RequestOptions["lookup"],
        signal: AbortSignal.timeout(left),
        timeout: left,
      },
      (res) => {
        const code = res.statusCode ?? 0;
        const loc = res.headers.location;
        res.destroy();
        if (code >= 300 && code < 400 && loc && hops < 3) {
          let next: string;
          try {
            next = new URL(loc, target).toString();
          } catch {
            return resolve(code);
          }
          return oneClickPost(next, deadline, hops + 1).then(resolve, reject);
        }
        resolve(code);
      }
    );
    req.on("timeout", () => req.destroy(new Error("The sender's site took too long.")));
    req.on("error", reject);
    req.end(body);
  });
}

/** The newest message from this sender in the inbox, with its unsubscribe headers. Checked to be from that exact address. */
async function latestFrom(a: Row, sender: string): Promise<Msg | null> {
  const list = await gmail<{ messages?: { id: string }[] }>(a, `messages?maxResults=10&q=${encodeURIComponent(`from:${sender}`)}`);
  let first: Msg | null = null;
  for (const m of list.messages ?? []) {
    const full = await gmail<Msg>(a, `messages/${m.id}?format=metadata&${UNSUB_HEADERS}`).catch(() => null);
    if (!full || addressIn(header(full.payload?.headers, "From")) !== sender) continue;
    first ??= full;
    if (header(full.payload?.headers, "List-Unsubscribe")) return full;
  }
  return first;
}

async function unsubscribe(me: { email: string }, body: Record<string, unknown>): Promise<Response> {
  const a = await myAccount(me.email, body.inbox);
  const sender = normEmail(body.sender);
  if (!a || !isEmail(sender)) return json({ error: "Not found." }, 404);
  const m = await latestFrom(a, sender);
  if (!m) return json({ error: `No email from ${sender} was found in ${a.address}.` }, 404);
  const h = m.payload?.headers;
  const plan = unsubscribePlan(header(h, "List-Unsubscribe"), header(h, "List-Unsubscribe-Post"));
  if (!plan) return json({ done: "none", message: `${sender} gives no way to unsubscribe. You can delete their mail or make a rule.` });
  let why = "";
  if (plan.kind === "post") {
    try {
      const code = await oneClickPost(plan.url);
      if (code >= 200 && code < 300) return json({ done: "posted", message: `Unsubscribed ${a.address} from ${sender}.` });
      why = `their site answered ${code}`;
    } catch (e) {
      why = oneLine((e as Error).message);
    }
    console.error(`team inbox unsubscribe ${sender}: ${why}`);
  }
  const mail = plan.kind === "link" ? null : plan.mailto;
  if (mail) {
    const raw = buildMessage({ from: a.address!, to: [mail.to], cc: [], subject: mail.subject, body: mail.body });
    await gmail<{ id: string }>(a, "messages/send", { method: "POST", body: { raw } });
    return json({ done: "emailed", message: `Sent an unsubscribe email to ${mail.to} from ${a.address}.` });
  }
  if (plan.link) return json({ done: "link", url: plan.link, message: `${sender} needs you to finish on their page.${why ? ` The quick way didn't work: ${why}.` : ""}` });
  return json({ error: `Couldn't unsubscribe from ${sender}: ${why || "no way was given"}.` }, 502);
}

const TRASH_CAP = 500;
/**
 * Moves this sender's inbox mail of the last 30 days to Trash (the same mail the Clean up count shows), up to 500 a
 * click. Only messages whose From is exactly that address move; the conversations they are in, and any replies, stay.
 */
async function trashSender(me: { email: string }, body: Record<string, unknown>): Promise<Response> {
  const a = await myAccount(me.email, body.inbox);
  const sender = normEmail(body.sender);
  if (!a || !isEmail(sender)) return json({ error: "Not found." }, 404);
  const r = await applyRules(a, [{ id: "", sender, action: "trash" }], "newer_than:30d", TRASH_CAP);
  if (r.failed) console.error(`team inbox delete all ${sender}: ${r.failed} failed`);
  return json({ count: r.moved, failed: r.failed, more: r.more });
}

type RuleRow = { id: string; sender: string; action: string };
/**
 * Applies rules to one inbox: finds matching inbox mail, checks each sender exactly, then trashes or archives the
 * message (never the whole conversation). The newest `cap` messages a run; `more` says some are left for later.
 */
async function applyRules(a: Row, rules: RuleRow[], extra: string, cap: number): Promise<{ moved: number; failed: number; more: boolean }> {
  if (!rules.length) return { moved: 0, failed: 0, more: false };
  const ids = new Map<string, true>();
  let more = false;
  for (const q of ruleQueries(rules.map((r) => r.sender), extra)) {
    if (ids.size >= cap) {
      more = true;
      break;
    }
    const list = await listIds(a, "messages", q, cap - ids.size);
    more ||= list.more;
    for (const m of list.ids) ids.set(m.id, true);
  }
  if (!ids.size) return { moved: 0, failed: 0, more };
  const toTrash: string[] = [];
  const toArchive: string[] = [];
  await pool([...ids.keys()], GMAIL_PARALLEL, async (id) => {
    const m = await gmail<Msg>(a, `messages/${id}?format=metadata&metadataHeaders=From`).catch(() => null);
    const from = addressIn(header(m?.payload?.headers, "From"));
    const hits = rules.filter((r) => senderMatches(r.sender, from));
    if (!m || !hits.length || !(m.labelIds ?? []).includes("INBOX")) return;
    (hits.some((r) => r.action === "trash") ? toTrash : toArchive).push(id);
  });
  let moved = 0;
  if (toArchive.length) {
    await gmail(a, "messages/batchModify", { method: "POST", body: { ids: toArchive, removeLabelIds: ["INBOX"] } });
    moved += toArchive.length;
  }
  const done = await pool(toTrash, GMAIL_PARALLEL, (id) => gmail(a, `messages/${id}/trash`, { method: "POST" }).then(() => 1, () => 0));
  const trashed = done.reduce((n: number, x) => n + x, 0);
  moved += trashed;
  if (moved) sendersCache.delete(a.id!);
  return { moved, failed: toTrash.length - trashed, more };
}

async function rulesByAccount(memberEmail: string | null): Promise<Map<string, RuleRow[]>> {
  const rows = memberEmail
    ? await sql`SELECT r.id, r.account_id, r.sender, r.action FROM inbox_rules r JOIN inbox_accounts a ON a.id = r.account_id AND a.member = r.member WHERE r.member = ${memberEmail}`
    : await sql`SELECT r.id, r.account_id, r.sender, r.action FROM inbox_rules r JOIN inbox_accounts a ON a.id = r.account_id AND a.member = r.member`;
  const by = new Map<string, RuleRow[]>();
  for (const r of rows) by.set(r.account_id!, [...(by.get(r.account_id!) ?? []), { id: r.id!, sender: r.sender!, action: r.action! }]);
  return by;
}

const QUICK_CAP = 50;
const quickAt = new Map<string, number>();
/** On each mail load: rules run on the last 2 days of the shown inboxes, at most once a minute per inbox. */
async function quickRules(memberEmail: string, accounts: Row[]): Promise<number> {
  const due = accounts.filter((a) => Date.now() - (quickAt.get(a.id!) ?? 0) > 60_000);
  if (!due.length) return 0;
  const by = await rulesByAccount(memberEmail);
  const counts = await pool(due.filter((a) => by.has(a.id!)), 3, async (a) => {
    quickAt.set(a.id!, Date.now());
    try {
      return (await applyRules(a, by.get(a.id!)!, "newer_than:2d", QUICK_CAP)).moved;
    } catch (e) {
      console.error(`team inbox rules ${a.address}: ${oneLine((e as Error).message)}`);
      return 0;
    }
  });
  return counts.reduce((n, x) => n + x, 0);
}

/** POST /api/sweep from a Neon trigger: every member's rules on every inbox, up to 200 a run each, answered with a count. */
async function sweepAll(): Promise<Response> {
  const by = await rulesByAccount(null);
  if (!by.size) return json({ count: 0 });
  const ids = [...by.keys()];
  const accounts = await sql`SELECT * FROM inbox_accounts WHERE id = ANY(${`{${ids.join(",")}}`}::bigint[])`;
  const counts = await pool(accounts, 3, async (a) => {
    try {
      // Any age: this also finishes what a new rule left for later.
      return (await applyRules(a, by.get(a.id!) ?? [], "", 200)).moved;
    } catch (e) {
      console.error(`team inbox sweep ${a.address}: ${oneLine((e as Error).message)}`);
      return 0;
    }
  });
  return json({ count: counts.reduce((n, x) => n + x, 0) });
}

async function listRules(me: { email: string }): Promise<Response> {
  const rows = await sql`SELECT r.id, r.account_id, a.address, r.sender, r.action, r.created_at FROM inbox_rules r JOIN inbox_accounts a ON a.id = r.account_id AND a.member = r.member WHERE r.member = ${me.email} ORDER BY a.address, r.sender`;
  return json({ rules: rows.map((r) => ({ id: r.id, inbox: r.account_id, address: r.address, sender: r.sender, action: r.action, created: r.created_at })) });
}

async function addRule(me: { email: string }, body: Record<string, unknown>): Promise<Response> {
  const a = await myAccount(me.email, body.inbox);
  if (!a) return json({ error: "Pick the inbox for this rule." }, 404);
  const sender = ruleSender(body.sender);
  if (!sender) return json({ error: "Write an email address, or a whole domain like @shop.com." }, 400);
  const action = ruleAction(body.action ?? "trash");
  if (!action) return json({ error: "Unknown action." }, 400);
  // Never the team's own mail: any connected inbox, any member, or a domain one of them uses.
  const team = await sql`SELECT address AS e FROM inbox_accounts UNION SELECT email AS e FROM inbox_members`;
  if (ruleTargetsTeam(sender, team.map((t) => t.e))) return json({ error: "A rule can't remove your team's own mail." }, 400);
  const [{ n }] = await sql`SELECT count(*) AS n FROM inbox_rules WHERE member = ${me.email}`;
  if (Number(n) >= 500) return json({ error: "You have 500 rules. Remove some first." }, 400);
  const [r] = await sql`
    INSERT INTO inbox_rules (member, account_id, sender, action) VALUES (${me.email}, ${a.id}, ${sender}, ${action})
    ON CONFLICT (member, account_id, sender) DO UPDATE SET action = EXCLUDED.action RETURNING id`;
  // The mail already there is handled now, not only new mail.
  // The newest 100 now; anything older is left to the scheduled sweep and later loads.
  let swept = 0;
  let error: string | null = null;
  try {
    swept = (await applyRules(a, [{ id: r.id!, sender, action }], "", 100)).moved;
  } catch (e) {
    error = (e as Error).message;
    console.error(`team inbox rule sweep ${a.address}: ${oneLine(error)}`);
  }
  return json({ id: r.id, sender, action, swept, error });
}

async function removeRule(me: { email: string }, body: Record<string, unknown>): Promise<Response> {
  const id = String(body.id ?? "");
  if (!/^\d{1,18}$/.test(id)) return json({ error: "Not found." }, 404);
  const gone = await sql`DELETE FROM inbox_rules WHERE id = ${id} AND member = ${me.email} RETURNING id`;
  return gone.length ? json({ ok: true }) : json({ error: "Not found." }, 404);
}

async function removeInbox(me: { email: string }, body: Record<string, unknown>): Promise<Response> {
  const a = await myAccount(me.email, body.inbox);
  if (!a) return json({ error: "Not found." }, 404);
  await sql`DELETE FROM inbox_accounts WHERE id = ${a.id} AND member = ${me.email}`;
  await sql`DELETE FROM inbox_rules WHERE account_id = ${a.id} AND member = ${me.email}`;
  accessCache.delete(a.id!);
  await revokeIfUnused(a.address!, a.refresh_sealed!);
  return json({ ok: true });
}

async function team(me: { email: string; owner: boolean }, req: Request): Promise<Response> {
  if (!me.owner) return json({ error: "Only the owner manages the team." }, 403);
  if (req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { add?: string; remove?: string };
    const add = normEmail(b.add);
    const remove = normEmail(b.remove);
    if (add) {
      if (!isEmail(add)) return json({ error: "That isn't an email address." }, 400);
      await sql`INSERT INTO inbox_members (email) VALUES (${add}) ON CONFLICT (email) DO NOTHING`;
    }
    if (remove) {
      const [target] = await sql`SELECT email, owner FROM inbox_members WHERE email = ${remove}`;
      if (!target) return json({ error: "That person isn't on the team." }, 404);
      if (target.owner === "t") return json({ error: "An owner can't be removed." }, 400);
      // Their connected inboxes go too; a login no one else shares is ended with Google.
      const theirs = await sql`SELECT * FROM inbox_accounts WHERE member = ${remove}`;
      await sql`DELETE FROM inbox_accounts WHERE member = ${remove}`;
      await sql`DELETE FROM inbox_rules WHERE member = ${remove}`;
      await sql`DELETE FROM inbox_members WHERE email = ${remove} AND NOT owner`;
      for (const a of theirs) {
        accessCache.delete(a.id!);
        await revokeIfUnused(a.address!, a.refresh_sealed!);
      }
    }
  }
  const rows = await sql`SELECT email, owner FROM inbox_members ORDER BY owner DESC, email`;
  return json({ members: rows.map((r) => ({ email: r.email, owner: r.owner === "t" })) });
}

async function setup(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const token = env("SETUP_TOKEN");
  if (token.length < 32 || typeof b.token !== "string" || b.token.length !== token.length || !sameSecret(b.token, token)) return json({ error: "This setup link isn't valid." }, 403);
  if (await googleClient()) return json({ error: "Team Inbox is already set up." }, 409);
  const id = String(b.clientId ?? "").trim();
  const sec = String(b.clientSecret ?? "").trim();
  const owner = normEmail(b.owner);
  if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id)) return json({ error: "That Client ID doesn't look right. It ends in .apps.googleusercontent.com." }, 400);
  if (sec.length < 10 || /\s/.test(sec)) return json({ error: "That Client secret doesn't look right." }, 400);
  if (!isEmail(owner)) return json({ error: "Add the owner's email address." }, 400);
  await sql`INSERT INTO inbox_settings (key, value) VALUES ('client_id', ${id}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await sql`INSERT INTO inbox_settings (key, value) VALUES ('client_secret', ${seal(sec, secret())}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await sql`INSERT INTO inbox_members (email, owner) VALUES (${owner}, true) ON CONFLICT (email) DO UPDATE SET owner = true`;
  return json({ ok: true });
}

const pageHeaders = (nonce: string) => ({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://accounts.google.com`,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

/**
 * The public address can be set in the database (inbox_settings app_url), so moving to a new domain
 * needs no redeploy and never touches the secrets. Checked once a minute.
 */
/** The address the visitor typed, and whether it is the long Neon one (only that one is moved). */
const hostOf = (req: Request, url: URL) => (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host).toLowerCase();
const onLongAddress = (req: Request, url: URL) => hostOf(req, url).endsWith(".neon.tech");
let publicUrlAt = 0;
async function loadPublicUrl(): Promise<void> {
  if (Date.now() - publicUrlAt < 60_000) return;
  publicUrlAt = Date.now();
  const v = (await setting("app_url").catch(() => null))?.trim().replace(/\/+$/, "");
  if (v && /^https:\/\/[a-z0-9.-]+$/i.test(v)) process.env.APP_URL = v;
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      await schema();
      await loadPublicUrl();
      // Pages opened on another address (the old long one) move to the public address.
      if (req.method === "GET" && (path === "/" || path === "/setup") && appUrl() && onLongAddress(req, url) && appUrl() !== `https://${hostOf(req, url)}`) {
        return new Response(null, { status: 301, headers: { Location: `${appUrl()}${url.pathname}${url.search}` } });
      }
      if (req.method === "GET" && path === "/") {
        const nonce = crypto.randomBytes(16).toString("base64");
        return new Response(appHtml(nonce), { headers: pageHeaders(nonce) });
      }
      if (req.method === "GET" && path === "/setup") {
        const nonce = crypto.randomBytes(16).toString("base64");
        return new Response(setupHtml(nonce), { headers: pageHeaders(nonce) });
      }
      if (req.method === "POST" && path === "/api/setup") return sameOrigin(req) ? setup(req) : json({ error: "Refused." }, 403);
      if (req.method === "GET" && path === "/api/auth/login") return startGoogle(req, "login");
      if (req.method === "GET" && path === "/api/auth/google/callback") return callback(req);
      if (req.method === "POST" && path === "/api/auth/logout") {
        return sameOrigin(req) ? json({ ok: true }, 200, { "Set-Cookie": cookie("__Host-ti_session", "", 0) }) : json({ error: "Refused." }, 403);
      }

      // Neon's scheduler calls this without a session. Neon strips client set X-Neon-* headers, so this header
      // proves the call came from a trigger. It only applies rules the members made, and answers with a count.
      if (req.method === "POST" && path === "/api/sweep") {
        return req.headers.get("x-neon-trigger-invocation-id") ? sweepAll() : json({ error: "Refused." }, 403);
      }

      const me = await member(req);
      if (req.method === "GET" && path === "/api/me") {
        return json({ setUp: Boolean(await googleClient()), me: me ? { email: me.email, owner: me.owner } : null });
      }
      if (!me) return json({ error: "Please sign in." }, 401);
      if (req.method === "GET" && path === "/api/auth/connect") return startGoogle(req, "inbox", url.searchParams.get("hint") ?? undefined);
      if (req.method === "GET" && path === "/api/mail") return listMail(me, url);
      if (req.method === "GET" && path === "/api/thread") return readThread(me, url);
      if (req.method === "GET" && path === "/api/attachment") return attachment(me, url);
      if (req.method === "GET" && path === "/api/team") return team(me, req);
      if (req.method === "GET" && path === "/api/senders") return senders(me, url);
      if (req.method === "GET" && path === "/api/rules") return listRules(me);
      if (req.method === "POST") {
        if (!sameOrigin(req)) return json({ error: "Refused." }, 403);
        if (path === "/api/team") return team(me, req);
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        if (path === "/api/reply") return reply(me, body);
        if (path === "/api/modify") return modify(me, body);
        if (path === "/api/bulk") return bulk(me, body);
        if (path === "/api/send") return send(me, body);
        if (path === "/api/forward") return forward(me, body);
        if (path === "/api/inbox/remove") return removeInbox(me, body);
        if (path === "/api/unsubscribe") return unsubscribe(me, body);
        if (path === "/api/sender/trash") return trashSender(me, body);
        if (path === "/api/rules/add") return addRule(me, body);
        if (path === "/api/rules/remove") return removeRule(me, body);
      }
      return json({ error: "Not found." }, 404);
    } catch (e) {
      console.error(`team inbox: ${oneLine((e as Error).message)}`);
      return json({ error: (e as Error).message || "Something went wrong.", reconnect: Boolean((e as { reconnect?: boolean }).reconnect) }, 500);
    }
  },
};

export { addressIn };
