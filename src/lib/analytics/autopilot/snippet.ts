import crypto from "crypto";
import { ensureSchema, sql } from "../db";

/**
 * The one-line snippet, for websites with no API the app can use (custom
 * code, AI site builders, any site with a header code box). The owner adds
 *
 *   <script async src="<APP_URL>/s.js?k=<site key>"></script>
 *
 * once. On each page view it asks the app what to change on that page and
 * applies it: SEO title, meta description, structured data and internal link
 * sentences. Nothing is stored on the site: what the snippet serves is the
 * autopilot's live changes for that page (applied or kept), so undoing a
 * change in the app removes it from the site at once. Google renders
 * JavaScript, so it sees these changes; a title set in the page's own code is
 * still the most reliable, which is why the fix list stays for page text.
 */

const keyOf = (accountId: string) => `snippet:${accountId}`;
const accountOfKey = (siteKey: string) => `snippetkey:${siteKey}`;
const installedOf = (accountId: string) => `snippet_installed:${accountId}`;

/** The account's site key, created on first use. */
export async function snippetKey(accountId: string): Promise<string> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${keyOf(accountId)}`;
  if (row?.value) return row.value;
  const siteKey = crypto.randomBytes(12).toString("base64url");
  await sql`INSERT INTO insights_settings (key, value) VALUES (${keyOf(accountId)}, ${siteKey}) ON CONFLICT (key) DO NOTHING`;
  await sql`INSERT INTO insights_settings (key, value) VALUES (${accountOfKey(siteKey)}, ${accountId}) ON CONFLICT (key) DO NOTHING`;
  const [again] = await sql`SELECT value FROM insights_settings WHERE key = ${keyOf(accountId)}`;
  return again!.value!;
}

export const snippetTag = (appOrigin: string, siteKey: string) => `<script async src="${appOrigin}/s.js?k=${siteKey}"></script>`;

export async function snippetInstalled(accountId: string): Promise<boolean> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${installedOf(accountId)}`;
  return row?.value === "1";
}

/** Looks for the snippet on the live home page. */
export async function checkSnippet(accountId: string, domain: string): Promise<boolean> {
  const siteKey = await snippetKey(accountId);
  const html = await fetch(`https://${domain}/`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; SiteReader/1.0)" }, signal: AbortSignal.timeout(12_000) })
    .then((r) => (r.ok ? r.text() : ""))
    .catch(() => "");
  const found = html.includes(`s.js?k=${siteKey}`);
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${installedOf(accountId)}, ${found ? "1" : "0"})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  return found;
}

export async function removeSnippet(accountId: string): Promise<void> {
  await sql`DELETE FROM insights_settings WHERE key = ${installedOf(accountId)}`;
}

/** Page paths are compared without a trailing slash ("/" stays "/"). */
export const pathKey = (path: string) => (path.replace(/\/+$/, "") || "/").toLowerCase();

export interface SnippetData {
  title: string | null;
  description: string | null;
  /** JSON-LD documents to add. */
  schema: string[];
  /** Small HTML blocks (a sentence with a link) to add at the end of the page's main content. */
  links: string[];
}

const jsonLd = (block: string) =>
  [...block.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim()).filter(Boolean);

const stripMarkers = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "").trim();

/** What the snippet should change on one page of the site behind a key. */
export async function snippetData(siteKey: string, path: string): Promise<SnippetData | null> {
  await ensureSchema();
  const [owner] = await sql`SELECT value FROM insights_settings WHERE key = ${accountOfKey(siteKey)}`;
  if (!owner?.value) return null;
  const p = pathKey(path);
  const rows = await sql`
    SELECT field, after_value, target_id, resource_id FROM insights_autopilot_changes
    WHERE account_id = ${owner.value} AND resource_type = 'snippet' AND status IN ('applied', 'kept')
      AND ((resource_id = ${p} AND field IN ('meta_title', 'meta_description', 'schema')) OR (field = 'internal_link' AND target_id = ${p}))
    ORDER BY id DESC`;
  const latest = (f: string) => rows.find((r) => r.field === f && r.resource_id === p)?.after_value ?? null;
  const schema = latest("schema");
  return {
    title: latest("meta_title"),
    description: latest("meta_description"),
    schema: schema ? jsonLd(schema) : [],
    links: rows.filter((r) => r.field === "internal_link" && r.target_id === p).map((r) => stripMarkers(r.after_value ?? "")),
  };
}

/** The script itself: tiny, no dependencies, fails silently. */
export const SNIPPET_JS = `(function(){
var s=document.currentScript;if(!s||!window.fetch)return;
var src=new URL(s.src),k=src.searchParams.get("k");if(!k)return;
fetch(src.origin+"/api/snippet/data?k="+encodeURIComponent(k)+"&u="+encodeURIComponent(location.pathname),{credentials:"omit"})
.then(function(r){return r.ok?r.json():null}).then(function(d){if(!d)return;
if(d.title)document.title=d.title;
if(d.description){var m=document.querySelector('meta[name="description"]');if(!m){m=document.createElement("meta");m.setAttribute("name","description");document.head.appendChild(m)}m.setAttribute("content",d.description)}
(d.schema||[]).forEach(function(j){var t=document.createElement("script");t.type="application/ld+json";t.text=j;document.head.appendChild(t)});
if(d.links&&d.links.length){var go=function(){var main=document.querySelector("main article,article,main")||document.body;d.links.forEach(function(h){var div=document.createElement("div");div.setAttribute("data-seo-snippet","");div.innerHTML=h;main.appendChild(div)})};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",go);else go()}
}).catch(function(){})})();`;
