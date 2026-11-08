import { ensureSchema, sql } from "../db";
import { readProfile, saveAbout } from "../profile";
import { sitePage } from "../site-crawl";
import { aiProvider, readPlatformSettings } from "./settings";
import { readBusiness } from "./writer";

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
  const about = await readBusiness(ai, texts.join("\n\n"));
  await saveAbout(accountId, about, "auto");
  return `business read from ${texts.length} ${texts.length === 1 ? "page" : "pages"}`;
}
