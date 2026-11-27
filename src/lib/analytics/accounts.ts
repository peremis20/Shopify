import crypto from "crypto";
import { ensureSchema, sql } from "./db";

/**
 * Customer accounts. Signing in with Google creates the account (keyed by
 * email) and a signed session cookie identifies it on every request.
 *
 * A business (an account) has one main sign in (its owner) and may have team
 * members: other verified Google emails that accepted an invite. The session
 * names both the business and the person, so a member never acts as the owner.
 */

export type Role = "owner" | "member";

export interface Account {
  /** The business. */
  id: string;
  /** The person signed in (the owner, or a team member). */
  email: string;
  /** The business's main sign in. */
  ownerEmail: string;
  role: Role;
  /** A platform owner, from the signed in person's own email only. */
  admin: boolean;
  /** Inside Shopify admin (the store's session token, no cookie). */
  embedded?: boolean;
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
  return { id: row.id!, email: row.email!, ownerEmail: row.email!, role: "owner", admin: await isAdmin(row.email!) };
}

const b64 = (v: string) => Buffer.from(v, "utf8").toString("base64url");
const unb64 = (v: string) => Buffer.from(v, "base64url").toString("utf8");

/** The signed cookie value: `accountId.person.exp.sig`, the person being the signed in email (base64url). */
export function sessionValue(accountId: string, person: string, exp: number): string {
  const payload = `${accountId}.${b64(person.toLowerCase())}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * The business and person a cookie names, or null when it is forged, malformed or expired. Cookies from before
 * team members (`accountId.exp.sig`) stay valid and name the business's main sign in (person null).
 */
export function readSession(value: string, now = Date.now()): { id: string; person: string | null; exp: number } | null {
  const parts = value.split(".");
  let id: string, person: string | null, exp: string, sig: string, payload: string;
  if (parts.length === 3) {
    [id, exp, sig] = parts;
    person = null;
    payload = `${id}.${exp}`;
  } else if (parts.length === 4) {
    let p: string;
    [id, p, exp, sig] = parts;
    payload = `${id}.${p}.${exp}`;
    person = cleanEmail(unb64(p));
    if (!person) return null;
  } else return null;
  if (!/^\d+$/.test(id) || !/^\d+$/.test(exp) || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(exp) * 1000 < now) return null;
  return { id, person, exp: Number(exp) };
}

/** Signs in `person` to business `accountId` (the owner or an accepted team member), or signs out with null. */
export function sessionCookie(req: Request, accountId: string | null, person?: string): string {
  const secure = new URL(req.url).protocol === "https:" || process.env.APP_URL?.startsWith("https:") ? "; Secure" : "";
  if (!accountId || !person) return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  const value = sessionValue(accountId, person, Math.floor(Date.now() / 1000) + MAX_AGE);
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`;
}

/** The role a person has in a business, or null when they have none (a removed member loses access at once). */
export function roleFor(person: string, ownerEmail: string, isMember: boolean): Role | null {
  if (person.toLowerCase() === ownerEmail.toLowerCase()) return "owner";
  return isMember ? "member" : null;
}

export function readCookie(req: Request, name: string): string | undefined {
  const match = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

/** The signed-in business and person, or null. Membership is read again on every request. */
export async function currentAccount(req: Request): Promise<Account | null> {
  const value = readCookie(req, COOKIE);
  if (!value) return null;
  const s = readSession(value);
  if (!s) return null;
  await ensureSchema();
  const [row] = await sql`
    SELECT a.id, a.email,
      EXISTS (SELECT 1 FROM insights_account_members m WHERE m.account_id = a.id AND lower(m.email) = ${(s.person ?? "").toLowerCase()}) AS member
    FROM insights_accounts a WHERE a.id = ${s.id}`;
  if (!row?.email) return null;
  const person = s.person ?? row.email;
  const role = roleFor(person, row.email, row.member === "t" || row.member === "true");
  if (!role) return null;
  const admin = await isAdmin(person);
  // A platform owner who is on a business's team acts with the main sign in's rights there (keys, connections,
  // approvals). Everyone else on a team stays a member.
  return { id: row.id!, email: person, ownerEmail: row.email, role: role === "member" && admin ? "owner" : role, admin };
}

/** The email an account signs in with, or null. */
export async function accountEmail(id: string): Promise<string | null> {
  await ensureSchema();
  const [row] = await sql`SELECT email FROM insights_accounts WHERE id = ${id}`;
  return row?.email ?? null;
}
