import crypto from "crypto";
import { ensureSchema, sql } from "./db";

/**
 * Customer accounts. Signing in with Google creates the account (keyed by
 * email) and a signed session cookie identifies it on every request.
 */

export interface Account {
  id: string;
  email: string;
  admin: boolean;
}

const COOKIE = "insights_session";
const MAX_AGE = 60 * 60 * 24 * 30;

function sessionKey(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set on the server.");
  return secret;
}

const sign = (payload: string) =>
  crypto.createHmac("sha256", sessionKey()).update(payload).digest("base64url");

/** Platform owners, who see platform settings. Comma separated emails in ADMIN_EMAILS. */
export const isAdminEmail = (email: string) =>
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());

/** A lowercase email when it looks like one, else null. */
export const cleanEmail = (raw: unknown): string | null => {
  const e = String(raw ?? "").trim().toLowerCase();
  return /^[^\s@,]+@[^\s@,]+\.[a-z]{2,}$/.test(e) ? e : null;
};

const EXTRA_ADMINS_KEY = "admin_emails";

/** Platform owners added from inside the app by another owner (the server setting ADMIN_EMAILS stays the root list). */
export async function extraAdmins(): Promise<string[]> {
  await ensureSchema();
  // A failed read throws, so an add or remove never saves over the list from an empty read.
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${EXTRA_ADMINS_KEY}`;
  return String(row?.value ?? "")
    .split(",")
    .map((e) => cleanEmail(e))
    .filter((e): e is string => Boolean(e));
}

/** Saves the in app owner list (deduplicated, valid emails only) and returns it. */
export async function saveExtraAdmins(emails: string[]): Promise<string[]> {
  const list = [...new Set(emails.map((e) => cleanEmail(e)).filter((e): e is string => Boolean(e)))];
  await ensureSchema();
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${EXTRA_ADMINS_KEY}, ${list.join(",")})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  ownersCache = null;
  return list;
}

/** The in app owner list, kept a minute so a page load doesn't read it on every request. */
let ownersCache: { at: number; list: string[] } | null = null;

/** A platform owner: in ADMIN_EMAILS, or added in the app by an owner. */
export async function isAdmin(email: string): Promise<boolean> {
  if (isAdminEmail(email)) return true;
  if (!ownersCache || Date.now() - ownersCache.at > 60_000) {
    ownersCache = { at: Date.now(), list: await extraAdmins().catch(() => [] as string[]) };
  }
  return ownersCache.list.includes(email.toLowerCase());
}

export async function upsertAccount(email: string): Promise<Account> {
  await ensureSchema();
  const [row] = await sql`
    INSERT INTO insights_accounts (email) VALUES (${email.toLowerCase()})
    ON CONFLICT (email) DO UPDATE SET last_login_at = now()
    RETURNING id, email`;
  return { id: row.id!, email: row.email!, admin: await isAdmin(row.email!) };
}

export function sessionCookie(req: Request, accountId: string | null): string {
  const secure = new URL(req.url).protocol === "https:" || process.env.APP_URL?.startsWith("https:") ? "; Secure" : "";
  if (!accountId) return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  const payload = `${accountId}.${Math.floor(Date.now() / 1000) + MAX_AGE}`;
  return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`;
}

export function readCookie(req: Request, name: string): string | undefined {
  const match = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

/** The signed-in account, or null. */
export async function currentAccount(req: Request): Promise<Account | null> {
  const value = readCookie(req, COOKIE);
  if (!value) return null;
  const [id, exp, sig] = value.split(".");
  if (!id || !exp || !sig) return null;
  const expected = sign(`${id}.${exp}`);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(exp) * 1000 < Date.now()) return null;
  await ensureSchema();
  const [row] = await sql`SELECT id, email FROM insights_accounts WHERE id = ${id}`;
  return row ? { id: row.id!, email: row.email!, admin: await isAdmin(row.email!) } : null;
}

/** The email an account signs in with, or null. */
export async function accountEmail(id: string): Promise<string | null> {
  await ensureSchema();
  const [row] = await sql`SELECT email FROM insights_accounts WHERE id = ${id}`;
  return row?.email ?? null;
}
