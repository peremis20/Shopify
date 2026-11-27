import crypto from "crypto";
import { cleanEmail, isAdminEmail, type Account, type Role } from "./accounts";
import { ensureSchema, sql } from "./db";

/**
 * Team members of a business. The main sign in (the owner) invites a Google email; the invite does nothing until
 * that person signs in with that verified email and accepts it. Members sign in as themselves (their own email in
 * the session), see and work on the business, and can never change its Google connection.
 */

/** Most team members, and most invites waiting, per business. */
export const TEAM_CAP = 20;
/** How long an invite can be accepted. */
export const INVITE_DAYS = 14;

export const MEMBER_GOOGLE_REFUSAL = "Only the main sign in can connect Google for this business.";
/** Connections, autopilot settings, publishing, sending and spending are for the main sign in only. */
export const OWNER_ONLY = "Only the main sign in can do this for the business.";

/**
 * Actions inside shared endpoints that only the main sign in may take (pure). Members may still read, draft, plan,
 * keep the CRM and send themselves a newsletter test.
 */
const OWNER_ONLY_ACTIONS: Record<string, readonly string[]> = {
  crm: ["email", "settings"],
  newsletter: ["settings", "import", "add", "shopify", "approve", "retry"],
  social: ["approve"],
  storeAudit: ["apply-price", "undo-price"],
  speed: ["shrink", "undo"],
  conversion: ["add", "undo"],
  fix: ["approve"],
};

export function ownerOnlyAction(area: keyof typeof OWNER_ONLY_ACTIONS | string, action: unknown): boolean {
  return typeof action === "string" && (OWNER_ONLY_ACTIONS[area] ?? []).includes(action);
}

/** The refusal for a member taking an owner only action, or null when allowed (pure). */
export function memberRefusal(role: Role, area: string, action: unknown): string | null {
  return role === "member" && ownerOnlyAction(area, action) ? OWNER_ONLY : null;
}

const yes = (v: string | null | undefined) => v === "t" || v === "true";

/**
 * Where a Google sign in lands, from facts only (pure).
 * An owner of their own business always lands in it by default, and so does a platform owner set on the server.
 * Someone who owns no business with data and is a member of one or more lands in the one they used last.
 * Everyone else lands in their own business (created on first sign in, as before).
 * A pending invite never changes where anyone lands: only an accepted one does.
 */
export function landingFor(f: {
  ownId: string | null;
  ownHasData: boolean;
  serverAdmin: boolean;
  /** Businesses the person accepted, most recently used first. */
  memberships: string[];
}): { accountId: string | null; role: Role } {
  if (f.serverAdmin || (f.ownId && f.ownHasData) || !f.memberships.length) return { accountId: f.ownId, role: "owner" };
  return { accountId: f.memberships[0], role: "member" };
}

/** Why an invite can't be made, or null when it can (pure). */
export function inviteProblem(f: {
  email: string | null;
  ownerEmail: string;
  role: Role;
  embedded: boolean;
  alreadyMember: boolean;
  members: number;
  pending: number;
  alreadyInvited: boolean;
}): string | null {
  if (f.embedded) return "Open DashPatrol in your browser to manage your team.";
  if (f.role !== "owner") return "Only the main sign in can invite people.";
  if (!f.email) return "That doesn't look like an email address.";
  if (f.email === f.ownerEmail.toLowerCase()) return "That is the main sign in for this business already.";
  if (f.alreadyMember) return "This person is already on your team.";
  if (f.members >= TEAM_CAP) return `A business can have up to ${TEAM_CAP} team members. Remove someone first.`;
  if (!f.alreadyInvited && f.pending >= TEAM_CAP) return `Up to ${TEAM_CAP} invites can wait at once. Cancel one first.`;
  return null;
}

/** Why this person can't remove `target` from the business, or null when they can (pure). */
export function removeProblem(f: { role: Role; person: string; target: string | null; embedded: boolean }): string | null {
  if (f.embedded) return "Open DashPatrol in your browser to manage your team.";
  if (!f.target) return "That doesn't look like an email address.";
  if (f.role === "owner") return null;
  return f.target === f.person.toLowerCase() ? null : "Only the main sign in can remove people.";
}

/** A business's display name: its brand, else its site, else its main sign in. */
async function namesOf(ids: string[]): Promise<Map<string, { name: string; ownerEmail: string }>> {
  const out = new Map<string, { name: string; ownerEmail: string }>();
  if (!ids.length) return out;
  const rows = await sql`
    SELECT a.id, a.email, coalesce(nullif(trim(p.brand_name), ''), nullif(trim(p.site_domain), ''), a.email) AS name
    FROM insights_accounts a LEFT JOIN insights_account_profile p ON p.account_id = a.id
    WHERE a.id = ANY(${`{${ids.join(",")}}`}::bigint[])`;
  for (const r of rows) out.set(r.id!, { name: r.name ?? r.email!, ownerEmail: r.email! });
  return out;
}

/** The person's own business, and whether it has real setup (a website or a store), not only a first sign in. */
async function ownBusiness(person: string): Promise<{ id: string; hasData: boolean } | null> {
  const [row] = await sql`
    SELECT a.id,
      (coalesce(nullif(trim(p.site_domain), ''), nullif(trim(ap.shop_domain), '')) IS NOT NULL) AS has_data
    FROM insights_accounts a
    LEFT JOIN insights_account_profile p ON p.account_id = a.id
    LEFT JOIN insights_account_autopilot ap ON ap.account_id = a.id
    WHERE lower(a.email) = ${person}`;
  return row?.id ? { id: row.id, hasData: yes(row.has_data) } : null;
}

async function membershipsOf(person: string): Promise<string[]> {
  const rows = await sql`SELECT account_id FROM insights_account_members WHERE lower(email) = ${person} ORDER BY last_used_at DESC, account_id`;
  return rows.map((r) => r.account_id!);
}

/** Where this verified Google email lands when it signs in. accountId null: a new business of their own is made. */
export async function signInLanding(rawPerson: string): Promise<{ accountId: string | null; role: Role; ownId: string | null }> {
  const person = rawPerson.toLowerCase();
  await ensureSchema();
  const [own, memberships] = await Promise.all([ownBusiness(person), membershipsOf(person)]);
  const pick = landingFor({ ownId: own?.id ?? null, ownHasData: own?.hasData ?? false, serverAdmin: isAdminEmail(person), memberships });
  if (pick.role === "member" && pick.accountId) await touchMembership(pick.accountId, person);
  return { ...pick, ownId: own?.id ?? null };
}

async function touchMembership(accountId: string, person: string): Promise<void> {
  await sql`UPDATE insights_account_members SET last_used_at = now() WHERE account_id = ${accountId} AND lower(email) = ${person}`;
}

/** The role this person may switch into for a business, or null when they have none there. */
export async function switchRole(rawPerson: string, accountId: string): Promise<Role | null> {
  const person = rawPerson.toLowerCase();
  if (!/^\d+$/.test(accountId)) return null;
  await ensureSchema();
  const [row] = await sql`
    SELECT a.email,
      EXISTS (SELECT 1 FROM insights_account_members m WHERE m.account_id = a.id AND lower(m.email) = ${person}) AS member
    FROM insights_accounts a WHERE a.id = ${accountId}`;
  if (!row?.email) return null;
  if (row.email.toLowerCase() === person) return "owner";
  if (!yes(row.member)) return null;
  await touchMembership(accountId, person);
  return "member";
}

export interface TeamView {
  you: string;
  role: Role;
  owner: string;
  business: string;
  embedded: boolean;
  /** Only for the main sign in. */
  members: { email: string; invitedBy: string; joinedAt: string }[];
  invites: { email: string; invitedBy: string; expiresAt: string }[];
  /** Invites waiting for the signed in person to accept. */
  pending: { token: string; business: string; owner: string; expiresAt: string }[];
  /** Whether the signed in person has a business of their own (it stays when they join another). */
  ownsBusiness: boolean;
  /** Every business this person can open, for the switcher. */
  businesses: { id: string; name: string; role: Role; current: boolean }[];
  cap: number;
}

export async function teamView(account: Account): Promise<TeamView> {
  await ensureSchema();
  const person = account.email.toLowerCase();
  const owner = account.role === "owner" && !account.embedded;
  const [members, invites, pending, own, memberships] = await Promise.all([
    owner ? sql`SELECT email, invited_by, joined_at FROM insights_account_members WHERE account_id = ${account.id} ORDER BY joined_at` : Promise.resolve([]),
    owner
      ? sql`SELECT email, invited_by, expires_at FROM insights_account_invites WHERE account_id = ${account.id} AND expires_at > now() ORDER BY created_at`
      : Promise.resolve([]),
    account.embedded
      ? Promise.resolve([])
      : sql`SELECT account_id, token, expires_at FROM insights_account_invites WHERE lower(email) = ${person} AND expires_at > now() ORDER BY created_at`,
    account.embedded ? Promise.resolve(null) : ownBusiness(person),
    account.embedded ? Promise.resolve([] as string[]) : membershipsOf(person),
  ]);
  const ids = [...new Set([account.id, ...(own ? [own.id] : []), ...memberships, ...pending.map((p) => p.account_id!)])];
  const names = await namesOf(ids);
  const nameOf = (id: string) => names.get(id)?.name ?? "a business";
  const businesses = [
    ...(own ? [{ id: own.id, name: nameOf(own.id), role: "owner" as Role, current: own.id === account.id }] : []),
    ...memberships.filter((id) => id !== own?.id).map((id) => ({ id, name: nameOf(id), role: "member" as Role, current: id === account.id })),
  ];
  return {
    you: account.email,
    role: account.role,
    owner: account.ownerEmail,
    business: nameOf(account.id),
    embedded: Boolean(account.embedded),
    members: members.map((m) => ({ email: m.email!, invitedBy: m.invited_by!, joinedAt: m.joined_at! })),
    invites: invites.map((i) => ({ email: i.email!, invitedBy: i.invited_by!, expiresAt: i.expires_at! })),
    pending: pending.map((p) => ({ token: p.token!, business: nameOf(p.account_id!), owner: names.get(p.account_id!)?.ownerEmail ?? "", expiresAt: p.expires_at! })),
    ownsBusiness: Boolean(own),
    businesses,
    cap: TEAM_CAP,
  };
}

/** The main sign in invites an email. Says whether that person already has a business of their own here. */
export async function inviteMember(account: Account, raw: unknown): Promise<{ email: string; ownsBusiness: boolean }> {
  await ensureSchema();
  const email = cleanEmail(raw);
  const [counts] = await sql`
    SELECT
      (SELECT count(*) FROM insights_account_members WHERE account_id = ${account.id}) AS members,
      (SELECT count(*) FROM insights_account_invites WHERE account_id = ${account.id} AND expires_at > now()) AS pending,
      EXISTS (SELECT 1 FROM insights_account_members WHERE account_id = ${account.id} AND lower(email) = ${email ?? ""}) AS member,
      EXISTS (SELECT 1 FROM insights_account_invites WHERE account_id = ${account.id} AND lower(email) = ${email ?? ""} AND expires_at > now()) AS invited,
      EXISTS (SELECT 1 FROM insights_accounts WHERE lower(email) = ${email ?? ""}) AS owns`;
  const problem = inviteProblem({
    email,
    ownerEmail: account.ownerEmail,
    role: account.role,
    embedded: Boolean(account.embedded),
    alreadyMember: yes(counts?.member),
    members: Number(counts?.members ?? 0),
    pending: Number(counts?.pending ?? 0),
    alreadyInvited: yes(counts?.invited),
  });
  if (problem) throw new Error(problem);
  const token = crypto.randomBytes(24).toString("base64url");
  // Inviting again renews the invite (a new token, a new expiry). The inviter is the person signed in.
  // The caps are checked again inside the insert itself, so a second tab can't go past them.
  const saved = await sql`
    INSERT INTO insights_account_invites (account_id, email, token, invited_by, expires_at)
    SELECT ${account.id}, ${email}, ${token}, ${account.email}, now() + ${`${INVITE_DAYS} days`}::interval
    WHERE (SELECT count(*) FROM insights_account_members WHERE account_id = ${account.id}) < ${TEAM_CAP}
      AND (
        EXISTS (SELECT 1 FROM insights_account_invites WHERE account_id = ${account.id} AND lower(email) = ${email} AND expires_at > now())
        OR (SELECT count(*) FROM insights_account_invites WHERE account_id = ${account.id} AND expires_at > now()) < ${TEAM_CAP}
      )
    ON CONFLICT (account_id, email) DO UPDATE SET token = EXCLUDED.token, invited_by = EXCLUDED.invited_by,
      created_at = now(), expires_at = EXCLUDED.expires_at
    RETURNING email`;
  if (!saved.length) throw new Error(`Up to ${TEAM_CAP} team members and ${TEAM_CAP} waiting invites. Remove or cancel one first.`);
  return { email: email!, ownsBusiness: yes(counts?.owns) };
}

/** Removes a member or cancels an invite. The main sign in removes anyone; a member removes only themselves. */
export async function removeMember(account: Account, raw: unknown): Promise<void> {
  const target = cleanEmail(raw);
  const problem = removeProblem({ role: account.role, person: account.email, target, embedded: Boolean(account.embedded) });
  if (problem) throw new Error(problem);
  await ensureSchema();
  await sql`DELETE FROM insights_account_members WHERE account_id = ${account.id} AND lower(email) = ${target}`;
  if (account.role === "owner") await sql`DELETE FROM insights_account_invites WHERE account_id = ${account.id} AND lower(email) = ${target}`;
}

/** Accepts an invite made for this exact signed in email. Returns the business joined. */
export async function acceptInvite(rawPerson: string, token: unknown): Promise<string> {
  const person = rawPerson.toLowerCase();
  if (typeof token !== "string" || !token) throw new Error("That invite isn't valid anymore.");
  await ensureSchema();
  const [invite] = await sql`
    SELECT i.account_id, i.invited_by, a.email AS owner,
      (SELECT count(*) FROM insights_account_members m WHERE m.account_id = i.account_id) AS members
    FROM insights_account_invites i JOIN insights_accounts a ON a.id = i.account_id
    WHERE i.token = ${token} AND lower(i.email) = ${person} AND i.expires_at > now()`;
  if (!invite?.account_id) throw new Error("That invite isn't valid anymore. Ask for a new one.");
  if (String(invite.owner).toLowerCase() === person) throw new Error("This is your own business already.");
  const full = `This business already has ${TEAM_CAP} team members.`;
  if (Number(invite.members ?? 0) >= TEAM_CAP) throw new Error(full);
  // The cap again inside the insert (someone already on the team just stays).
  const joined = await sql`
    INSERT INTO insights_account_members (account_id, email, invited_by)
    SELECT ${invite.account_id}, ${person}, ${invite.invited_by}
    WHERE (SELECT count(*) FROM insights_account_members WHERE account_id = ${invite.account_id}) < ${TEAM_CAP}
      OR EXISTS (SELECT 1 FROM insights_account_members WHERE account_id = ${invite.account_id} AND lower(email) = ${person})
    ON CONFLICT (account_id, email) DO UPDATE SET last_used_at = now()
    RETURNING account_id`;
  if (!joined.length) throw new Error(full);
  await sql`DELETE FROM insights_account_invites WHERE account_id = ${invite.account_id} AND lower(email) = ${person}`;
  return invite.account_id;
}

/** Turns down an invite made for this signed in email. */
export async function declineInvite(rawPerson: string, token: unknown): Promise<void> {
  if (typeof token !== "string" || !token) return;
  await ensureSchema();
  await sql`DELETE FROM insights_account_invites WHERE token = ${token} AND lower(email) = ${rawPerson.toLowerCase()}`;
}

/** The person's own business id, if they have one (where they go after leaving another). */
export async function ownBusinessId(rawPerson: string): Promise<string | null> {
  await ensureSchema();
  return (await ownBusiness(rawPerson.toLowerCase()))?.id ?? null;
}
