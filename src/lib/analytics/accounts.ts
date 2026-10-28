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

export async function upsertAccount(email: string): Promise<Account> {
  await ensureSchema();
  const [row] = await sql`
    INSERT INTO insights_accounts (email) VALUES (${email.toLowerCase()})
    ON CONFLICT (email) DO UPDATE SET last_login_at = now()
    RETURNING id, email`;
  return { id: row.id!, email: row.email!, admin: isAdminEmail(row.email!) };
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
  return row ? { id: row.id!, email: row.email!, admin: isAdminEmail(row.email!) } : null;
}
