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
    const last = parts.filter((p) => !/^(Jr|Sr|II|III|IV)\.?$/i.test(p)).at(-1)!;
    const t = title[1].toLowerCase() === "miss" ? "Miss" : `${title[1][0].toUpperCase()}${title[1].slice(1).toLowerCase()}.`;
    return `${t} ${last}`;
  }
  return parts[0];
}
