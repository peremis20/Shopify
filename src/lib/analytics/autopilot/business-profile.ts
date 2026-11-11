import { ensureSchema, sql } from "../db";
import { BUSINESS_TYPES, cleanTypes, guessBusinessTypes, readProfile, saveAbout, saveSuggestedTypes, type BusinessType } from "../profile";
import { sitePage, sitePages } from "../site-crawl";
import { aiProvider, readPlatformSettings } from "./settings";
import { ownerApproves, readBusiness, readSiteTypes } from "./writer";

/** The usual addresses of an about page, on most platforms. */
const ABOUT_PATHS = ["/", "/about", "/about-us", "/pages/about", "/pages/about-us", "/our-story", "/pages/our-story"];

/** Sites whose business description is missing or was read by the agents over 30 days ago (never one the owner wrote). */
export async function accountsDueForBusiness(limit: number): Promise<string[]> {
  await ensureSchema();
  const rows = await sql`
    SELECT a.account_id FROM insights_account_autopilot a
    JOIN insights_account_profile p ON p.account_id = a.account_id
    LEFT JOIN insights_settings t ON t.key = 'business_tried:' || a.account_id
    WHERE a.enabled AND coalesce(p.site_domain, '') <> '' AND coalesce(p.about_source, '') <> 'owner'
      AND (p.about_at IS NULL OR p.about_at < now() - interval '30 days')
      AND (t.updated_at IS NULL OR t.updated_at < now() - interval '1 day')
    ORDER BY p.about_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}

/** Reads the business from its own home and about pages (checked by a second AI) and saves it for every agent. */
export async function learnBusiness(accountId: string): Promise<string> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${`business_tried:${accountId}`}, ${new Date().toISOString()})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  const profile = await readProfile(accountId);
  if (!profile.siteDomain || profile.aboutSource === "owner") return "nothing to do";
  const ai = aiProvider(await readPlatformSettings());
  if (!ai) throw new Error("No AI key is set up.");
  const texts: string[] = [];
  for (const path of ABOUT_PATHS) {
    const p = await sitePage(accountId, `https://${profile.siteDomain}${path}`).catch(() => null);
    if (p?.text && !texts.some((t) => t === p.text)) texts.push(`${p.title}\n${p.text.slice(0, 5000)}`);
    if (texts.length >= 3) break;
  }
  if (!texts.length) return "the site's pages couldn't be read";
  const about = await ownerApproves(ai, () => readBusiness(ai, texts.join("\n\n")));
  await saveAbout(accountId, about, "auto");
  return `business read from ${texts.length} ${texts.length === 1 ? "page" : "pages"}`;
}

/** The text of the site's own home and about pages, as read when it connected (at most three pages). */
async function ownPagesText(accountId: string, domain: string): Promise<string> {
  const pages = await sitePages(accountId).catch(() => []);
  const wanted = new Set(ABOUT_PATHS.map((p) => `https://${domain}${p}`.replace(/\/$/, "")));
  const norm = (u: string) => u.replace(/^https?:\/\/www\./, "https://").replace(/\/$/, "");
  const own = pages.filter((p) => wanted.has(norm(p.url)));
  // Few sites have every usual address; the rest of the pages read fill in.
  const picked = [...own, ...pages.filter((p) => !own.includes(p))].slice(0, 3);
  return picked.map((p) => `${p.title}\n${p.metaDescription ?? ""}\n${p.text.slice(0, 5000)}`).join("\n\n");
}

/** True once at least one of the site's pages has been read and stored (a cheap check, no page text). */
export async function hasSitePages(accountId: string): Promise<boolean> {
  await ensureSchema();
  const [row] = await sql`SELECT 1 AS ok FROM insights_site_pages WHERE account_id = ${accountId} AND status = 200 LIMIT 1`;
  return Boolean(row);
}

/**
 * The likely kinds of site, read from its own pages, saved so setup offers
 * them first. The word cues on the pages are saved straight away (so the
 * site counts as read and a second page load doesn't read it again); then
 * the AI picks, checked by a second AI, go first. A pick the checking AI
 * rejected is never offered, even if the word cues point to it. Never
 * invents a type: with no clear evidence the list stays empty and the owner
 * sees every type.
 */
export async function detectSiteTypes(accountId: string, timeoutMs = 15_000): Promise<BusinessType[]> {
  const profile = await readProfile(accountId);
  if (!profile.siteDomain) return [];
  const text = await ownPagesText(accountId, profile.siteDomain);
  const words = text.trim() ? guessBusinessTypes(text) : [];
  await saveSuggestedTypes(accountId, words);
  if (!text.trim()) return words;
  const ai = aiProvider(await readPlatformSettings().catch(() => ({}) as never));
  if (!ai) return words;
  const options = BUSINESS_TYPES.map(({ id, label, group }) => ({ id, label, group }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("site type reading took too long")), timeoutMs);
  });
  const fromAi = await Promise.race([ownerApproves(ai, () => readSiteTypes(ai, text, options)), timeout])
    .catch((e) => {
      console.error(`site type reading failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    })
    .finally(() => clearTimeout(timer));
  if (!fromAi) return words;
  const types = cleanTypes([...fromAi.types, ...words.filter((w) => w !== fromAi.rejected)]);
  await saveSuggestedTypes(accountId, types);
  return types;
}
