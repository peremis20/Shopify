/**
 * Team Inbox, run as the Neon Function `inbox`. Separate from DashPatrol: its own code, its own tables (inbox_*)
 * and its own secret. People sign in with Google, connect each inbox with that inbox's own Google login, and read
 * and answer all of them in one place. Replies are sent from the inbox they arrived in, as that address.
 *
 * Environment: APP_URL (this function's public address), INBOX_SECRET (seals stored logins and signs sessions),
 * SETUP_TOKEN (opens the one time setup page). DATABASE_URL is provided by Neon.
 */
import crypto from "node:crypto";
import {
  addressIn,
  buildReply,
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
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
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

async function myAccount(email: string, id: unknown): Promise<Row | null> {
  if (!/^\d{1,18}$/.test(String(id ?? ""))) return null;
  const [a] = await sql`SELECT * FROM inbox_accounts WHERE id = ${String(id)} AND member = ${email}`;
  return a ?? null;
}
const gmailId = (v: unknown) => (/^[A-Za-z0-9_-]{1,64}$/.test(String(v ?? "")) ? String(v) : null);

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
  const unread = url.searchParams.get("unread") === "1";
  const chosen = accounts.filter((a) => !only || a.id === only);
  const q = `in:inbox${unread ? " is:unread" : ""}`;
  const results = await pool(chosen, 3, async (a) => {
    try {
      // One row per conversation: the latest real message (no drafts) speaks for the thread.
      const pageToken = only && url.searchParams.get("page") ? `&pageToken=${encodeURIComponent(url.searchParams.get("page")!)}` : "";
      const list = await gmail<{ threads?: { id: string }[]; nextPageToken?: string }>(a, `threads?maxResults=25&q=${encodeURIComponent(q)}${pageToken}`);
      // One thread that fails (deleted meanwhile) must not hide the whole inbox.
      const threads = (
        await pool(list.threads ?? [], 6, (t) =>
          gmail<{ id: string; messages?: Msg[] }>(a, `threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`).catch(() => null)
        )
      ).filter((t): t is { id: string; messages?: Msg[] } => t !== null);
      const self = normEmail(a.address);
      return {
        inbox: { id: a.id, address: a.address, error: null as string | null, next: list.nextPageToken ?? null },
        messages: threads.flatMap((t) => {
          const real = (t.messages ?? []).filter(isReal);
          const last = real[real.length - 1];
          if (!last) return [];
          // The row names the other person: the latest message not sent by this inbox, when there is one.
          const theirs = [...real].reverse().find((m) => addressIn(header(m.payload?.headers, "From")) !== self) ?? last;
          return [{
            inboxId: a.id,
            id: last.id,
            threadId: t.id,
            from: header(theirs.payload?.headers, "From") ?? "",
            subject: header(real[0].payload?.headers, "Subject") || "(no subject)",
            snippet: decodeEntities(last.snippet ?? ""),
            date: Number(last.internalDate),
            unread: real.some((m) => (m.labelIds ?? []).includes("UNREAD")),
            count: real.length,
          }];
        }),
      };
    } catch (e) {
      return { inbox: { id: a.id, address: a.address, error: (e as Error).message, reconnect: Boolean((e as { reconnect?: boolean }).reconnect) }, messages: [] };
    }
  });
  const all = results.flatMap((r) => r.messages).sort((x, y) => y.date - x.date);
  return json({ inboxes: accounts.map((a) => results.find((r) => r.inbox.id === a.id)?.inbox ?? { id: a.id, address: a.address, error: null }), messages: all });
}

async function readThread(me: { email: string }, url: URL): Promise<Response> {
  const a = await myAccount(me.email, url.searchParams.get("inbox"));
  const id = gmailId(url.searchParams.get("thread"));
  if (!a || !id) return json({ error: "Not found." }, 404);
  const t = await gmail<{ messages?: Msg[] }>(a, `threads/${id}?format=full`);
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
    messages: (t.messages ?? []).filter(isReal).map((m) => ({
      id: m.id,
      from: header(m.payload?.headers, "From") ?? "",
      to: header(m.payload?.headers, "To") ?? "",
      cc: header(m.payload?.headers, "Cc") ?? "",
      subject: header(m.payload?.headers, "Subject") ?? "",
      date: Number(m.internalDate),
      text: textOf(m.payload as never).slice(0, 100_000),
      html: (htmlOf(m.payload as never) ?? "").slice(0, 600_000) || null,
    })),
  });
}

async function reply(me: { email: string }, body: Record<string, unknown>): Promise<Response> {
  const a = await myAccount(me.email, body.inbox);
  const threadId = gmailId(body.thread);
  const messageId = gmailId(body.message);
  const text = typeof body.text === "string" ? body.text : "";
  if (!a || !threadId || !messageId) return json({ error: "Not found." }, 404);
  if (!text.trim() || text.length > 50_000) return json({ error: "Write a reply first (up to 50,000 characters)." }, 400);
  const m = await gmail<{ threadId: string; labelIds?: string[]; payload?: { headers?: { name: string; value: string }[] } }>(
    a,
    `messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`
  );
  if (m.threadId !== threadId || !isReal({ id: messageId, internalDate: "0", labelIds: m.labelIds })) return json({ error: "Not found." }, 404);
  const h = m.payload?.headers;
  const who = replyRecipients(a.address!, { from: header(h, "From"), replyTo: header(h, "Reply-To"), to: header(h, "To"), cc: header(h, "Cc") }, body.all === true);
  if (!who.to.length) return json({ error: "There's no one to reply to on this message." }, 400);
  const raw = buildReply({
    from: a.address!,
    to: who.to,
    cc: who.cc,
    subject: header(h, "Subject") ?? "",
    inReplyTo: header(h, "Message-ID") ?? null,
    references: header(h, "References") ?? null,
    body: text,
  });
  const sent = await gmail<{ id: string }>(a, "messages/send", { method: "POST", body: { raw, threadId } });
  return json({ sent: sent.id, to: who.to, cc: who.cc, from: a.address });
}

async function modify(me: { email: string }, body: Record<string, unknown>): Promise<Response> {
  const a = await myAccount(me.email, body.inbox);
  const id = gmailId(body.thread);
  const action = body.action;
  if (!a || !id) return json({ error: "Not found." }, 404);
  const change =
    action === "read" ? { removeLabelIds: ["UNREAD"] } : action === "unread" ? { addLabelIds: ["UNREAD"] } : action === "archive" ? { removeLabelIds: ["INBOX"] } : null;
  if (!change) return json({ error: "Unknown action." }, 400);
  await gmail(a, `threads/${id}/modify`, { method: "POST", body: change });
  return json({ ok: true });
}

async function removeInbox(me: { email: string }, body: Record<string, unknown>): Promise<Response> {
  const a = await myAccount(me.email, body.inbox);
  if (!a) return json({ error: "Not found." }, 404);
  await sql`DELETE FROM inbox_accounts WHERE id = ${a.id} AND member = ${me.email}`;
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

      const me = await member(req);
      if (req.method === "GET" && path === "/api/me") {
        return json({ setUp: Boolean(await googleClient()), me: me ? { email: me.email, owner: me.owner } : null });
      }
      if (!me) return json({ error: "Please sign in." }, 401);
      if (req.method === "GET" && path === "/api/auth/connect") return startGoogle(req, "inbox", url.searchParams.get("hint") ?? undefined);
      if (req.method === "GET" && path === "/api/mail") return listMail(me, url);
      if (req.method === "GET" && path === "/api/thread") return readThread(me, url);
      if (req.method === "GET" && path === "/api/team") return team(me, req);
      if (req.method === "POST") {
        if (!sameOrigin(req)) return json({ error: "Refused." }, 403);
        if (path === "/api/team") return team(me, req);
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        if (path === "/api/reply") return reply(me, body);
        if (path === "/api/modify") return modify(me, body);
        if (path === "/api/inbox/remove") return removeInbox(me, body);
      }
      return json({ error: "Not found." }, 404);
    } catch (e) {
      console.error(`team inbox: ${oneLine((e as Error).message)}`);
      return json({ error: (e as Error).message || "Something went wrong.", reconnect: Boolean((e as { reconnect?: boolean }).reconnect) }, 500);
    }
  },
};

export { addressIn };
