import { isAdminEmail } from "./accounts";
import { ensureSchema, sql } from "./db";

/**
 * What each customer's business is: the brand name the writer signs titles
 * with, what they sell (so the writer and guards fit the business), the
 * store's own domain (to match the right Search Console and Analytics
 * properties) and other sites sharing their Analytics tag.
 */

export const BUSINESS_TYPES = [
  { id: "supplements", label: "Supplements and vitamins", sells: "dietary supplements and vitamins" },
  { id: "skincare", label: "Skincare and beauty", sells: "skincare and beauty products" },
  { id: "fitness", label: "Fitness and sports nutrition", sells: "fitness and sports nutrition products" },
  { id: "health_store", label: "Health food or wellness store", sells: "natural health and wellness products" },
  { id: "practice", label: "Clinic or health practice", sells: "health care services" },
  { id: "other", label: "Other health and wellness", sells: "health and wellness products" },
] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number]["id"];

export interface Profile {
  brandName: string | null;
  businessType: BusinessType | null;
  siteDomain: string | null;
  gaExcludeHosts: string[];
  onboardingDismissed: boolean;
  /** What the site is built with (detected): shopify, wordpress, wix, squarespace, webflow, custom, ... */
  platform: string | null;
}

const hostsOf = (v: string | null | undefined) =>
  (v ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);

/** A bare domain from anything a person or an API gives: "https://www.Shop.com/x" becomes "shop.com". */
export function bareDomain(input: string | null | undefined): string | null {
  const v = (input ?? "").trim().toLowerCase().replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : null;
}

export async function readProfile(accountId: string, email?: string): Promise<Profile> {
  await ensureSchema();
  const [row] = await sql`SELECT * FROM insights_account_profile WHERE account_id = ${accountId}`;
  const yes = (v: string | null | undefined) => v === "t" || v === "true";
  // The platform owner's account keeps the setting it had before profiles existed.
  const envHosts = email && isAdminEmail(email) ? hostsOf(process.env.GA_EXCLUDE_HOSTNAMES) : [];
  return {
    brandName: row?.brand_name ?? null,
    businessType: (row?.business_type as BusinessType) ?? null,
    siteDomain: row?.site_domain ?? null,
    gaExcludeHosts: row?.ga_exclude_hosts != null ? hostsOf(row.ga_exclude_hosts) : envHosts,
    onboardingDismissed: yes(row?.onboarding_dismissed),
    platform: row?.platform ?? null,
  };
}

export async function saveProfile(accountId: string, patch: Partial<Profile>): Promise<void> {
  const cur = await readProfile(accountId);
  const type = patch.businessType !== undefined ? patch.businessType : cur.businessType;
  const next = {
    brand: (patch.brandName !== undefined ? patch.brandName : cur.brandName)?.trim().slice(0, 60) || null,
    type: BUSINESS_TYPES.some((b) => b.id === type) ? type : null,
    domain: patch.siteDomain !== undefined ? bareDomain(patch.siteDomain) : cur.siteDomain,
    hosts: patch.gaExcludeHosts !== undefined ? hostsOf(patch.gaExcludeHosts.join(",")).join(",") : null,
    dismissed: patch.onboardingDismissed ?? cur.onboardingDismissed,
    platform: patch.platform !== undefined ? patch.platform : cur.platform,
  };
  await sql`
    INSERT INTO insights_account_profile (account_id, brand_name, business_type, site_domain, ga_exclude_hosts, onboarding_dismissed, platform)
    VALUES (${accountId}, ${next.brand}, ${next.type}, ${next.domain}, ${next.hosts}, ${next.dismissed}, ${next.platform})
    ON CONFLICT (account_id) DO UPDATE SET
      brand_name = EXCLUDED.brand_name,
      business_type = EXCLUDED.business_type,
      site_domain = EXCLUDED.site_domain,
      ga_exclude_hosts = COALESCE(EXCLUDED.ga_exclude_hosts, insights_account_profile.ga_exclude_hosts),
      onboarding_dismissed = EXCLUDED.onboarding_dismissed,
      platform = EXCLUDED.platform,
      updated_at = now()`;
}

/** What the writer is told about the business. */
export function siteBrief(p: Profile): { brand: string | null; sells: string } {
  return { brand: p.brandName, sells: BUSINESS_TYPES.find((b) => b.id === p.businessType)?.sells ?? "health and wellness products" };
}
