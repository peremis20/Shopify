/**
 * The journalist CRM's plain rules, shared by the server and the Outreach tab (no server imports here): the statuses,
 * what "Emailed" sets, when a follow up is due, the mailto link the owner's own email app opens, a journalist the
 * owner adds by hand, and the CSV download. Nothing here sends anything.
 */

export type CrmStatus = "new" | "emailed" | "replied" | "covered" | "not_interested";
export const CRM_STATUSES: CrmStatus[] = ["new", "emailed", "replied", "covered", "not_interested"];
export const STATUS_LABEL: Record<CrmStatus, string> = { new: "New", emailed: "Emailed", replied: "Replied", covered: "Covered us", not_interested: "Not interested" };

/** A stored status in today's words: the earlier "pitched" is Emailed, "dismissed" is Not interested, anything else New. */
export function normalStatus(s: unknown): CrmStatus {
  if (s === "pitched") return "emailed";
  if (s === "dismissed") return "not_interested";
  return CRM_STATUSES.includes(s as CrmStatus) ? (s as CrmStatus) : "new";
}

/** Days after Emailed that the follow up falls on, unless the owner picks another day. */
export const FOLLOW_UP_DAYS = 7;

/** A calendar day as YYYY-MM-DD (UTC). */
export const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
export const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** What the owner's "Yes, I sent it" sets: Emailed, today, and a follow up a week later. */
export function emailedPatch(now = Date.now()): { status: CrmStatus; statusAt: string; lastContacted: string; followUp: string } {
  return { status: "emailed", statusAt: new Date(now).toISOString(), lastContacted: dayOf(now), followUp: dayOf(now + FOLLOW_UP_DAYS * 864e5) };
}

/** What a status picked in the dropdown sets. Emailed counts as a contact today, like the email button. */
export function statusPatch(status: CrmStatus, now = Date.now()): Record<string, string> {
  if (status === "emailed") return emailedPatch(now);
  return { status, statusAt: new Date(now).toISOString() };
}

/** A follow up is due on or before today, while the journalist was emailed and hasn't answered either way. */
export const followUpDue = (j: { status: string; followUp?: string | null }, today = dayOf(Date.now())) =>
  j.status === "emailed" && isDay(j.followUp) && j.followUp <= today;

/**
 * The mailto link the Email button opens in the owner's own email app: To (when an address is known), subject and body
 * filled in, every part encoded so nothing in them can change the link. The owner edits and sends it there.
 */
export function mailtoFor(email: string | null | undefined, subject: string, body: string): string {
  const to = email && /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(email) ? encodeURIComponent(email).replace(/%40/g, "@") : "";
  const params = [`subject=${encodeURIComponent(subject)}`, `body=${encodeURIComponent(body.replace(/\r?\n/g, "\r\n"))}`].join("&");
  return `mailto:${to}?${params}`;
}

/** The fields the owner fills to add a journalist by hand. */
export interface ManualInput {
  name?: unknown;
  jobTitle?: unknown;
  outlet?: unknown;
  email?: unknown;
  phone?: unknown;
  articleUrl?: unknown;
  articleTitle?: unknown;
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * A journalist the owner enters: their own data, kept as they typed it (trimmed), with only the checks that keep the
 * list working: a name, an outlet, an email that looks like one, a phone made of phone characters, an http link.
 */
export function manualJournalist(input: ManualInput): { ok: true; value: { name: string; jobTitle: string | null; outlet: string; email: string | null; phone: string | null; articleUrl: string | null; articleTitle: string | null } } | { ok: false; error: string } {
  const name = text(input.name, 80);
  const outlet = text(input.outlet, 80);
  const email = text(input.email, 120).toLowerCase();
  const phone = text(input.phone, 40);
  const articleUrl = text(input.articleUrl, 500);
  if (!name) return { ok: false, error: "Add their name." };
  if (!outlet) return { ok: false, error: "Add where they publish." };
  if (email && !/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(email)) return { ok: false, error: "That email doesn't look right." };
  if (phone && !/^\+?[\d\s().]{7,25}$/.test(phone)) return { ok: false, error: "That phone number doesn't look right." };
  if (articleUrl) {
    try {
      if (!/^https?:$/.test(new URL(articleUrl).protocol)) throw new Error("bad");
    } catch {
      return { ok: false, error: "The article link should start with https://." };
    }
  }
  return {
    ok: true,
    value: { name, jobTitle: text(input.jobTitle, 80) || null, outlet, email: email || null, phone: phone || null, articleUrl: articleUrl || null, articleTitle: text(input.articleTitle, 200) || null },
  };
}

export interface CsvRow {
  name: string;
  jobTitle?: string | null;
  outlet: string;
  email?: string | null;
  phone?: string | null;
  articleTitle?: string | null;
  articleUrl?: string | null;
  status: string;
  lastContacted?: string | null;
  followUp?: string | null;
  notes?: string | null;
}

/** One CSV cell: quoted, and never read as a formula by a spreadsheet. */
const cell = (v: unknown) => {
  let s = v === null || v === undefined ? "" : String(v);
  // A formula sign after any spaces, or a value starting with a tab or carriage return, is shown as text.
  if (/^\s*[=+\-@|]/.test(s) || /^[\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

/** The journalist list as a CSV file, one row each. */
export function journalistsCsv(rows: CsvRow[]): string {
  const head = ["Name", "Job title", "Outlet", "Email", "Phone", "Article", "Article link", "Status", "Last contacted", "Follow up", "Notes"];
  const lines = rows.map((r) =>
    [r.name, r.jobTitle, r.outlet, r.email, r.phone, r.articleTitle, r.articleUrl, STATUS_LABEL[r.status as CrmStatus] ?? r.status, r.lastContacted, r.followUp, r.notes].map(cell).join(","),
  );
  return [head.map(cell).join(","), ...lines].join("\r\n") + "\r\n";
}

/** What the owner can change on a journalist from the list. */
export type OwnerAction =
  | { kind: "status"; status: unknown }
  | { kind: "emailed" }
  | { kind: "notes"; notes: unknown }
  | { kind: "followUp"; date: unknown }
  | { kind: "edit"; subject: unknown; body: unknown };

/** The owner fields one action sets, or why it can't. Only the owner's own choices, as they made them. */
export function ownerPatch(a: OwnerAction, now = Date.now()): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } {
  switch (a.kind) {
    case "status":
      return CRM_STATUSES.includes(a.status as CrmStatus) ? { ok: true, patch: statusPatch(a.status as CrmStatus, now) } : { ok: false, error: "Pick a status." };
    case "emailed":
      return { ok: true, patch: emailedPatch(now) };
    case "notes":
      return { ok: true, patch: { notes: typeof a.notes === "string" ? a.notes.trim().slice(0, 500) || null : null } };
    case "followUp":
      if (a.date === null || a.date === "") return { ok: true, patch: { followUp: null } };
      return isDay(a.date) ? { ok: true, patch: { followUp: a.date } } : { ok: false, error: "Pick a date." };
    case "edit": {
      const subject = typeof a.subject === "string" ? a.subject.trim().slice(0, 200) : "";
      const body = typeof a.body === "string" ? a.body.trim().slice(0, 5000) : "";
      return subject && body ? { ok: true, patch: { pitchEdit: { subject, body } } } : { ok: false, error: "The subject and the email can't be empty." };
    }
  }
}
