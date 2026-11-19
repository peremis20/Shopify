import crypto from "crypto";
import { ensureSchema, sql } from "./db";
import { sendOneEmail } from "./gmail";
import { shopifyGql, type StoreAccess } from "./autopilot/shopify";

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
  /** When it last moved to its current stage (for "won this month"). */
  stageChangedAt: string | null;
  /** Open tasks on this contact. */
  openTasks: number;
}

export type ActivityKind = "note" | "call" | "meeting" | "email" | "reply" | "task" | "stage" | "lead" | "stock";

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
    await sql`ALTER TABLE insights_crm_contacts ADD COLUMN IF NOT EXISTS stage_changed_at timestamptz`;
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
    // Tasks the CRM adds by itself carry a key, so the same reminder is never added twice.
    await sql`ALTER TABLE insights_crm_activities ADD COLUMN IF NOT EXISTS auto_key text`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS insights_crm_activities_auto ON insights_crm_activities (account_id, auto_key) WHERE auto_key IS NOT NULL`;
    await sql`CREATE TABLE IF NOT EXISTS insights_crm_stock (
      id bigserial PRIMARY KEY,
      account_id bigint NOT NULL,
      contact_id bigint NOT NULL REFERENCES insights_crm_contacts (id) ON DELETE CASCADE,
      product text NOT NULL,
      on_shelf integer NOT NULL DEFAULT 0,
      price numeric NOT NULL DEFAULT 0,
      every_days integer NOT NULL DEFAULT 30,
      placed_at date NOT NULL DEFAULT current_date,
      next_count date,
      closed boolean NOT NULL DEFAULT false
    )`;
    await sql`CREATE TABLE IF NOT EXISTS insights_crm_counts (
      id bigserial PRIMARY KEY,
      account_id bigint NOT NULL,
      stock_id bigint NOT NULL REFERENCES insights_crm_stock (id) ON DELETE CASCADE,
      counted_at date NOT NULL DEFAULT current_date,
      expected integer NOT NULL,
      counted integer NOT NULL,
      sold integer NOT NULL,
      restocked integer NOT NULL DEFAULT 0,
      owed numeric NOT NULL DEFAULT 0,
      paid boolean NOT NULL DEFAULT false,
      paid_at date
    )`;
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

/** Where contacts in each old stage go: a stage renamed in its place keeps its contacts, a removed one sends them to the first. */
export function stageMoves(before: string[], after: string[]): { from: string; to: string; renamed: boolean }[] {
  return before
    .map((from, i) => {
      if (after.includes(from)) return { from, to: from, renamed: false };
      const renamed = before.length === after.length && !before.includes(after[i]);
      return { from, to: renamed ? after[i] : after[0], renamed };
    })
    .filter((m) => m.from !== m.to);
}

export async function saveStages(accountId: string, input: unknown): Promise<string[]> {
  const stages = cleanStages(input);
  if (!stages) throw new Error("Use between 2 and 12 stage names.");
  const before = await readStages(accountId);
  await sql`INSERT INTO insights_settings (key, value) VALUES (${stagesKey(accountId)}, ${JSON.stringify(stages)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  // A stage that was renamed (same number of stages, same place) keeps its contacts under the new name. A contact in a
  // stage that was taken out moves to the first stage, so nobody falls off the board. Each move goes on the timeline.
  for (const { from, to, renamed } of stageMoves(before, stages)) {
    const note = renamed ? `Stage ${from} renamed to ${to}` : `Moved to ${to} (stage ${from} was taken out)`;
    // One statement moves them all and writes each one's timeline entry.
    await sql`WITH moved AS (UPDATE insights_crm_contacts SET stage = ${to}, stage_changed_at = now(), updated_at = now()
        WHERE account_id = ${accountId} AND stage = ${from} RETURNING id)
      INSERT INTO insights_crm_activities (account_id, contact_id, kind, subject) SELECT ${accountId}, id, 'stage', ${note} FROM moved`;
  }
  return stages;
}

/** A contact's fields from the owner's form or an import row, cleaned. */
export function cleanContact(input: unknown, stages: string[]): Omit<Contact, "id" | "createdAt" | "updatedAt" | "lastContactAt" | "stageChangedAt" | "openTasks"> | null {
  if (!input || typeof input !== "object") return null;
  const b = input as Record<string, unknown>;
  const email = cut(b.email, 254).toLowerCase();
  const name = cut(b.name, 120);
  const company = cut(b.company, 120);
  if (email && !EMAIL.test(email)) return null;
  if (!name && !email && !company && !cut(b.phone, 40)) return null;
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
  stageChangedAt: r.stage_changed_at ? new Date(String(r.stage_changed_at)).toISOString() : null,
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
    sql`SELECT a.* FROM insights_crm_activities a JOIN insights_crm_contacts c ON c.id = a.contact_id
      WHERE a.account_id = ${accountId} AND a.kind = 'task' AND NOT a.done AND NOT c.archived ORDER BY a.due NULLS LAST, a.at LIMIT 300`,
    sql`SELECT * FROM insights_crm_templates WHERE account_id = ${accountId} ORDER BY name`,
    readStages(accountId),
  ]);
  return {
    stages,
    /** True when there are more contacts than the page shows. */
    capped: contacts.length >= 2000,
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
  if (!c) throw new Error("Add at least a name, a company, a phone or a valid email.");
  if (id !== undefined && id !== null && id !== "") {
    const cid = await owned(accountId, id);
    if (!cid) throw new Error("That contact isn't here anymore.");
    const [before] = await sql`SELECT stage FROM insights_crm_contacts WHERE id = ${cid}`;
    await sql`UPDATE insights_crm_contacts SET name = ${c.name}, email = ${c.email}, phone = ${c.phone}, company = ${c.company}, title = ${c.title},
      kind = ${c.kind}, stage = ${c.stage}, value = ${c.value}, tags = ${JSON.stringify(c.tags)}::jsonb, source = ${c.source}, address = ${c.address},
      website = ${c.website}, follow_up = ${c.followUp}, updated_at = now(),
      stage_changed_at = CASE WHEN stage_changed_at IS NULL OR ${before?.stage ?? ""} <> ${c.stage} THEN now() ELSE stage_changed_at END WHERE id = ${cid}`;
    if (before?.stage !== c.stage) await log(accountId, cid, "stage", `Moved to ${c.stage}`);
    return cid;
  }
  if (c.email) {
    const [dup] = await sql`SELECT id FROM insights_crm_contacts WHERE account_id = ${accountId} AND email = ${c.email} AND NOT archived`;
    if (dup) throw new Error("A contact with that email is already here. Search for it to open it.");
  }
  const [row] = await sql`INSERT INTO insights_crm_contacts (account_id, name, email, phone, company, title, kind, stage, value, tags, source, address, website, follow_up, stage_changed_at)
    VALUES (${accountId}, ${c.name}, ${c.email}, ${c.phone}, ${c.company}, ${c.title}, ${c.kind}, ${c.stage}, ${c.value}, ${JSON.stringify(c.tags)}::jsonb,
      ${c.source || "Added by hand"}, ${c.address}, ${c.website}, ${c.followUp}, now()) RETURNING id`;
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
  const [before] = await sql`UPDATE insights_crm_contacts SET stage = ${to}, stage_changed_at = now(), updated_at = now() WHERE id = ${cid} AND stage <> ${to} RETURNING id`;
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
  const kind = (["note", "call", "meeting", "reply", "task"] as const).find((k) => k === b.kind);
  if (!kind) throw new Error("Pick note, call, meeting, reply or task.");
  const subject = cut(b.subject, 300);
  const body = cut(b.body, 20_000);
  if (!subject && !body && kind !== "reply") throw new Error(kind === "task" ? "Say what needs doing." : "Write something first.");
  const due = kind === "task" ? day(b.due) : null;
  await log(accountId, cid, kind, subject, body, due);
  if (kind === "call" || kind === "meeting" || kind === "reply") {
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
  // A reminder the CRM added is marked done instead, so the hourly check doesn't add it again.
  const [auto] = await sql`UPDATE insights_crm_activities SET done = true WHERE id = ${id} AND account_id = ${accountId} AND kind = 'task' AND auto_key IS NOT NULL RETURNING id`;
  if (auto) return;
  const [row] = await sql`DELETE FROM insights_crm_activities WHERE id = ${id} AND account_id = ${accountId} AND kind IN ('note', 'call', 'meeting', 'reply', 'task') RETURNING id`;
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
  if (!out.ok) {
    // Gmail didn't answer clearly: it may have gone out, so the attempt is written down rather than lost.
    if (out.status === 502 && /may have been sent/i.test(out.error)) {
      await log(accountId, cid, "email", `${cut(b.subject, 280)} (may have been sent, check Gmail Sent)`, `To: ${cut(b.to, 254)}\n\n${cut(b.body, 20_000)}`).catch(() => undefined);
    }
    return out;
  }
  await log(accountId, cid, "email", cut(b.subject, 300), `To: ${out.to}\n\n${cut(b.body, 20_000)}`);
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
    // The same person: the same email, or without one, the same phone number or the same company name.
    const digits = c.phone.replace(/\D/g, "");
    const [dup] = c.email
      ? await sql`SELECT id FROM insights_crm_contacts WHERE account_id = ${accountId} AND email = ${c.email} AND NOT archived`
      : digits.length >= 7 || c.company
        ? await sql`SELECT id FROM insights_crm_contacts WHERE account_id = ${accountId} AND NOT archived AND email = ''
            AND ((${digits} <> '' AND regexp_replace(phone, '[^0-9]', '', 'g') = ${digits}) OR (${c.company} <> '' AND lower(company) = lower(${c.company})))
            ORDER BY id LIMIT 1`
        : [];
    const notes = cut((r as Record<string, unknown>)?.notes, 2000);
    const keepNote = async (cid: string) => {
      if (!notes) return;
      const [same] = await sql`SELECT id FROM insights_crm_activities WHERE contact_id = ${cid} AND kind = 'note' AND body = ${notes}`;
      if (!same) await log(accountId, cid, "note", "From the import", notes);
    };
    if (dup) {
      await sql`UPDATE insights_crm_contacts SET
        name = CASE WHEN name = '' THEN ${c.name} ELSE name END, phone = CASE WHEN phone = '' THEN ${c.phone} ELSE phone END,
        company = CASE WHEN company = '' THEN ${c.company} ELSE company END, title = CASE WHEN title = '' THEN ${c.title} ELSE title END,
        kind = CASE WHEN kind = '' THEN ${c.kind} ELSE kind END, address = CASE WHEN address = '' THEN ${c.address} ELSE address END,
        website = CASE WHEN website = '' THEN ${c.website} ELSE website END, updated_at = now()
        WHERE id = ${dup.id}`;
      await keepNote(String(dup.id));
      updated++;
      continue;
    }
    const [made] = await sql`INSERT INTO insights_crm_contacts (account_id, name, email, phone, company, title, kind, stage, value, tags, source, address, website, follow_up, stage_changed_at)
      VALUES (${accountId}, ${c.name}, ${c.email}, ${c.phone}, ${c.company}, ${c.title}, ${c.kind}, ${c.stage}, ${c.value}, ${JSON.stringify(c.tags)}::jsonb,
        ${c.source}, ${c.address}, ${c.website}, ${c.followUp}, now()) RETURNING id`;
    await keepNote(String(made!.id));
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

/**
 * Removes what a website request copied into the CRM. A contact the owner also wrote to or about stays, as the owner's
 * own record of their dealings with that person; only the request entries go. Used when (Shopify asked to erase a customer, or a whole store): the
 * "Website request" entries, and a contact that holds nothing else. With no email, every request copy on the account.
 */
export async function forgetLeadCopies(accountId: string, email: string | null): Promise<number> {
  await schema();
  const contacts = email
    ? await sql`SELECT id FROM insights_crm_contacts WHERE account_id = ${accountId} AND email = ${email.toLowerCase()}`
    : await sql`SELECT DISTINCT contact_id AS id FROM insights_crm_activities WHERE account_id = ${accountId} AND kind = 'lead'`;
  for (const c of contacts) {
    await sql`DELETE FROM insights_crm_activities WHERE contact_id = ${c.id} AND account_id = ${accountId} AND kind = 'lead'`;
    await sql`DELETE FROM insights_crm_contacts c WHERE c.id = ${c.id} AND c.account_id = ${accountId}
      AND NOT EXISTS (SELECT 1 FROM insights_crm_activities a WHERE a.contact_id = c.id)
      AND c.source NOT IN ('Added by hand', 'Imported')`;
  }
  return contacts.length;
}

// ---------- follow ups the CRM adds by itself, and the daily to do email ----------

export interface CrmSettings {
  /** Days after an email with no reply logged before a follow up task is added; 0 turns it off. */
  followUpDays: number;
  /** A morning email with what is due today and late. */
  dailyEmail: boolean;
  /** When follow ups started for this site: only emails sent after it get one, so nothing old floods in. */
  since: string;
}
const settingsKey = (accountId: string) => `crm_settings:${accountId}`;

export async function readCrmSettings(accountId: string): Promise<CrmSettings> {
  await schema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${settingsKey(accountId)}`;
  const v = (() => { try { return row?.value ? JSON.parse(row.value) : {}; } catch { return {}; } })() as Partial<CrmSettings>;
  const days = Number(v.followUpDays);
  const out: CrmSettings = {
    followUpDays: Number.isInteger(days) && days >= 0 && days <= 60 ? days : 5,
    dailyEmail: v.dailyEmail !== false,
    since: typeof v.since === "string" && !Number.isNaN(Date.parse(v.since)) ? v.since : new Date().toISOString(),
  };
  if (!v.since) {
    await sql`INSERT INTO insights_settings (key, value) VALUES (${settingsKey(accountId)}, ${JSON.stringify(out)})
      ON CONFLICT (key) DO NOTHING`;
    const [again] = await sql`SELECT value FROM insights_settings WHERE key = ${settingsKey(accountId)}`;
    try {
      const saved = JSON.parse(again?.value ?? "{}") as Partial<CrmSettings>;
      if (typeof saved.since === "string") out.since = saved.since;
    } catch {
      /* keep the fresh date */
    }
  }
  return out;
}

export async function saveCrmSettings(accountId: string, input: unknown): Promise<CrmSettings> {
  const b = (input ?? {}) as Record<string, unknown>;
  const days = Number(b.followUpDays);
  if (!Number.isInteger(days) || days < 0 || days > 60) throw new Error("Pick between 0 and 60 days.");
  const value: CrmSettings = { followUpDays: days, dailyEmail: b.dailyEmail !== false, since: (await readCrmSettings(accountId)).since };
  await sql`INSERT INTO insights_settings (key, value) VALUES (${settingsKey(accountId)}, ${JSON.stringify(value)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return value;
}

/**
 * Adds the follow up tasks that are due: an email with no reply, call or meeting logged after it for `days` days, and
 * a consignment count whose date has come. Each is added once (its key), on open deals only. Returns how many.
 */
export async function addDueFollowUps(accountId: string): Promise<number> {
  await schema();
  const { followUpDays, since } = await readCrmSettings(accountId);
  let added = 0;
  if (followUpDays > 0) {
    const rows = await sql`INSERT INTO insights_crm_activities (account_id, contact_id, kind, subject, body, due, auto_key)
      SELECT e.account_id, e.contact_id, 'task', left('Follow up: no reply yet to ' || coalesce(nullif(e.subject, ''), 'your email'), 300),
        'Added by the CRM: nothing was logged from them since this email. Mark it done once you follow up, or log their reply.',
        current_date, 'noreply:' || e.id
      FROM insights_crm_activities e
      JOIN insights_crm_contacts c ON c.id = e.contact_id AND NOT c.archived AND lower(c.stage) NOT IN ('won', 'lost')
      WHERE e.account_id = ${accountId} AND e.kind = 'email' AND e.at < now() - make_interval(days => ${followUpDays}::int)
        AND e.at > now() - interval '60 days' AND e.at > ${since}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM insights_crm_activities x WHERE x.contact_id = e.contact_id AND x.at > e.at
          AND x.kind IN ('reply', 'call', 'meeting', 'email', 'lead', 'stock'))
      ORDER BY e.at LIMIT 25
      ON CONFLICT (account_id, auto_key) WHERE auto_key IS NOT NULL DO NOTHING
      RETURNING id`;
    added += rows.length;
  }
  const counts = await sql`INSERT INTO insights_crm_activities (account_id, contact_id, kind, subject, body, due, auto_key)
    SELECT s.account_id, s.contact_id, 'task', left('Count the shelf: ' || s.product, 300),
      'Added by the CRM: the consignment count is due. Open the contact and click Count.', s.next_count, 'count:' || s.id || ':' || s.next_count
    FROM insights_crm_stock s JOIN insights_crm_contacts c ON c.id = s.contact_id AND NOT c.archived
    WHERE s.account_id = ${accountId} AND NOT s.closed AND s.next_count <= current_date + 1
    ON CONFLICT (account_id, auto_key) WHERE auto_key IS NOT NULL DO NOTHING
    RETURNING id`;
  return added + counts.length;
}

/** Accounts whose CRM upkeep is due (about hourly), the longest waiting first. */
export async function accountsDueForCrm(limit = 10): Promise<string[]> {
  await schema();
  const rows = await sql`SELECT c.account_id FROM insights_crm_contacts c
    LEFT JOIN insights_settings s ON s.key = 'crm_upkeep:' || c.account_id
    WHERE s.updated_at IS NULL OR s.updated_at < now() - interval '50 minutes'
    GROUP BY c.account_id, s.updated_at ORDER BY s.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}

export async function markCrmUpkeep(accountId: string): Promise<void> {
  await sql`INSERT INTO insights_settings (key, value) VALUES (${`crm_upkeep:${accountId}`}, ${new Date().toISOString()})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** The daily to do email's text: tasks due today or late, oldest first; null when nothing is due. */
export function digestText(items: { subject: string; due: string | null; who: string }[], todayIso: string): string | null {
  const due = items.filter((i) => i.due && i.due <= todayIso);
  if (!due.length) return null;
  const nice = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const lines = due.map((i) => `${i.due! < todayIso ? `Late, since ${nice(i.due!)}` : "Today"}: ${i.subject} for ${i.who}`);
  return [`You have ${due.length} thing${due.length > 1 ? "s" : ""} to do in your CRM today.`, "", ...lines, "", "Open DashPatrol and click CRM, then To do."].join("\n");
}

/** What the daily email lists, and whether it already went out today. */
export async function digestFor(accountId: string): Promise<{ text: string | null; sentToday: boolean }> {
  await schema();
  const [sent] = await sql`SELECT value FROM insights_settings WHERE key = ${`crm_digest:${accountId}`}`;
  const todayIso = new Date().toISOString().slice(0, 10);
  if (sent?.value === todayIso) return { text: null, sentToday: true };
  const rows = await sql`SELECT a.subject, a.due, coalesce(nullif(c.name, ''), nullif(c.company, ''), c.email) AS who
    FROM insights_crm_activities a JOIN insights_crm_contacts c ON c.id = a.contact_id AND NOT c.archived
    WHERE a.account_id = ${accountId} AND a.kind = 'task' AND NOT a.done AND a.due <= current_date ORDER BY a.due LIMIT 50`;
  return { text: digestText(rows.map((r) => ({ subject: r.subject ?? "", due: r.due ? String(r.due).slice(0, 10) : null, who: r.who ?? "" })), todayIso), sentToday: false };
}

export async function markDigest(accountId: string): Promise<void> {
  const todayIso = new Date().toISOString().slice(0, 10);
  await sql`INSERT INTO insights_settings (key, value) VALUES (${`crm_digest:${accountId}`}, ${todayIso})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

// ---------- consignment: stock left with a contact, counted and settled ----------

export interface StockLine {
  id: string;
  contactId: string;
  product: string;
  onShelf: number;
  price: number;
  everyDays: number;
  placedAt: string;
  nextCount: string | null;
  closed: boolean;
  counts: { id: string; countedAt: string; expected: number; counted: number; sold: number; restocked: number; owed: number; paid: boolean; paidAt: string | null }[];
}

const whole = (v: unknown, max = 100_000) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
};
const cents = (n: number) => Math.round(n * 100) / 100;

/** Leaves stock with a contact: how many, what each sold one is owed, and how often to count. */
export async function addStock(accountId: string, contactId: unknown, input: unknown): Promise<void> {
  await schema();
  const cid = await owned(accountId, contactId);
  if (!cid) throw new Error("That contact isn't here anymore.");
  const b = (input ?? {}) as Record<string, unknown>;
  const product = cut(b.product, 120);
  const qty = whole(b.qty);
  const price = Number(String(b.price ?? "").replace(/[$,\s]/g, ""));
  const every = whole(b.everyDays ?? 30, 365);
  if (!product) throw new Error("Name the product.");
  if (!qty) throw new Error("Put how many were left, at least 1.");
  if (!Number.isFinite(price) || price < 0 || price > 100_000) throw new Error("Put what each sold one is owed, like 17.49.");
  if (!every) throw new Error("Put how many days between counts, like 30.");
  await sql`INSERT INTO insights_crm_stock (account_id, contact_id, product, on_shelf, price, every_days, next_count)
    VALUES (${accountId}, ${cid}, ${product}, ${qty}, ${cents(price)}, ${every}, current_date + ${every}::int)`;
  await log(accountId, cid, "stock", `Left ${qty} of ${product}`, `${money(price)} owed for each one sold. Count every ${every} days.`);
  await sql`UPDATE insights_crm_contacts SET updated_at = now() WHERE id = ${cid}`;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** What one count works out to: sold since the last count, and what is owed for them. */
export function countMath(onShelf: number, counted: number, price: number): { sold: number; owed: number } | null {
  if (counted > onShelf) return null;
  const sold = onShelf - counted;
  return { sold, owed: cents(sold * price) };
}

/** Records a shelf count: what sold since last time and what is owed, then any restock, and sets the next count. */
export async function countStock(accountId: string, stockId: unknown, input: unknown): Promise<void> {
  await schema();
  if (typeof stockId !== "string" || !ID.test(stockId)) throw new Error("That stock isn't here anymore.");
  const [s] = await sql`SELECT * FROM insights_crm_stock WHERE id = ${stockId} AND account_id = ${accountId} AND NOT closed`;
  if (!s) throw new Error("That stock isn't here anymore.");
  const b = (input ?? {}) as Record<string, unknown>;
  const counted = whole(b.counted);
  const restock = b.restock === undefined || b.restock === "" ? 0 : whole(b.restock);
  if (counted === null) throw new Error("Put how many are still on the shelf.");
  if (restock === null) throw new Error("Put how many you added as a whole number, or leave it empty.");
  const onShelf = Number(s.on_shelf);
  const m = countMath(onShelf, counted, Number(s.price));
  if (!m) throw new Error(`There should be at most ${onShelf} on the shelf. Check the count.`);
  // The shelf only changes if nobody counted it in the meantime, so a double click never doubles what is owed.
  const [claimed] = await sql`UPDATE insights_crm_stock SET on_shelf = ${counted + restock}, next_count = current_date + every_days
    WHERE id = ${stockId} AND account_id = ${accountId} AND on_shelf = ${onShelf} AND NOT closed RETURNING id`;
  if (!claimed) throw new Error("This shelf was just counted. Open the contact again to see it.");
  await sql`INSERT INTO insights_crm_counts (account_id, stock_id, expected, counted, sold, restocked, owed)
    VALUES (${accountId}, ${stockId}, ${onShelf}, ${counted}, ${m.sold}, ${restock}, ${m.owed})`;
  await log(
    accountId,
    String(s.contact_id),
    "stock",
    `Count: ${m.sold} of ${s.product} sold, ${money(m.owed)} owed`,
    `${counted} still on the shelf${restock ? `, ${restock} added, ${counted + restock} there now` : ""}.`,
  );
  // The count task for this date is done.
  await sql`UPDATE insights_crm_activities SET done = true WHERE account_id = ${accountId} AND kind = 'task' AND auto_key LIKE ${`count:${stockId}:%`} AND NOT done`;
  await sql`UPDATE insights_crm_contacts SET last_contact_at = now(), updated_at = now() WHERE id = ${s.contact_id}`;
}

/** Marks what a count owed as paid (or not). */
export async function setCountPaid(accountId: string, countId: unknown, paid: boolean): Promise<void> {
  await schema();
  if (typeof countId !== "string" || !ID.test(countId)) throw new Error("That count isn't here anymore.");
  const [row] = await sql`UPDATE insights_crm_counts SET paid = ${paid}, paid_at = CASE WHEN ${paid} THEN current_date ELSE NULL END
    WHERE id = ${countId} AND account_id = ${accountId} RETURNING stock_id, owed`;
  if (!row) throw new Error("That count isn't here anymore.");
  const [s] = await sql`SELECT contact_id, product FROM insights_crm_stock WHERE id = ${row.stock_id} AND account_id = ${accountId}`;
  if (s && paid) await log(accountId, String(s.contact_id), "stock", `Paid ${money(Number(row.owed))} for ${s.product}`);
}

/** Ends a consignment (bottles picked up or the clinic stopped). Its history stays. */
export async function closeStock(accountId: string, stockId: unknown): Promise<void> {
  await schema();
  if (typeof stockId !== "string" || !ID.test(stockId)) throw new Error("That stock isn't here anymore.");
  const [s] = await sql`UPDATE insights_crm_stock SET closed = true WHERE id = ${stockId} AND account_id = ${accountId} RETURNING contact_id, product, on_shelf`;
  if (!s) throw new Error("That stock isn't here anymore.");
  await sql`UPDATE insights_crm_activities SET done = true WHERE account_id = ${accountId} AND kind = 'task' AND auto_key LIKE ${`count:${stockId}:%`} AND NOT done`;
  await log(accountId, String(s.contact_id), "stock", `Ended consignment of ${s.product}`, `${s.on_shelf} were on the shelf when it ended.`);
}

/** One contact's stock lines with their counts, newest first. */
export async function stockFor(accountId: string, contactId: string): Promise<StockLine[]> {
  await schema();
  const lines = await sql`SELECT * FROM insights_crm_stock WHERE account_id = ${accountId} AND contact_id = ${contactId} ORDER BY closed, placed_at DESC`;
  if (!lines.length) return [];
  const counts = await sql`SELECT * FROM insights_crm_counts WHERE account_id = ${accountId}
    AND stock_id = ANY(string_to_array(${lines.map((l) => String(l.id)).join(",")}, ',')::bigint[]) ORDER BY counted_at DESC, id DESC`;
  const yes = (v: unknown) => v === "t" || v === "true" || v === true;
  return lines.map((l) => ({
    id: String(l.id),
    contactId: String(l.contact_id),
    product: l.product ?? "",
    onShelf: Number(l.on_shelf),
    price: Number(l.price),
    everyDays: Number(l.every_days),
    placedAt: String(l.placed_at).slice(0, 10),
    nextCount: l.next_count ? String(l.next_count).slice(0, 10) : null,
    closed: yes(l.closed),
    counts: counts
      .filter((c) => String(c.stock_id) === String(l.id))
      .map((c) => ({
        id: String(c.id),
        countedAt: String(c.counted_at).slice(0, 10),
        expected: Number(c.expected),
        counted: Number(c.counted),
        sold: Number(c.sold),
        restocked: Number(c.restocked),
        owed: Number(c.owed),
        paid: yes(c.paid),
        paidAt: c.paid_at ? String(c.paid_at).slice(0, 10) : null,
      })),
  }));
}

/** Across the account: stock out with contacts, what is owed and not paid yet, and counts coming up. */
export async function stockSummary(accountId: string): Promise<{ onShelf: number; owed: number; dueSoon: number; places: number }> {
  await schema();
  const [s] = await sql`SELECT coalesce(sum(s.on_shelf), 0)::int AS on_shelf, count(DISTINCT s.contact_id)::int AS places,
      count(*) FILTER (WHERE s.next_count <= current_date + 7)::int AS due_soon
    FROM insights_crm_stock s JOIN insights_crm_contacts c ON c.id = s.contact_id AND NOT c.archived
    WHERE s.account_id = ${accountId} AND NOT s.closed`;
  const [o] = await sql`SELECT coalesce(sum(owed), 0) AS owed FROM insights_crm_counts WHERE account_id = ${accountId} AND NOT paid`;
  return { onShelf: Number(s?.on_shelf ?? 0), owed: Number(o?.owed ?? 0), dueSoon: Number(s?.due_soon ?? 0), places: Number(s?.places ?? 0) };
}

// ---------- what a contact bought in the store ----------

export interface ContactOrders {
  count: number;
  total: number;
  currency: string;
  last: string | null;
  recent: { name: string; at: string; total: number; status: string }[];
  /** True when there were more orders than were read. */
  more: boolean;
}

/** Sums a contact's paid store orders, at their current totals (what is left after refunds of items). */
const PAID = new Set(["PAID", "PARTIALLY_PAID", "PARTIALLY_REFUNDED"]);

export function sumOrders(nodes: { name: string; email?: string | null; createdAt: string; cancelledAt: string | null; displayFinancialStatus: string | null; net: string; currency: string }[], more: boolean): ContactOrders {
  // Only orders that were paid count; pending, voided, expired and cancelled ones are not money in.
  const kept = nodes.filter((n) => !n.cancelledAt && PAID.has(String(n.displayFinancialStatus ?? "").toUpperCase()));
  return {
    count: kept.length,
    total: cents(kept.reduce((s, n) => s + (Number(n.net) || 0), 0)),
    currency: kept[0]?.currency ?? "USD",
    last: kept[0]?.createdAt ?? null,
    recent: kept.slice(0, 5).map((n) => ({ name: n.name, at: n.createdAt, total: Number(n.net) || 0, status: (n.displayFinancialStatus ?? "").replace(/_/g, " ").toLowerCase() })),
    more,
  };
}

/** The contact's orders in a connected Shopify store, matched by email; null without a store or an email. */
export async function contactOrders(store: StoreAccess | null, email: string): Promise<ContactOrders | "access" | null> {
  if (!store || !EMAIL.test(email)) return null;
  try {
    const d = await shopifyGql<{ orders: { pageInfo: { hasNextPage: boolean }; nodes: { name: string; email: string | null; createdAt: string; cancelledAt: string | null; displayFinancialStatus: string | null; currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } } }[] } }>(
      store,
      `query($q: String!) { orders(first: 50, query: $q, sortKey: CREATED_AT, reverse: true) { pageInfo { hasNextPage }
        nodes { name email createdAt cancelledAt displayFinancialStatus currentTotalPriceSet { shopMoney { amount currencyCode } } } } }`,
      { q: `email:"${email}"` },
    );
    // Shopify's search isn't an exact match: only orders with exactly this email count.
    return sumOrders(
      d.orders.nodes.filter((n) => n.email?.toLowerCase() === email.toLowerCase()).map((n) => ({ ...n, net: n.currentTotalPriceSet.shopMoney.amount, currency: n.currentTotalPriceSet.shopMoney.currencyCode })),
      d.orders.pageInfo.hasNextPage,
    );
  } catch (e) {
    if (/access denied|read_orders|scope|not approved|protected customer data/i.test(String((e as Error)?.message ?? e))) return "access";
    throw e;
  }
}
