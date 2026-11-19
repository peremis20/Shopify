/** Spreadsheet import for the CRM: reads CSV text and matches columns to contact fields by their names. */

/** Reads a CSV file: quoted fields, commas and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

/** The contact fields a column can go into, with the column names each one is recognised by, best name first. */
export const IMPORT_FIELDS: { key: string; label: string; names: string[] }[] = [
  { key: "name", label: "Name", names: ["name", "fullname", "contactname", "contactperson", "contact", "person", "doctor", "primarycontact", "decisionmaker"] },
  { key: "first", label: "First name", names: ["firstname", "first", "givenname"] },
  { key: "last", label: "Last name", names: ["lastname", "last", "surname", "familyname"] },
  { key: "company", label: "Company", names: ["company", "companyname", "business", "businessname", "clinic", "clinicname", "practice", "practicename", "organization", "organisation", "accountname", "account", "store", "storename", "shop"] },
  { key: "email", label: "Email", names: ["email", "emailaddress", "workemail", "mail"] },
  { key: "phone", label: "Phone", names: ["phone", "phonenumber", "officephone", "mainphone", "workphone", "mobile", "cell", "telephone", "tel"] },
  { key: "title", label: "Job title", names: ["title", "jobtitle", "role", "position"] },
  { key: "kind", label: "Type", names: ["businesstype", "type", "kind", "category", "industry"] },
  { key: "stage", label: "Stage", names: ["stage", "dealstage", "status"] },
  { key: "value", label: "Deal value", names: ["value", "dealvalue", "amount"] },
  { key: "tags", label: "Tags", names: ["tags", "tag", "labels"] },
  { key: "website", label: "Website", names: ["website", "websiteurl", "web", "url", "site", "domain"] },
  { key: "address", label: "Street address", names: ["address", "streetaddress", "street", "address1", "addressline1"] },
  { key: "city", label: "City", names: ["city", "town"] },
  { key: "state", label: "State", names: ["state", "province"] },
  { key: "zip", label: "Zip", names: ["zip", "zipcode", "postalcode", "postcode"] },
  { key: "notes", label: "Notes", names: ["notes", "note", "comments", "comment", "description"] },
];

const norm = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Guesses which field each column goes into: "" to skip it, "note" to add it to the contact's notes. Each field takes
 * the column with its best name, so "Contact Person" wins over a plain "Contact" wherever it sits.
 */
export function guessMapping(header: string[]): string[] {
  const head = header.map(norm);
  const out = head.map(() => "");
  for (const f of IMPORT_FIELDS) {
    for (const n of f.names) {
      const i = head.findIndex((h, j) => h === n && !out[j]);
      if (i >= 0) {
        out[i] = f.key;
        break;
      }
    }
  }
  return out;
}

/** Turns rows into contacts by the chosen mapping. Columns marked "note" are added to Notes with their column name. */
export function mapRows(rows: string[][], mapping: string[]): Record<string, string>[] {
  if (rows.length < 2) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const v: Record<string, string> = {};
    const extra: string[] = [];
    mapping.forEach((field, i) => {
      const cell = (r[i] ?? "").trim();
      if (!cell || !field) return;
      if (field === "note") extra.push(`${header[i].trim() || "Column"}: ${cell}`);
      else v[field] = v[field] ? `${v[field]} ${cell}` : cell;
    });
    const street = v.address ?? "";
    // City, state and zip join the street, unless the street already holds them.
    const place = [v.city, [v.state, v.zip].filter(Boolean).join(" ")].filter((x) => x && !street.toLowerCase().includes(x.toLowerCase()));
    return {
      name: v.name || [v.first, v.last].filter(Boolean).join(" "),
      email: v.email ?? "",
      phone: v.phone ?? "",
      company: v.company ?? "",
      title: v.title ?? "",
      kind: v.kind ?? "",
      stage: v.stage ?? "",
      value: v.value ?? "",
      tags: v.tags ?? "",
      website: v.website ?? "",
      address: [street, ...place].filter(Boolean).join(", "),
      notes: [v.notes, ...extra].filter(Boolean).join("\n"),
    };
  });
}

/** Turns spreadsheet rows into contacts by their column names. */
export function rowsToContacts(rows: string[][]): Record<string, string>[] {
  return rows.length < 2 ? [] : mapRows(rows, guessMapping(rows[0]));
}
