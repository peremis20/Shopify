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

/** Turns spreadsheet rows into contacts by their column names (Name, First name, Last name, Email, Company and so on). */
export function rowsToContacts(rows: string[][]): Record<string, string>[] {
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ""));
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const m = {
    name: col("name", "fullname", "contact", "contactname"),
    first: col("firstname", "first"),
    last: col("lastname", "last", "surname"),
    email: col("email", "emailaddress", "mail"),
    phone: col("phone", "phonenumber", "mobile", "tel", "telephone"),
    company: col("company", "business", "businessname", "organization", "organisation", "account"),
    title: col("title", "jobtitle", "role", "position"),
    kind: col("type", "kind", "businesstype", "category"),
    stage: col("stage", "status", "dealstage"),
    value: col("value", "dealvalue", "amount"),
    tags: col("tags", "tag", "labels"),
    website: col("website", "url", "site"),
    address: col("address", "streetaddress"),
  };
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  return rows.slice(1).map((r) => ({
    name: get(r, m.name) || [get(r, m.first), get(r, m.last)].filter(Boolean).join(" "),
    email: get(r, m.email),
    phone: get(r, m.phone),
    company: get(r, m.company),
    title: get(r, m.title),
    kind: get(r, m.kind),
    stage: get(r, m.stage),
    value: get(r, m.value),
    tags: get(r, m.tags),
    website: get(r, m.website),
    address: get(r, m.address),
  }));
}
