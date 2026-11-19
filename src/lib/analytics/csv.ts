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
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const m = {
    name: col("name", "fullname", "contact", "contactname", "contactperson", "person", "doctor", "owner", "primarycontact", "decisionmaker"),
    first: col("firstname", "first", "givenname"),
    last: col("lastname", "last", "surname", "familyname"),
    email: col("email", "emailaddress", "mail", "workemail"),
    phone: col("phone", "phonenumber", "mobile", "cell", "tel", "telephone", "officephone", "mainphone", "workphone"),
    company: col("company", "companyname", "business", "businessname", "organization", "organisation", "account", "accountname", "clinic", "clinicname", "practice", "practicename", "store", "storename", "shop", "office"),
    title: col("title", "jobtitle", "role", "position"),
    kind: col("type", "kind", "businesstype", "category", "industry"),
    stage: col("stage", "status", "dealstage"),
    value: col("value", "dealvalue", "amount"),
    tags: col("tags", "tag", "labels"),
    website: col("website", "websiteurl", "web", "url", "site", "domain"),
    address: col("address", "streetaddress", "street", "address1", "addressline1"),
    city: col("city", "town"),
    state: col("state", "province", "region"),
    zip: col("zip", "zipcode", "postalcode", "postcode"),
    notes: col("notes", "note", "comments", "comment", "description"),
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
    // Street, city, state and zip become one address line.
    address: [get(r, m.address), get(r, m.city), [get(r, m.state), get(r, m.zip)].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    notes: get(r, m.notes),
  }));
}
