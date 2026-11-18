import crypto from "crypto";
import { ensureSchema, sql } from "./db";
import { sendOneEmail } from "./gmail";

/**
 * The owner's own CRM: contacts, a sales pipeline, and everything done with each contact (notes, calls, meetings,
 * emails and follow up tasks) on one timeline. It is kept in DashPatrol on the site's account, so it works the same
 * whatever the site is built on and never depends on another service. Website form requests become contacts on their
 * own (leads.ts). Emails go out from the owner's Gmail, one at a time, only on the owner's Send click.
 *
 * Each site keeps its own contacts only.
 */

export const DEFAULT_STAGES = ["New", "Contacted", "Meeting", "Proposal", "Won", "Lost"];

export interface Contact {
  id: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  title: string;
  kind: string;
  stage: string;
  value: number;
  tags: string[];
  source: string;
  address: string;
  website: string;
  followUp: string | null;
  createdAt: string;
  updatedAt: string;
  lastContactAt: string | null;
  /** Open tasks on this contact. */
  openTasks: number;
}

export type ActivityKind = "note" | "call" | "meeting" | "email" | "task" | "stage" | "lead";

export interface Activity {
  id: string;
  contactId: string;
  kind: ActivityKind;
  at: string;
  subject: string;
  body: string;
  due: string | null;
  done: boolean;
}

export interface Template {
  id: string;
  name: string;
  subject: string;
  body: string;
}

const cut = (v: unknown, n: number) =>
  typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, n) : "";
const EMAIL = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const day = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const ID = /^\d{1,18}$/;

let ready: Promise<void> | null = null;
function schema(): Promise<void> {
  ready ??= (async () => {
    await ensureSchema();
    await sql`CREATE TABLE IF NOT EXISTS insights_crm_contacts (
      id bigserial PRIMARY KEY,
      account_id bigint NOT NULL,
      name text NOT NULL DEFAULT '',
      email text NOT NULL DEFAULT '',
      phone text NOT NULL DEFAULT '',
      company text NOT NULL DEFAULT '',
      title text NOT NULL DEFAULT '',
      kind text NOT NULL DEFAULT '',
      stage text NOT NULL DEFAULT 'New',
      value numeric NOT NULL DEFAULT 0,
      tags jsonb NOT NULL DEFAULT '[]',
      source text NOT NULL DEFAULT '',
      address text NOT NULL DEFAULT '',
      website text NOT NULL DEFAULT '',
      follow_up date,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      last_contact_at timestamptz,
      archived boolean NOT NULL DEFAULT false
    )`;
    await sql`CREATE INDEX IF NOT EXISTS insights_crm_contacts_account ON insights_crm_contacts (account_id, updated_at DESC)`;
    await sql`CREATE TABLE IF NOT EXISTS insights_crm_activities (
      id bigserial PRIMARY KEY,
      account_id bigint NOT NULL,
      contact_id bigint NOT NULL REFERENCES insights_crm_contacts (id) ON DELETE CASCADE,
      kind text NOT NULL,
      at timestamptz NOT NULL DEFAULT now(),
      subject text NOT NULL DEFAULT '',
      body text NOT NULL DEFAULT '',
      due date,
      done boolean NOT NULL DEFAULT false
    )`;
    await sql`CREATE INDEX IF NOT EXISTS insights_crm_activities_contact ON insights_crm_activities (contact_id, at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS insights_crm_activities_tasks ON insights_crm_activities (account_id, done, due) WHERE kind = 'task'`;
    await sql`CREATE TABLE IF NOT EXISTS insights_crm_templates (
      id bigserial PRIMARY KEY,
      account_id bigint NOT NULL,
      name text NOT NULL,
      subject text NOT NULL,
      body text NOT NULL
    )`;
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

const stagesKey = (accountId: string) => `crm_stages:${accountId}`;

/** The account's pipeline stages, in order. */
export async function readStages(accountId: string): Promise<string[]> {
  await schema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${stagesKey(accountId)}`;
  try {
    const list = row?.value ? (JSON.parse(row.value) as unknown) : null;
    if (Array.isArray(list) && list.length) return list.map(String);
  } catch {
    /* an unreadable list falls back to the defaults */
  }
  return DEFAULT_STAGES;
}

/** Cleans a stage list the owner typed: names kept short, no repeats, 2 to 12 stages. */
export function cleanStages(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of input) {
    const name = cut(s, 30);
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out.length >= 2 && out.length <= 12 ? out : null;
}

export async function saveStages(accountId: string, input: unknown): Promise<string[]> {
  const stages = cleanStages(input);
  if (!stages) throw new Error("Use between 2 and 12 stage names.");
  const before = await readStages(accountId);
  await sql`INSERT INTO insights_settings (key, value) VALUES (${stagesKey(accountId)}, ${JSON.stringify(stages)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  // A contact in a stage that was taken out moves to the first stage, so nobody falls off the board.
  const gone = before.filter((s) => !stages.includes(s));
  if (gone.length) {
    await sql`UPDATE insights_crm_contacts SET stage = ${stages[0]}, updated_at = now()
      WHERE account_id = ${accountId} AND stage = ANY(string_to_array(${gone.join("\u001f")}, ${"\u001f"}))`;
  }
  return stages;
}

/** A contact's fields from the owner's form or an import row, cleaned. */
export function cleanContact(input: unknown, stages: string[]): Omit<Contact, "id" | "createdAt" | "updatedAt" | "lastContactAt" | "openTasks"> | null {
  if (!input || typeof input !== "object") return null;
  const b = input as Record<string, unknown>;
  const email = cut(b.email, 254).toLowerCase();
  const name = cut(b.name, 120);
  const company = cut(b.company, 120);
  if (email && !EMAIL.test(email)) return null;
  if (!name && !email && !company) return null;
  const stage = stages.find((s) => s.toLowerCase() === cut(b.stage, 30).toLowerCase()) ?? stages[0];
  const raw = typeof b.value === "number" ? b.value : Number(String(b.value ?? "").replace(/[$,\s]/g, ""));
  const tags = (Array.isArray(b.tags) ? b.tags : String(b.tags ?? "").split(","))
    .map((t) => cut(t, 30))
    .filter(Boolean);
  return {
    name,
    email,
    phone: cut(b.phone, 40),
    company,
    title: cut(b.title, 80),
    kind: cut(b.kind, 40),
    stage,
    value: Number.isFinite(raw) && raw > 0 ? Math.min(Math.round(raw * 100) / 100, 1e9) : 0,
    tags: [...new Set(tags)].slice(0, 12),
    source: cut(b.source, 80),
    address: cut(b.address, 200),
    website: cut(b.website, 200),
    followUp: day(b.followUp),
  };
}

type Row = Record<string, string | null>;
const contactOf = (r: Row): Contact => ({
  id: String(r.id),
  name: r.name ?? "",
  email: r.email ?? "",
  phone: r.phone ?? "",
  company: r.company ?? "",
  title: r.title ?? "",
  kind: r.kind ?? "",
  stage: r.stage ?? "",
  value: Number(r.value ?? 0),
  tags: (() => {
    try {
      const t = typeof r.tags === "string" ? JSON.parse(r.tags) : r.tags;
      return Array.isArray(t) ? t.map(String) : [];
    } catch {
      return [];
    }
  })(),
  source: r.source ?? "",
  address: r.address ?? "",
  website: r.website ?? "",
  followUp: r.follow_up ? String(r.follow_up).slice(0, 10) : null,
  createdAt: new Date(String(r.created_at)).toISOString(),
  updatedAt: new Date(String(r.updated_at)).toISOString(),
  lastContactAt: r.last_contact_at ? new Date(String(r.last_contact_at)).toISOString() : null,
  openTasks: Number(r.open_tasks ?? 0),
});
const activityOf = (r: Row): Activity => ({
  id: String(r.id),
  contactId: String(r.contact_id),
  kind: (r.kind ?? "note") as ActivityKind,
  at: new Date(String(r.at)).toISOString(),
  subject: r.subject ?? "",
  body: r.body ?? "",
  due: r.due ? String(r.due).slice(0, 10) : null,
  done: r.done === "t" || r.done === "true" || (r.done as unknown) === true,
});

/** Everything the CRM page shows: contacts, stages, open tasks and templates. */
export async function crmView(accountId: string) {
  await schema();
  const [contacts, tasks, templates, stages] = await Promise.all([
    sql`SELECT c.*, (SELECT count(*) FROM insights_crm_activities a WHERE a.contact_id = c.id AND a.kind = 'task' AND NOT a.done) AS open_tasks
      FROM insights_crm_contacts c WHERE c.account_id = ${accountId} AND NOT c.archived ORDER BY c.updated_at DESC LIMIT 2000`,
    sql`SELECT * FROM insights_crm_activities WHERE account_id = ${accountId} AND kind = 'task' AND NOT done ORDER BY due NULLS LAST, at LIMIT 300`,
    sql`SELECT * FROM insights_crm_templates WHERE account_id = ${accountId} ORDER BY name`,
    readStages(accountId),
  ]);
  return {
    stages,
    contacts: contacts.map(contactOf),
    tasks: tasks.map(activityOf),
    templates: templates.map((t) => ({ id: String(t.id), name: t.name ?? "", subject: t.subject ?? "", body: t.body ?? "" })),
  };
}

/** One contact and its whole timeline, newest first. */
export async function contactTimeline(accountId: string, id: string) {
  await schema();
  if (!ID.test(id)) return null;
  const [c] = await sql`SELECT c.*, (SELECT count(*) FROM insights_crm_activities a WHERE a.contact_id = c.id AND a.kind = 'task' AND NOT a.done) AS open_tasks
    FROM insights_crm_contacts c WHERE c.id = ${id} AND c.account_id = ${accountId}`;
  if (!c) return null;
  const acts = await sql`SELECT * FROM insights_crm_activities WHERE contact_id = ${id} AND account_id = ${accountId} ORDER BY at DESC LIMIT 500`;
  return { contact: contactOf(c), activities: acts.map(activityOf) };
}

async function owned(accountId: string, id: unknown): Promise<string | null> {
  if (typeof id !== "string" || !ID.test(id)) return null;
  const [row] = await sql`SELECT id FROM insights_crm_contacts WHERE id = ${id} AND account_id = ${accountId}`;
  return row ? String(row.id) : null;
}

async function log(accountId: string, contactId: string, kind: ActivityKind, subject: string, body = "", due: string | null = null) {
  await sql`INSERT INTO insights_crm_activities (account_id, contact_id, kind, subject, body, due)
    VALUES (${accountId}, ${contactId}, ${kind}, ${subject.slice(0, 300)}, ${body.slice(0, 20_000)}, ${due})`;
}

/** Adds a contact, or updates one (with `id`). A stage change is written on the timeline. */
export async function saveContact(accountId: string, input: unknown, id?: unknown): Promise<string> {
  await schema();
  const stages = await readStages(accountId);
  const c = cleanContact(input, stages);
  if (!c) throw new Error("Add at least a name, a company or a valid email.");
  if (id !== undefined && id !== null && id !== "") {
    const cid = await owned(accountId, id);
    if (!cid) throw new Error("That contact isn't here anymore.");
    const [before] = await sql`SELECT stage FROM insights_crm_contacts WHERE id = ${cid}`;
    await sql`UPDATE insights_crm_contacts SET name = ${c.name}, email = ${c.email}, phone = ${c.phone}, company = ${c.company}, title = ${c.title},
      kind = ${c.kind}, stage = ${c.stage}, value = ${c.value}, tags = ${JSON.stringify(c.tags)}::jsonb, source = ${c.source}, address = ${c.address},
      website = ${c.website}, follow_up = ${c.followUp}, updated_at = now() WHERE id = ${cid}`;
    if (before?.stage !== c.stage) await log(accountId, cid, "stage", `Moved to ${c.stage}`);
    return cid;
  }
  if (c.email) {
    const [dup] = await sql`SELECT id FROM insights_crm_contacts WHERE account_id = ${accountId} AND email = ${c.email} AND NOT archived`;
    if (dup) throw new Error("A contact with that email is already here. Search for it to open it.");
  }
  const [row] = await sql`INSERT INTO insights_crm_contacts (account_id, name, email, phone, company, title, kind, stage, value, tags, source, address, website, follow_up)
    VALUES (${accountId}, ${c.name}, ${c.email}, ${c.phone}, ${c.company}, ${c.title}, ${c.kind}, ${c.stage}, ${c.value}, ${JSON.stringify(c.tags)}::jsonb,
      ${c.source || "Added by hand"}, ${c.address}, ${c.website}, ${c.followUp}) RETURNING id`;
  return String(row!.id);
}

/** Moves a contact to another stage (the board's quick move). */
export async function moveContact(accountId: string, id: unknown, stage: unknown): Promise<void> {
  await schema();
  const cid = await owned(accountId, id);
  if (!cid) throw new Error("That contact isn't here anymore.");
  const stages = await readStages(accountId);
  const to = stages.find((s) => s === stage);
  if (!to) throw new Error("That stage isn't on your pipeline.");
  const [before] = await sql`UPDATE insights_crm_contacts SET stage = ${to}, updated_at = now() WHERE id = ${cid} AND stage <> ${to} RETURNING id`;
  if (before) await log(accountId, cid, "stage", `Moved to ${to}`);
}

/** Takes a contact off the lists. Its history is kept, and Restore brings it back. */
export async function archiveContact(accountId: string, id: unknown, archived = true): Promise<void> {
  await schema();
  const cid = await owned(accountId, id);
  if (!cid) throw new Error("That contact isn't here anymore.");
  await sql`UPDATE insights_crm_contacts SET archived = ${archived}, updated_at = now() WHERE id = ${cid}`;
}

/** The archived contacts, so one can be restored. */
export async function archivedContacts(accountId: string): Promise<Contact[]> {
  await schema();
  const rows = await sql`SELECT c.*, 0 AS open_tasks FROM insights_crm_contacts c WHERE c.account_id = ${accountId} AND c.archived ORDER BY c.updated_at DESC LIMIT 500`;
  return rows.map(contactOf);
}

/** Adds a note, call, meeting or task to a contact. Calls and meetings count as being in touch. */
export async function addActivity(accountId: string, contactId: unknown, input: unknown): Promise<void> {
  await schema();
  const cid = await owned(accountId, contactId);
  if (!cid) throw new Error("That contact isn't here anymore.");
  const b = (input ?? {}) as Record<string, unknown>;
  const kind = (["note", "call", "meeting", "task"] as const).find((k) => k === b.kind);
  if (!kind) throw new Error("Pick note, call, meeting or task.");
  const subject = cut(b.subject, 300);
  const body = cut(b.body, 20_000);
  if (!subject && !body) throw new Error(kind === "task" ? "Say what needs doing." : "Write something first.");
  const due = kind === "task" ? day(b.due) : null;
  await log(accountId, cid, kind, subject, body, due);
  if (kind === "call" || kind === "meeting") {
    await sql`UPDATE insights_crm_contacts SET last_contact_at = now(), updated_at = now() WHERE id = ${cid}`;
  } else {
    await sql`UPDATE insights_crm_contacts SET updated_at = now() WHERE id = ${cid}`;
  }
}

/** Marks a task done or open again. */
export async function setTaskDone(accountId: string, taskId: unknown, done: boolean): Promise<void> {
  await schema();
  if (typeof taskId !== "string" || !ID.test(taskId)) throw new Error("That task isn't here anymore.");
  const [row] = await sql`UPDATE insights_crm_activities SET done = ${done} WHERE id = ${taskId} AND account_id = ${accountId} AND kind = 'task' RETURNING id`;
  if (!row) throw new Error("That task isn't here anymore.");
}

/** Deletes a note or task the owner added (stage changes and sent emails stay, as the record of what happened). */
export async function deleteActivity(accountId: string, id: unknown): Promise<void> {
  await schema();
  if (typeof id !== "string" || !ID.test(id)) throw new Error("That item isn't here anymore.");
  const [row] = await sql`DELETE FROM insights_crm_activities WHERE id = ${id} AND account_id = ${accountId} AND kind IN ('note', 'call', 'meeting', 'task') RETURNING id`;
  if (!row) throw new Error("That item can't be deleted.");
}

/** Fills {first_name}, {name}, {company} and {my_business} in a template for one contact. */
export function fillTemplate(text: string, c: Pick<Contact, "name" | "company">, business = ""): string {
  const first = c.name.split(/\s+/)[0] ?? "";
  return text
    .replace(/\{first_name\}/gi, first || "there")
    .replace(/\{name\}/gi, c.name || "there")
    .replace(/\{company\}/gi, c.company || "your business")
    .replace(/\{my_business\}/gi, business);
}

/**
 * Sends one email to a contact from the owner's Gmail (the owner's Send click) and puts it on the timeline. The
 * shared daily limit keeps every send from the app together, so the CRM can never be used for mass mail.
 */
export async function emailContact(accountId: string, contactId: unknown, input: unknown) {
  await schema();
  const cid = await owned(accountId, contactId);
  if (!cid) return { ok: false as const, status: 404, error: "That contact isn't here anymore." };
  const b = (input ?? {}) as Record<string, unknown>;
  const out = await sendOneEmail(accountId, { prospectUrl: `crm:${cid}:${crypto.randomUUID()}`, to: b.to, subject: b.subject, body: b.body });
  if (!out.ok) return out;
  await log(accountId, cid, "email", cut(b.subject, 300), cut(b.body, 20_000));
  await sql`UPDATE insights_crm_contacts SET last_contact_at = now(), updated_at = now() WHERE id = ${cid}`;
  return out;
}

/** Records an email the owner sent from their own email program ("Open in my email"), so the timeline stays whole. */
export async function logEmail(accountId: string, contactId: unknown, input: unknown): Promise<void> {
  await schema();
  const cid = await owned(accountId, contactId);
  if (!cid) throw new Error("That contact isn't here anymore.");
  const b = (input ?? {}) as Record<string, unknown>;
  await log(accountId, cid, "email", cut(b.subject, 300) || "Email sent from my email", cut(b.body, 20_000));
  await sql`UPDATE insights_crm_contacts SET last_contact_at = now(), updated_at = now() WHERE id = ${cid}`;
}

export async function saveTemplate(accountId: string, input: unknown): Promise<void> {
  await schema();
  const b = (input ?? {}) as Record<string, unknown>;
  const name = cut(b.name, 80);
  const subject = cut(b.subject, 300);
  const body = cut(b.body, 20_000);
  if (!name || !subject || !body) throw new Error("A template needs a name, a subject and a message.");
  if (typeof b.id === "string" && ID.test(b.id)) {
    const [row] = await sql`UPDATE insights_crm_templates SET name = ${name}, subject = ${subject}, body = ${body} WHERE id = ${b.id} AND account_id = ${accountId} RETURNING id`;
    if (!row) throw new Error("That template isn't here anymore.");
    return;
  }
  const [n] = await sql`SELECT count(*)::int AS n FROM insights_crm_templates WHERE account_id = ${accountId}`;
  if (Number(n?.n ?? 0) >= 50) throw new Error("You have 50 templates, the most allowed. Delete one first.");
  await sql`INSERT INTO insights_crm_templates (account_id, name, subject, body) VALUES (${accountId}, ${name}, ${subject}, ${body})`;
}

export async function deleteTemplate(accountId: string, id: unknown): Promise<void> {
  await schema();
  if (typeof id !== "string" || !ID.test(id)) return;
  await sql`DELETE FROM insights_crm_templates WHERE id = ${id} AND account_id = ${accountId}`;
}

/**
 * Adds rows from a spreadsheet. A row whose email is already a contact fills in that contact's empty fields only;
 * nothing the owner already wrote is replaced. Returns how many were added, updated and skipped.
 */
export async function importContacts(accountId: string, rows: unknown): Promise<{ added: number; updated: number; skipped: number }> {
  await schema();
  if (!Array.isArray(rows)) throw new Error("Nothing to import.");
  if (rows.length > 1000) throw new Error("Import up to 1,000 rows at a time.");
  const stages = await readStages(accountId);
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const r of rows) {
    const c = cleanContact({ ...(r as object), source: cut((r as Record<string, unknown>)?.source, 80) || "Imported" }, stages);
    if (!c) {
      skipped++;
      continue;
    }
    const [dup] = c.email ? await sql`SELECT id FROM insights_crm_contacts WHERE account_id = ${accountId} AND email = ${c.email} AND NOT archived` : [];
    if (dup) {
      await sql`UPDATE insights_crm_contacts SET
        name = CASE WHEN name = '' THEN ${c.name} ELSE name END, phone = CASE WHEN phone = '' THEN ${c.phone} ELSE phone END,
        company = CASE WHEN company = '' THEN ${c.company} ELSE company END, title = CASE WHEN title = '' THEN ${c.title} ELSE title END,
        kind = CASE WHEN kind = '' THEN ${c.kind} ELSE kind END, address = CASE WHEN address = '' THEN ${c.address} ELSE address END,
        website = CASE WHEN website = '' THEN ${c.website} ELSE website END, updated_at = now()
        WHERE id = ${dup.id}`;
      updated++;
      continue;
    }
    await sql`INSERT INTO insights_crm_contacts (account_id, name, email, phone, company, title, kind, stage, value, tags, source, address, website, follow_up)
      VALUES (${accountId}, ${c.name}, ${c.email}, ${c.phone}, ${c.company}, ${c.title}, ${c.kind}, ${c.stage}, ${c.value}, ${JSON.stringify(c.tags)}::jsonb,
        ${c.source}, ${c.address}, ${c.website}, ${c.followUp})`;
    added++;
  }
  return { added, updated, skipped };
}

/**
 * A website form request becomes a contact (or is added to the contact with that email) at the first stage, with a
 * "Website request" entry on the timeline holding what they wrote.
 */
export async function contactFromLead(
  accountId: string,
  lead: { business: string; name: string; email: string; phone: string; interest: string; type: string; details: string; source: string },
): Promise<void> {
  await schema();
  const stages = await readStages(accountId);
  const [dup] = await sql`SELECT id FROM insights_crm_contacts WHERE account_id = ${accountId} AND email = ${lead.email} AND NOT archived`;
  let cid = dup ? String(dup.id) : null;
  if (!cid) {
    const [row] = await sql`INSERT INTO insights_crm_contacts (account_id, name, email, phone, company, kind, stage, tags, source)
      VALUES (${accountId}, ${lead.name}, ${lead.email}, ${lead.phone}, ${lead.business}, ${lead.type}, ${stages[0]},
        ${JSON.stringify(lead.interest ? [lead.interest.slice(0, 30)] : [])}::jsonb, ${lead.source || "Website form"}) RETURNING id`;
    cid = String(row!.id);
  }
  const body = [
    lead.business && `Business: ${lead.business}`,
    lead.type && `Business type: ${lead.type}`,
    lead.interest && `Interested in: ${lead.interest}`,
    lead.phone && `Phone: ${lead.phone}`,
    lead.details && `Details: ${lead.details}`,
  ]
    .filter(Boolean)
    .join("\n");
  await log(accountId, cid, "lead", `Website request${lead.source ? ` (${lead.source})` : ""}`, body);
  await sql`UPDATE insights_crm_contacts SET updated_at = now() WHERE id = ${cid}`;
}
