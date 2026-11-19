/**
 * How to address someone by name in an email: "Dr. Hamer" for "Dr. Brown M. Hamer III, DC", "Ana" for "Ana Lopez",
 * "" when there is no name. Shared by the server and the browser.
 */
export function addressName(name: string): string {
  const clean = name.replace(/,.*$/, "").replace(/\([^)]*\)/g, " ").replace(/\b(Jr|Sr|II|III|IV|PhD|MD|DC)\.?$/i, "").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  const title = /^(dr|mr|mrs|ms|miss)\.?$/i.exec(parts[0]);
  if (title && parts.length > 1) {
    const rest = parts.slice(1).filter((p) => !/^(Jr|Sr|II|III|IV)\.?$/i.test(p));
    // A surname can have more than one word: "Van Biezen", "De La Cruz".
    let i = rest.length - 1;
    while (i > 1 && /^(van|von|der|den|de|del|della|di|da|du|la|le|st\.?|mac|bin|al)$/i.test(rest[i - 1])) i--;
    const last = rest.slice(Math.max(i, 0)).join(" ");
    const t = title[1].toLowerCase() === "miss" ? "Miss" : `${title[1][0].toUpperCase()}${title[1].slice(1).toLowerCase()}.`;
    return `${t} ${last}`;
  }
  // A title alone ("Dr.") is no name to greet.
  return title ? "" : parts[0];
}

/** A business name without its legal ending: "Expressions Chiropractic of Dallas PC" reads "Expressions Chiropractic of Dallas". */
export function plainCompany(company: string): string {
  return company.replace(/[,\s]+(PC|P\.C\.|PLLC|LLC|L\.L\.C\.|Inc\.?|Incorporated|Ltd\.?|Corp\.?|Co\.)$/i, "").trim();
}
