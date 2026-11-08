import { lookup } from "dns/promises";
import { ensureSchema, sql } from "./db";

/**
 * What each customer's business is: the brand name the writer signs titles
 * with, what they sell (so the writer and guards fit the business), the
 * store's own domain (to match the right Search Console and Analytics
 * properties) and other sites sharing their Analytics tag.
 */

/**
 * Every kind of site the app works for, in groups. The ids already saved for
 * existing sites never change. "health" marks the types where health claim
 * rules apply (the Claim guard); "cues" are words on a site's own pages that
 * point to the type, used to suggest the likely types when the site connects.
 */
export const BUSINESS_TYPES = [
  // Software and online services
  { id: "saas", group: "Software and online services", label: "Software or SaaS", sells: "software and online tools", cues: ["saas", "software", "dashboard", "free trial", "start free", "sign up free", "pricing", "per month", "/mo", "api", "integrations", "automate", "automation", "platform", "app for", "subscription plan"] },
  { id: "mobile_app", group: "Software and online services", label: "Mobile app", sells: "a mobile app", cues: ["app store", "google play", "download the app", "ios", "android", "iphone app"] },
  { id: "online_course", group: "Software and online services", label: "Online courses or coaching", sells: "online courses and coaching", cues: ["course", "courses", "lesson", "enroll", "coaching", "masterclass", "students", "curriculum", "certificate"] },
  // Stores
  { id: "ecommerce", group: "Online stores", label: "Online store", sells: "products online", cues: ["add to cart", "shop now", "free shipping", "checkout", "in stock", "sale", "collections", "returns"] },
  { id: "fashion", group: "Online stores", label: "Clothing, shoes or jewelry", sells: "clothing, shoes and accessories", cues: ["dress", "shirt", "shoes", "jewelry", "apparel", "clothing", "sizes", "outfit"] },
  { id: "home_goods", group: "Online stores", label: "Home, garden or furniture", sells: "home and garden products", cues: ["furniture", "decor", "garden", "kitchen", "bedding", "home goods"] },
  // Services
  { id: "local_service", group: "Services", label: "Local service business", sells: "local services", cues: ["call us", "book an appointment", "free estimate", "free quote", "service area", "near you", "licensed and insured", "serving"] },
  { id: "agency", group: "Services", label: "Agency or consulting", sells: "professional services", cues: ["agency", "consulting", "consultant", "our clients", "case studies", "we help businesses", "marketing services", "strategy"] },
  { id: "professional", group: "Services", label: "Law, finance or real estate", sells: "professional services", cues: ["attorney", "lawyer", "law firm", "accounting", "tax", "insurance", "realtor", "real estate", "mortgage", "financial advisor"] },
  { id: "restaurant", group: "Services", label: "Restaurant, cafe or food", sells: "food and dining", cues: ["menu", "reservations", "order online", "dine in", "takeout", "restaurant", "cafe", "catering"] },
  { id: "travel", group: "Services", label: "Travel, hotel or events", sells: "travel and event services", cues: ["book your stay", "hotel", "tours", "vacation", "rooms", "events", "tickets", "venue"] },
  // Publishers and organizations
  { id: "blog", group: "Publishers and organizations", label: "Blog, magazine or news site", sells: "articles and news", readers: true, cues: ["blog", "articles", "read more", "latest posts", "newsletter", "magazine", "news", "editor"] },
  { id: "nonprofit", group: "Publishers and organizations", label: "Nonprofit or church", sells: "a mission and community programs", readers: true, cues: ["donate", "nonprofit", "volunteer", "ministry", "church", "worship", "mission", "charity", "501(c)"] },
  { id: "education", group: "Publishers and organizations", label: "School or education", sells: "education", readers: true, cues: ["admissions", "school", "students", "campus", "tuition", "faculty", "enrollment"] },
  // Health and wellness (the original ids)
  { id: "supplements", group: "Health and wellness", label: "Supplements and vitamins", sells: "dietary supplements and vitamins", health: true, cues: ["supplement", "supplements", "vitamin", "capsules", "magnesium", "probiotic", "servings per container"] },
  { id: "skincare", group: "Health and wellness", label: "Skincare and beauty", sells: "skincare and beauty products", health: true, cues: ["skincare", "serum", "moisturizer", "cleanser", "beauty", "skin care", "cosmetics"] },
  { id: "fitness", group: "Health and wellness", label: "Fitness and sports nutrition", sells: "fitness and sports nutrition products", health: true, cues: ["workout", "fitness", "protein powder", "pre workout", "gym", "training program"] },
  { id: "health_store", group: "Health and wellness", label: "Health food or wellness store", sells: "natural health and wellness products", health: true, cues: ["organic", "wellness", "natural health", "herbal", "holistic"] },
  { id: "practice", group: "Health and wellness", label: "Clinic or health practice", sells: "health care services", health: true, cues: ["clinic", "patients", "doctor", "dentist", "chiropractor", "therapy", "medical", "appointment"] },
  { id: "publisher", group: "Health and wellness", label: "Health magazine or blog", sells: "health and wellness articles", readers: true, health: true, cues: ["health tips", "nutrition", "wellness blog", "healthy living"] },
  { id: "faith_health", group: "Health and wellness", label: "Faith and health magazine or blog", sells: "health, wellness and faith articles", readers: true, health: true, cues: ["faith and health", "biblical health", "sabbath", "scripture"] },
  { id: "other", group: "Health and wellness", label: "Other health and wellness", sells: "health and wellness products", health: true, cues: [] },
  // Anything else
  { id: "other_business", group: "Something else", label: "Something else", sells: "its products and services", cues: [] },
] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number]["id"];

/** What the writer is told a site offers before its type is known: never assume a niche. */
export const DEFAULT_SELLS = "its products and services";

/** Health claim rules (the Claim guard) apply only to health and wellness sites. */
export const isHealthSite = (businessType: string | null | undefined): boolean =>
  BUSINESS_TYPES.some((b) => b.id === businessType && "health" in b && b.health);

const isBusinessType = (v: unknown): v is BusinessType => BUSINESS_TYPES.some((b) => b.id === v);

/** Keeps known ids only, in order, without repeats, at most four. */
export function cleanTypes(v: unknown): BusinessType[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const out: BusinessType[] = [];
  for (const raw of list) {
    const id = String(raw).trim();
    if (isBusinessType(id) && !out.includes(id)) out.push(id);
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * The likely types from words on the site's own pages (no AI, so it always
 * works): each type scores by how many of its cues appear. Only types with
 * real evidence come back, best first, at most four.
 */
export function guessBusinessTypes(pagesText: string): BusinessType[] {
  const text = ` ${pagesText.toLowerCase().replace(/\s+/g, " ")} `;
  const scored = BUSINESS_TYPES.map((b) => {
    let score = 0;
    for (const cue of b.cues) {
      const esc = cue.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      const hits = text.match(new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "g"))?.length ?? 0;
      score += Math.min(hits, 3);
    }
    return { id: b.id as BusinessType, score };
  })
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 4).map((s) => s.id);
}

export interface Profile {
  brandName: string | null;
  businessType: BusinessType | null;
  siteDomain: string | null;
  gaExcludeHosts: string[];
  onboardingDismissed: boolean;
  /** What the site is built with (detected): shopify, wordpress, wix, squarespace, webflow, custom, ... */
  platform: string | null;
  /** The business in its own words, so every agent writes for it and not generically. */
  about: BusinessAbout | null;
  /** "auto": read from the site's own pages by the agents; "owner": written or checked by the owner. */
  aboutSource: "auto" | "owner" | null;
  /** The likely site types read from its own pages, best first, offered first in setup. */
  suggestedTypes: BusinessType[];
  /** True once the site was read for its type (even when nothing clear came of it). */
  suggestedRead: boolean;
}

export interface BusinessAbout {
  /** Who the customers or readers are. */
  audience: string;
  /** What it sells or offers, in a sentence or two. */
  offer: string;
  /** What makes it different from others in its field. */
  difference: string;
  /** How it talks: warm, clinical, plain, faith based... */
  tone: string;
  /** Where it serves (a city, a country, online everywhere). */
  location: string;
}

export const ABOUT_FIELDS: (keyof BusinessAbout)[] = ["audience", "offer", "difference", "tone", "location"];

const cleanAbout = (v: unknown): BusinessAbout | null => {
  const o = (typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v) as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const out = Object.fromEntries(ABOUT_FIELDS.map((k) => [k, typeof o[k] === "string" ? String(o[k]).trim().slice(0, 400) : ""])) as unknown as BusinessAbout;
  return ABOUT_FIELDS.some((k) => out[k]) ? out : null;
};

const hostsOf = (v: string | null | undefined) =>
  (v ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);

/** A bare domain from anything a person or an API gives: "https://www.Shop.com/x" becomes "shop.com". */
export function bareDomain(input: string | null | undefined): string | null {
  const v = (input ?? "").trim().toLowerCase().replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) && publicHost(v) ? v : null;
}

// ---------- only public web addresses are fetched for a customer ----------

/** IPv4 and IPv6 addresses that aren't on the public internet. */
export function privateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
    return v === "::1" || v === "::" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("::ffff:") || v.startsWith("64:ff9b:");
  }
  const [a, b, c] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && (c === 0 || c === 2)) || a >= 224
  );
}

/** A hostname the app may fetch: a real public name, never a raw IP, a local or internal name, or a cloud metadata address. */
export function publicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.includes(":") || host.startsWith("[") || /^[\d.]+$/.test(host) || /^0x/i.test(host)) return false;
  if (!host.includes(".") || /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|arpa|test|invalid)$/.test(host)) return false;
  // Cloud metadata services (metadata.google.internal and instance-data are caught above).
  return !/(^|\.)metadata\.goog$/.test(host);
}

/** Why a web address can't be fetched (null when it can), checked without looking it up. */
function urlProblem(url: URL): string | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http and https web addresses can be used.";
  if (url.port && url.port !== "80" && url.port !== "443") return "Only web addresses on the usual ports can be used.";
  if (url.username || url.password) return "Web addresses with a password in them can't be used.";
  if (!publicHost(url.hostname)) return `${url.hostname} isn't a public website address.`;
  return null;
}

/** True when the address passes the checks that need no lookup (scheme, port, hostname). */
export const publicUrlShape = (href: string): boolean => {
  try {
    return urlProblem(new URL(href)) === null;
  } catch {
    return false;
  }
};

/**
 * Throws a plain message unless the address is an ordinary public website:
 * http or https, the usual ports, a public hostname that resolves only to
 * public addresses. Checked before every fetch of a customer's address.
 */
export async function assertPublicUrl(href: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new Error("That web address isn't complete.");
  }
  const problem = urlProblem(url);
  if (problem) throw new Error(problem);
  const addrs = await lookup(url.hostname, { all: true }).catch(() => null);
  if (!addrs?.length) throw new Error(`${url.hostname} couldn't be found. Check the address.`);
  if (addrs.some((a) => privateIp(a.address))) throw new Error(`${url.hostname} isn't a public website address.`);
  return url;
}

/**
 * fetch for a customer's address: every hop (the first and each redirect, at
 * most 3) must be a public website. Only GET and HEAD follow redirects; when
 * a redirect leaves the site, only Accept and User-Agent go with it, so a
 * private key header never reaches another site.
 */
export async function publicFetch(href: string, init: RequestInit = {}): Promise<Response> {
  let url = await assertPublicUrl(href);
  let headers = new Headers(init.headers);
  const follow = !init.method || init.method === "GET" || init.method === "HEAD";
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location || !follow || hop >= 3) return res;
    const next = await assertPublicUrl(new URL(location, url).toString());
    if (next.origin !== url.origin) {
      const kept = new Headers();
      for (const h of ["accept", "user-agent"]) if (headers.has(h)) kept.set(h, headers.get(h)!);
      headers = kept;
    }
    url = next;
  }
}

export async function readProfile(accountId: string, email?: string): Promise<Profile> {
  await ensureSchema();
  const [row] = await sql`SELECT * FROM insights_account_profile WHERE account_id = ${accountId}`;
  const yes = (v: string | null | undefined) => v === "t" || v === "true";
  // Each site's own setting only: a server wide list of another site's hosts never applies to an account.
  const envHosts: string[] = [];
  return {
    brandName: row?.brand_name ?? null,
    businessType: (row?.business_type as BusinessType) ?? null,
    siteDomain: row?.site_domain ?? null,
    gaExcludeHosts: row?.ga_exclude_hosts != null ? hostsOf(row.ga_exclude_hosts) : envHosts,
    onboardingDismissed: yes(row?.onboarding_dismissed),
    platform: row?.platform ?? null,
    about: cleanAbout(row?.about),
    aboutSource: row?.about_source === "owner" ? "owner" : row?.about_source === "auto" ? "auto" : null,
    suggestedTypes: cleanTypes(row?.suggested_types),
    suggestedRead: row?.suggested_types != null,
  };
}

/** Saves the business description; "owner" when the owner wrote or checked it (the agents then never overwrite it). */
export async function saveAbout(accountId: string, about: unknown, source: "auto" | "owner"): Promise<void> {
  await ensureSchema();
  const clean = cleanAbout(about);
  await sql`
    INSERT INTO insights_account_profile (account_id, about, about_source, about_at) VALUES (${accountId}, ${clean ? JSON.stringify(clean) : null}::jsonb, ${clean ? source : null}, ${clean ? new Date().toISOString() : null})
    ON CONFLICT (account_id) DO UPDATE SET about = EXCLUDED.about, about_source = EXCLUDED.about_source, about_at = EXCLUDED.about_at`;
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
  // A new site: the description the agents read from the old one no longer fits (the owner's own stays),
  // and the types suggested for the old site are read again for the new one.
  if (patch.siteDomain !== undefined && next.domain !== cur.siteDomain) {
    await sql`UPDATE insights_account_profile SET about = NULL, about_source = NULL, about_at = NULL WHERE account_id = ${accountId} AND about_source = 'auto'`;
    await sql`UPDATE insights_account_profile SET suggested_types = NULL WHERE account_id = ${accountId}`;
  }
}

/** Saves the site types read from the site's own pages (an empty list means "read, nothing clear"). */
export async function saveSuggestedTypes(accountId: string, types: BusinessType[]): Promise<void> {
  await ensureSchema();
  const value = cleanTypes(types).join(",");
  await sql`
    INSERT INTO insights_account_profile (account_id, suggested_types) VALUES (${accountId}, ${value})
    ON CONFLICT (account_id) DO UPDATE SET suggested_types = EXCLUDED.suggested_types`;
}

/** What the writer is told about the business. */
export function siteBrief(p: Profile): { brand: string | null; sells: string; readers: boolean; about?: string } {
  const type = BUSINESS_TYPES.find((b) => b.id === p.businessType);
  const a = p.about;
  const about = a
    ? [
        a.offer && `What it offers: ${a.offer}`,
        a.audience && `Who it serves: ${a.audience}`,
        a.difference && `What makes it different: ${a.difference}`,
        a.tone && `How it talks: ${a.tone}`,
        a.location && `Where: ${a.location}`,
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  return {
    brand: p.brandName,
    sells: type?.sells ?? DEFAULT_SELLS,
    readers: Boolean(type && "readers" in type && type.readers),
    ...(about ? { about } : {}),
  };
}

/** Faith topics (sabbath, prayer, church) are on topic for a faith and health publication, a church or a ministry. */
export const allowsFaith = (businessType: string | null | undefined) => businessType === "faith_health" || businessType === "nonprofit";
