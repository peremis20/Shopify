import { ensureSchema, sql } from "./db";
import { GoogleApiError, googleRequest, hasScope, revokeToken } from "./google-auth";
import { tokenSecret } from "./oauth-client";
import { decrypt, encrypt } from "./secrets";

/**
 * Sending one outreach email from the owner's own Gmail, only when the owner clicks Send.
 * Kept apart from the Search Console and Analytics connection: its own token with only the
 * gmail.send permission, asked for in a separate optional step, removable on its own.
 * Never used by any agent or scheduled job: the only caller is the owner's Send click.
 */

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
/** Who signs in (so the sender address can be shown) and permission to send, nothing to read. */
export const GMAIL_OAUTH_SCOPES = ["openid", "email", GMAIL_SEND_SCOPE];
/** At most this many emails a day from one site, so it can never be used for mass mail. */
export const DAILY_SEND_CAP = 20;

export interface GmailLink {
  refreshToken: string;
  email: string;
}

async function schema() {
  await ensureSchema();
  await sql`CREATE TABLE IF NOT EXISTS insights_account_gmail (
    account_id bigint PRIMARY KEY REFERENCES insights_accounts (id) ON DELETE CASCADE,
    refresh_token_enc text NOT NULL,
    email text NOT NULL,
    connected_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS insights_gmail_sends (
    id bigserial PRIMARY KEY,
    account_id bigint NOT NULL,
    prospect_url text NOT NULL,
    to_addr text NOT NULL,
    sent_at timestamptz NOT NULL DEFAULT now(),
    message_id text
  )`;
  // One email per site from here, enforced by the database even for requests at the same moment.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS insights_gmail_sends_once ON insights_gmail_sends (account_id, prospect_url)`;
  // The daily count, raised in one atomic step that refuses once the cap is reached.
  await sql`CREATE TABLE IF NOT EXISTS insights_gmail_daily (
    account_id bigint NOT NULL,
    day date NOT NULL,
    n integer NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, day)
  )`;
}

export async function getGmail(accountId: string): Promise<GmailLink | null> {
  await schema();
  const [row] = await sql`SELECT refresh_token_enc, email FROM insights_account_gmail WHERE account_id = ${accountId}`;
  if (!row?.refresh_token_enc || !row.email) return null;
  const refreshToken = decrypt(row.refresh_token_enc, await tokenSecret());
  return refreshToken ? { refreshToken, email: row.email } : null;
}

export async function saveGmail(accountId: string, link: GmailLink): Promise<void> {
  await schema();
  const enc = encrypt(link.refreshToken, await tokenSecret());
  await sql`
    INSERT INTO insights_account_gmail (account_id, refresh_token_enc, email) VALUES (${accountId}, ${enc}, ${link.email})
    ON CONFLICT (account_id) DO UPDATE SET refresh_token_enc = EXCLUDED.refresh_token_enc, email = EXCLUDED.email, connected_at = now()`;
}

/**
 * Stops sending from Gmail: the token is deleted. Google's permission is withdrawn only when it is a
 * different Google account from the Search Console one, because withdrawing it on the same account
 * can also end the Search Console and Analytics access.
 */
export async function removeGmail(accountId: string, mainEmail: string | null | undefined): Promise<void> {
  const link = await getGmail(accountId).catch(() => null);
  if (link && mainEmail && link.email.toLowerCase() !== mainEmail.toLowerCase()) await revokeToken(link.refreshToken);
  await schema();
  await sql`DELETE FROM insights_account_gmail WHERE account_id = ${accountId}`;
}

/** Emails sent from here today (UTC day). */
export async function sentToday(accountId: string): Promise<number> {
  await schema();
  const [row] = await sql`SELECT n FROM insights_gmail_daily WHERE account_id = ${accountId} AND day = (now() AT TIME ZONE 'UTC')::date`;
  return Number(row?.n ?? 0);
}

/** The Gmail address may only be one this account already signed in or connected Google with. */
export function sameOwner(gmail: string, known: (string | null | undefined)[]): boolean {
  const g = gmail.trim().toLowerCase();
  return known.some((k) => typeof k === "string" && k.trim().toLowerCase() === g);
}

/** One plain email address and nothing else (no list, no name part, no header tricks). */
export function singleAddress(to: unknown): string | null {
  if (typeof to !== "string") return null;
  const t = to.trim();
  if (t.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(t)) return null;
  const [local] = t.split("@");
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return t;
}

const encodedWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/** The email as Gmail's API takes it: a plain text RFC 2822 message, base64url encoded. */
export function buildRaw(m: { from: string; to: string; subject: string; body: string }): string {
  // Line breaks in a header would let text become extra headers, so the subject is one line.
  const subject = m.subject.replace(/[\r\n]+/g, " ").trim();
  const body = m.body.replace(/\r?\n/g, "\r\n");
  const mime = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${encodedWord(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    (Buffer.from(body, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n"),
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

export type SendResult = { ok: true; to: string; from: string; sentToday: number } | { ok: false; error: string; status: number };

/**
 * Sends one email the owner clicked Send on. Checks the address, the daily cap and that this site
 * wasn't already emailed from here, then sends from the owner's own Gmail.
 */
export async function sendOneEmail(
  accountId: string,
  m: { prospectUrl: string; to: unknown; subject: unknown; body: unknown },
  send: (link: GmailLink, raw: string) => Promise<{ id?: string }> = gmailSend
): Promise<SendResult> {
  const to = singleAddress(m.to);
  if (!to) return { ok: false, status: 400, error: "Put one email address in To, like name@example.com." };
  const subject = typeof m.subject === "string" ? m.subject.trim() : "";
  const body = typeof m.body === "string" ? m.body.trim() : "";
  if (!subject || !body) return { ok: false, status: 400, error: "The email needs a subject and a message." };
  if (subject.length > 300 || body.length > 20_000) return { ok: false, status: 400, error: "That email is too long to send." };
  const link = await getGmail(accountId);
  if (!link) return { ok: false, status: 400, error: "Allow sending from Gmail first." };
  await schema();
  // The site's one send is claimed first; the unique index refuses a second, even at the same moment.
  const [slot] = await sql`
    INSERT INTO insights_gmail_sends (account_id, prospect_url, to_addr) VALUES (${accountId}, ${m.prospectUrl}, ${to})
    ON CONFLICT (account_id, prospect_url) DO NOTHING RETURNING id`;
  if (!slot?.id) return { ok: false, status: 409, error: "This site was already emailed from here. To write again, use Open in my email." };
  // Then today's count goes up by one, only while under the cap (one atomic step).
  const [count] = await sql`
    INSERT INTO insights_gmail_daily (account_id, day, n) VALUES (${accountId}, (now() AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (account_id, day) DO UPDATE SET n = insights_gmail_daily.n + 1 WHERE insights_gmail_daily.n < ${DAILY_SEND_CAP}
    RETURNING n`;
  const giveBack = async (counted: boolean) => {
    await sql`DELETE FROM insights_gmail_sends WHERE id = ${slot.id}`.catch(() => undefined);
    if (counted) await sql`UPDATE insights_gmail_daily SET n = greatest(n - 1, 0) WHERE account_id = ${accountId} AND day = (now() AT TIME ZONE 'UTC')::date`.catch(() => undefined);
  };
  if (!count?.n) {
    await giveBack(false);
    return { ok: false, status: 429, error: `You sent ${DAILY_SEND_CAP} emails from here today, the most allowed. Try again tomorrow, or use Open in my email.` };
  }
  try {
    const out = await send(link, buildRaw({ from: link.email, to, subject, body }));
    await sql`UPDATE insights_gmail_sends SET message_id = ${out.id ?? null} WHERE id = ${slot.id}`.catch(() => undefined);
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`gmail send failed for account ${accountId}: ${msg}`);
    // Google clearly refused (or access couldn't be had): nothing went out, so the send is given back.
    const refused = (e instanceof GoogleApiError && e.status < 500) || /^Google (access|sign in)/.test(msg);
    if (!refused) {
      // No clear answer (a timeout or Google error): it may have gone out, so it isn't retried blindly.
      return { ok: false, status: 502, error: "Gmail didn't answer clearly, so it may have been sent. Check your Gmail Sent folder. If it isn't there, use Open in my email." };
    }
    await giveBack(true);
    return {
      ok: false,
      status: 502,
      error: /expired|removed|invalid_grant|insufficient|permission|401|403/i.test(msg) || (e instanceof GoogleApiError && (e.status === 401 || e.status === 403))
        ? "Gmail sending isn't allowed anymore. Nothing was sent. Click Stop sending from Gmail, then allow it again."
        : "Gmail didn't send it. Nothing was sent. Check the address, or use Open in my email.",
    };
  }
  return { ok: true, to, from: link.email, sentToday: await sentToday(accountId) };
}

async function gmailSend(link: GmailLink, raw: string) {
  const auth = { kind: "oauth" as const, refreshToken: link.refreshToken };
  // Access is fetched first, so a failure there is known to have sent nothing.
  const allowed = await hasScope(auth, GMAIL_SEND_SCOPE).catch((e) => {
    throw new Error(/^Google (access|sign in)/.test((e as Error).message) ? (e as Error).message : `Google sign in failed: ${(e as Error).message}`);
  });
  if (!allowed) throw new Error("Google access has no permission to send.");
  return googleRequest<{ id?: string }>(auth, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { raw });
}
