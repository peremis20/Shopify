import { manualJournalist } from "./press-crm";

/**
 * Importing the owner's own journalist spreadsheet (CSV), shared by the Outreach tab and the server (no server
 * imports): reading the file, guessing which column is which from its headers, filling an empty outlet from a work
 * email's domain, checking each row with the same rules as Add journalist, and finding duplicates by email, or by name
 * and outlet when there is no email. Every imported row is the owner's own data.
 */

/** Rows one import may hold. */
export const IMPORT_MAX_ROWS = 20_000;
/** Rows per insert statement on the server. */
export const IMPORT_BATCH = 500;
/** Rows the browser sends per request. */
export const IMPORT_CHUNK = 2_000;

export type ImportField =
  | "ignore"
  | "fullName"
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "jobTitle"
  | "outlet"
  | "location"
  | "field"
  | "profileUrl"
  | "articleUrl"
  | "articleTitle"
  | "tags"
  | "notes";

export const IMPORT_FIELD_LABEL: Record<ImportField, string> = {
  ignore: "Leave out",
  fullName: "Full name",
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  phone: "Phone",
  jobTitle: "Job title",
  outlet: "Outlet",
  location: "Location",
  field: "Industry or field",
  profileUrl: "Profile link",
  articleUrl: "Article link",
  articleTitle: "Article title",
  tags: "Lists",
  notes: "Notes",
};

/**
 * Reads CSV text: quoted cells (with commas, quotes and line breaks inside), CRLF or LF, a leading byte order mark,
 * and a semicolon or tab separated file (as some spreadsheet apps save) when the header line says so.
 */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, "");
  const firstLine = t.slice(0, t.search(/\r?\n|$/));
  const count = (c: string) => firstLine.split(c).length - 1;
  const sep = count("\t") > count(",") && count("\t") >= count(";") ? "\t" : count(";") > count(",") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === "") quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const GUESS: [ImportField, RegExp][] = [
  ["email", /e-?mail/],
  ["firstName", /^(first|given|fore)\s*name$|^first$/],
  ["lastName", /^(last|sur|family)\s*name$|^surname$|^last$/],
  ["fullName", /^(full\s*)?name$|^(journalist|reporter|writer|author|contact)(\s*name)?$/],
  ["phone", /phone|mobile|cell|tel/],
  ["jobTitle", /title|position|role|job/],
  ["outlet", /outlet|publication|company|organi[sz]ation|media|employer|newspaper|magazine|publisher/],
  ["location", /location|city|country|state|region|address|based/],
  ["field", /industry|field|beat|topic|sector|category|niche|vertical/],
  ["articleUrl", /article.*(link|url)|story.*(link|url)|^article$|^url$|^link$/],
  ["articleTitle", /article.*(title|headline)|headline|^story$/],
  ["profileUrl", /profile|linkedin|twitter|x\.com|website|author\s*page|bio\s*link|muck/],
  ["tags", /^(lists?|tags?|groups?|segments?)$/],
  ["notes", /note|comment|remark/],
];

/** A guess for each column from its header; a field is guessed for one column only. The owner can change any guess. */
export function guessColumns(headers: string[]): ImportField[] {
  const used = new Set<ImportField>();
  return headers.map((h) => {
    const n = h.toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
    // A link column named for an article goes to the article; otherwise a column named "title" is a job title only
    // when it isn't about the article.
    for (const [f, re] of GUESS) {
      if (used.has(f) || !re.test(n)) continue;
      if (f === "jobTitle" && /article|story|headline/.test(n)) continue;
      used.add(f);
      return f;
    }
    return "ignore";
  });
}

/** Free email services: an address there says nothing about where someone publishes. */
const FREE_EMAIL =
  /^(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|icloud|me|mac|aol|verizon|comcast|att|sbcglobal|bellsouth|cox|charter|earthlink|protonmail|proton|pm|gmx|mail|yandex|zoho|fastmail|hey|tutanota|qq|163|126|web|t-online|orange|free|btinternet|sky|shaw|rogers|optonline|juno|netzero)\.[a-z.]+$/i;

export const NOT_LISTED = "Not listed";

/** The outlet a work email points to (its domain), or "Not listed" for a free email service. Empty without an email. */
export function outletFromEmail(email: string | null | undefined): string {
  const domain = (email ?? "").trim().toLowerCase().split("@")[1]?.replace(/^www\./, "") ?? "";
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return "";
  return FREE_EMAIL.test(domain) ? NOT_LISTED : domain;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** How duplicates are told apart: the email, lowercased; without one, the name and the outlet. */
export const dedupeKey = (r: { email?: string | null; name: string; outlet: string }) => (r.email ? `e:${r.email.trim().toLowerCase()}` : `n:${norm(r.name)}|${norm(r.outlet)}`);

/** One imported journalist, checked: the owner's own data as they gave it. */
export interface ImportRow {
  name: string;
  jobTitle: string | null;
  outlet: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  field: string | null;
  profileUrl: string | null;
  articleUrl: string | null;
  articleTitle: string | null;
  notes: string | null;
  /** The owner's list names from the file ("a; b"). */
  tags: string[];
}

export interface Reject {
  /** The row number in the file (the header is row 1). */
  line: number;
  reason: string;
  values: string[];
}

const cut = (v: string | undefined, n: number) => (v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const okLink = (u: string) => {
  try {
    return /^https?:$/.test(new URL(u).protocol);
  } catch {
    return false;
  }
};

/** One file row, mapped and checked. A reason when it can't be imported. */
export function mapRow(values: string[], mapping: ImportField[]): { row: ImportRow } | { reason: string } {
  const get = (f: ImportField) => {
    const i = mapping.indexOf(f);
    // A value an export guarded against spreadsheet formulas ("'+1 212...") is read back as written.
    return i >= 0 ? (values[i] ?? "").replace(/^'(?=\s*[=+\-@|\t\r])/, "") : "";
  };
  const name = cut(get("fullName"), 80) || cut(`${get("firstName")} ${get("lastName")}`, 80);
  const email = cut(get("email"), 120).toLowerCase();
  const outlet = cut(get("outlet"), 80) || outletFromEmail(email);
  const profileUrl = cut(get("profileUrl"), 500);
  if (profileUrl && !okLink(profileUrl)) return { reason: "The profile link should start with https://." };
  const checked = manualJournalist({ name, jobTitle: get("jobTitle"), outlet, email, phone: get("phone"), articleUrl: get("articleUrl"), articleTitle: get("articleTitle") });
  if (!checked.ok) return { reason: checked.error };
  const v = checked.value;
  return {
    row: {
      ...v,
      location: cut(get("location"), 80) || null,
      field: cut(get("field"), 80) || null,
      profileUrl: profileUrl || null,
      notes: cut(get("notes"), 500) || null,
      tags: [...new Set(get("tags").split(/[;,|]/).map((t) => cut(t, 60)).filter(Boolean))].slice(0, 10),
    },
  };
}

export interface ImportPlan {
  add: ImportRow[];
  duplicates: number;
  rejects: Reject[];
}

/**
 * The rows to add: each checked, duplicates in the file and against the existing list left out (by email, else by
 * name and outlet), the rejects listed with their reason. `existing` holds the list's dedupe keys.
 */
export function planImport(rows: string[][], mapping: ImportField[], existing: Set<string> = new Set(), firstLine = 2): ImportPlan {
  const seen = new Set(existing);
  const plan: ImportPlan = { add: [], duplicates: 0, rejects: [] };
  rows.forEach((values, i) => {
    const r = mapRow(values, mapping);
    if ("reason" in r) return void plan.rejects.push({ line: firstLine + i, reason: r.reason, values });
    const key = dedupeKey(r.row);
    if (seen.has(key)) return void plan.duplicates++;
    seen.add(key);
    plan.add.push(r.row);
  });
  return plan;
}

/** The rejected rows as a CSV the owner can fix and import again: their row number, the reason, then their columns. */
export function rejectsCsv(headers: string[], rejects: Reject[]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^\s*[=+\-@|]/.test(s) || /^[\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [["Row", "Why it was skipped", ...headers], ...rejects.map((r) => [r.line, r.reason, ...r.values])].map((l) => l.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** The columns the browser sends each checked row in (the server checks them again in this order). */
export const IMPORT_ORDER: ImportField[] = ["fullName", "jobTitle", "outlet", "email", "phone", "location", "field", "profileUrl", "articleUrl", "articleTitle", "notes", "tags"];

export const rowValues = (r: ImportRow): string[] =>
  [r.name, r.jobTitle, r.outlet, r.email, r.phone, r.location, r.field, r.profileUrl, r.articleUrl, r.articleTitle, r.notes, r.tags.join("; ")].map((v) => v ?? "");
