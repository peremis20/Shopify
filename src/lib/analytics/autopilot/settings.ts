import { ensureSchema, hasDatabase, sql } from "../db";
import { tokenSecret } from "../oauth-client";
import { readProfile } from "../profile";
import { readConnection } from "./connections";
import { snippetInstalled } from "./snippet";
import { readWp } from "./wordpress";
import { decrypt, encrypt } from "../secrets";

/**
 * Two layers of settings:
 * - Platform (the SaaS owner, set once): Claude API key and the Shopify app's
 *   Client ID and secret. Environment variables win when set.
 * - Account (each customer): on/off, pages per week, content sections, and
 *   their connected Shopify store.
 */

export interface PlatformSettings {
  anthropicKey?: string;
  /** Google Gemini, usable instead of Claude. */
  geminiKey?: string;
  /** Groq (open models with a free tier), usable instead of Claude. */
  groqKey?: string;
  /** Mistral (free Experiment plan), usable as the writer or the checking AI. */
  mistralKey?: string;
  /** Cerebras (free plan), usable as the writer or the checking AI. */
  cerebrasKey?: string;
  /** A GitHub token with the models permission, for GitHub Models. */
  githubModelsKey?: string;
  /** serper.dev, for Google page one results and competitor analysis. */
  serperKey?: string;
  /** Optional Google API key for PageSpeed Insights (higher limits than without one). */
  pagespeedKey?: string;
  /** Open PageRank (free), for the authority of the sites on Google page one. */
  oprKey?: string;
  /** Keywords Everywhere, for the searches rivals rank for and the sites that link to them. */
  keKey?: string;
  /** Keywords Everywhere credits the platform may spend a month (default in keywords-everywhere.ts). */
  keMonthlyCredits?: number;
  shopifyClientId?: string;
  shopifyClientSecret?: string;
  /** resend.com, for owner emails (weekly report, urgent alerts). */
  resendKey?: string;
  /** The sender, on a domain verified in Resend, e.g. "DashPatrol <alerts@dashpatrol.com>". */
  alertsFrom?: string;
  /** Per site and month: AI requests and paid Google results lookups (defaults in usage.ts). */
  aiMonthlyLimit?: number;
  searchMonthlyLimit?: number;
}

export interface AccountAutopilot {
  enabled: boolean;
  maxPagesPerWeek: number;
  /** New articles the autopilot may post a week (1 to 7). */
  articlesPerWeek: number;
  allowContent: boolean;
  /** The weekly report and urgent alerts by email (on unless the owner turns them off). */
  emailAlerts: boolean;
  shopDomain?: string;
}

/** What the page may see: no secrets. */
export interface AutopilotSettingsView extends AccountAutopilot {
  /** Where owner emails go: the address this account signs in with. */
  alertEmail?: string | null;
  shopConnected: boolean;
  /** A non-Shopify website read from its sitemap: changes come as a fix list. */
  website: {
    domain: string;
    platform: string | null;
    /** Connected for automatic changes (otherwise changes come as a fix list). */
    connection: { kind: "wordpress" | "webflow" | "wix" | "snippet"; detail: string | null } | null;
  } | null;
  platformReady: boolean;
  /** Only filled in for admins. */
  platform?: { hasAnthropic: boolean; hasGemini: boolean; hasGroq: boolean; hasMistral: boolean; hasCerebras: boolean; hasGithub: boolean; hasSerper: boolean; hasPagespeed: boolean; hasOpr: boolean; hasKe: boolean; keCredits: number | null; keLeft: number | null; keSpent: number | null; hasShopifyApp: boolean; hasEmail: boolean; aiLimit: number | null; searchLimit: number | null };
}

const PLATFORM_KEY = "platform_autopilot";

export async function readPlatformSettings(): Promise<PlatformSettings> {
  let stored: PlatformSettings = {};
  if (hasDatabase()) {
    await ensureSchema();
    const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${PLATFORM_KEY}`;
    const json = row?.value ? decrypt(row.value, await tokenSecret()) : null;
    if (json) stored = JSON.parse(json);
    // The sender address isn't a secret, so it may also be set as a plain row (used when it's set up for the owner).
    if (!stored.alertsFrom) {
      const [from] = await sql`SELECT value FROM insights_settings WHERE key = 'alerts_from'`.catch(() => []);
      if (from?.value && /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(String(from.value).trim())) stored.alertsFrom = String(from.value).trim();
    }
  }
  return {
    anthropicKey: process.env.ANTHROPIC_API_KEY || stored.anthropicKey,
    geminiKey: process.env.GEMINI_API_KEY || stored.geminiKey,
    groqKey: process.env.GROQ_API_KEY || stored.groqKey,
    mistralKey: process.env.MISTRAL_API_KEY || stored.mistralKey,
    cerebrasKey: process.env.CEREBRAS_API_KEY || stored.cerebrasKey,
    githubModelsKey: process.env.GITHUB_MODELS_TOKEN || stored.githubModelsKey,
    serperKey: process.env.SERPER_API_KEY || stored.serperKey,
    pagespeedKey: process.env.PAGESPEED_API_KEY || stored.pagespeedKey,
    oprKey: process.env.OPR_API_KEY || stored.oprKey,
    keKey: process.env.KE_API_KEY || stored.keKey,
    keMonthlyCredits: Number(process.env.KE_MONTHLY_CREDITS) || stored.keMonthlyCredits,
    resendKey: process.env.RESEND_API_KEY || stored.resendKey,
    alertsFrom: process.env.ALERTS_FROM || stored.alertsFrom,
    aiMonthlyLimit: Number(process.env.AI_MONTHLY_LIMIT) || stored.aiMonthlyLimit,
    searchMonthlyLimit: Number(process.env.SEARCH_MONTHLY_LIMIT) || stored.searchMonthlyLimit,
    shopifyClientId: process.env.SHOPIFY_API_KEY || stored.shopifyClientId,
    shopifyClientSecret: process.env.SHOPIFY_API_SECRET || stored.shopifyClientSecret,
  };
}

export async function savePlatformSettings(patch: PlatformSettings): Promise<void> {
  const next = { ...(await readPlatformSettings()) };
  const store = next as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch) as [keyof PlatformSettings, unknown][]) {
    if (k === "aiMonthlyLimit" || k === "searchMonthlyLimit" || k === "keMonthlyCredits") {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) store[k] = Math.round(n); // blank or zero keeps what's saved
    } else if (typeof v === "string" && v.trim()) store[k] = v.trim(); // blank means keep what's saved
  }
  const value = encrypt(JSON.stringify(next), await tokenSecret());
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${PLATFORM_KEY}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/**
 * The AI that writes changes, with every other configured AI as a backup, in
 * this order: Claude, Groq.
 */
export function aiProvider(p: PlatformSettings): AiProvider | null {
  const all: AiProvider[] = [];
  if (p.anthropicKey) all.push({ kind: "claude", key: p.anthropicKey });
  if (p.groqKey) all.push({ kind: "groq", key: p.groqKey });
  // Only the services that proved reliable: the free Mistral, Cerebras, GitHub Models and Gemini plans ran out too
  // often to count on. With Groq alone, the owner approves the work in place of a second AI; Claude adds it back.
  return all.length ? { ...all[0], backups: all.slice(1) } : null;
}

export interface AiProvider {
  kind: "claude" | "groq" | "mistral" | "cerebras" | "github" | "gemini";
  key: string;
  /** Tried in order when this one fails. */
  backups?: AiProvider[];
  /** "review": the second AI checking another's work; its outages show as the checker's, not the writer's. */
  role?: "review";
  /** The customer's business, so the writer fits it (brand for titles, what they sell). */
  site?: { brand: string | null; sells: string; readers?: boolean; about?: string };
}

export const platformReady = (p: PlatformSettings) => Boolean(aiProvider(p) && p.shopifyClientId && p.shopifyClientSecret);

export async function readAccountAutopilot(accountId: string): Promise<AccountAutopilot & { shopTokenEnc: string | null }> {
  await ensureSchema();
  const [row] = await sql`SELECT * FROM insights_account_autopilot WHERE account_id = ${accountId}`;
  // Postgres sends booleans as text: "t" or "f".
  const yes = (v: string | null | undefined) => v === "t" || v === "true";
  return {
    enabled: yes(row?.enabled),
    maxPagesPerWeek: Number(row?.max_pages_per_week ?? 4),
    articlesPerWeek: Number(row?.articles_per_week ?? 3),
    allowContent: row ? yes(row.allow_content) : true,
    emailAlerts: row?.email_alerts == null ? true : yes(row.email_alerts),
    shopDomain: row?.shop_domain ?? undefined,
    shopTokenEnc: row?.shop_token_enc ?? null,
  };
}

export async function saveAccountAutopilot(
  accountId: string,
  patch: Partial<AccountAutopilot> & { shopTokenEnc?: string | null }
): Promise<void> {
  const cur = await readAccountAutopilot(accountId);
  const next = {
    enabled: patch.enabled ?? cur.enabled,
    max: Math.min(14, Math.max(1, Math.round(patch.maxPagesPerWeek ?? cur.maxPagesPerWeek))),
    articles: Math.min(7, Math.max(1, Math.round(patch.articlesPerWeek ?? cur.articlesPerWeek))),
    allowContent: patch.allowContent ?? cur.allowContent,
    emailAlerts: patch.emailAlerts ?? cur.emailAlerts,
    shop: patch.shopDomain !== undefined ? patch.shopDomain || null : cur.shopDomain ?? null,
    token: patch.shopTokenEnc !== undefined ? patch.shopTokenEnc : cur.shopTokenEnc,
  };
  await sql`
    INSERT INTO insights_account_autopilot (account_id, enabled, max_pages_per_week, articles_per_week, allow_content, email_alerts, shop_domain, shop_token_enc)
    VALUES (${accountId}, ${next.enabled}, ${next.max}, ${next.articles}, ${next.allowContent}, ${next.emailAlerts}, ${next.shop}, ${next.token})
    ON CONFLICT (account_id) DO UPDATE SET enabled = EXCLUDED.enabled, max_pages_per_week = EXCLUDED.max_pages_per_week,
      articles_per_week = EXCLUDED.articles_per_week, email_alerts = EXCLUDED.email_alerts,
      allow_content = EXCLUDED.allow_content, shop_domain = EXCLUDED.shop_domain, shop_token_enc = EXCLUDED.shop_token_enc`;
}

export async function autopilotView(accountId: string, admin: boolean): Promise<AutopilotSettingsView> {
  const [acct, platform, profile, wp, wf, wx] = await Promise.all([
    readAccountAutopilot(accountId),
    readPlatformSettings(),
    readProfile(accountId),
    readWp(accountId).catch(() => null),
    readConnection<{ name?: string }>("webflow", accountId).catch(() => null),
    readConnection<{ siteId?: string }>("wix", accountId).catch(() => null),
  ]);
  const snippet = await snippetInstalled(accountId).catch(() => false);
  const connection = wp
    ? { kind: "wordpress" as const, detail: wp.seoPlugin && wp.seoPlugin !== "none" ? wp.seoPlugin : null }
    : wf
      ? { kind: "webflow" as const, detail: wf.name ?? null }
      : wx
        ? { kind: "wix" as const, detail: "blog posts" }
        : snippet
          ? { kind: "snippet" as const, detail: "with the snippet" }
          : null;
  const shopConnected = Boolean(acct.shopDomain && acct.shopTokenEnc);
  return {
    website:
      !shopConnected && profile.siteDomain
        ? { domain: profile.siteDomain, platform: profile.platform, connection }
        : null,
    enabled: acct.enabled,
    maxPagesPerWeek: acct.maxPagesPerWeek,
    articlesPerWeek: acct.articlesPerWeek,
    allowContent: acct.allowContent,
    emailAlerts: acct.emailAlerts,
    alertEmail: ((await sql`SELECT email FROM insights_accounts WHERE id = ${accountId}`.catch(() => []))[0]?.email as string | undefined) ?? null,
    shopDomain: acct.shopDomain,
    shopConnected: Boolean(acct.shopDomain && acct.shopTokenEnc),
    platformReady: platformReady(platform),
    platform: admin
      ? { hasAnthropic: Boolean(platform.anthropicKey), hasGemini: Boolean(platform.geminiKey), hasGroq: Boolean(platform.groqKey), hasMistral: Boolean(platform.mistralKey), hasCerebras: Boolean(platform.cerebrasKey), hasGithub: Boolean(platform.githubModelsKey), hasSerper: Boolean(platform.serperKey), hasPagespeed: Boolean(platform.pagespeedKey), hasOpr: Boolean(platform.oprKey), hasKe: Boolean(platform.keKey), keCredits: platform.keMonthlyCredits ?? null, ...(await keCreditInfo(Boolean(platform.keKey))), hasEmail: Boolean(platform.resendKey), aiLimit: platform.aiMonthlyLimit ?? null, searchLimit: platform.searchMonthlyLimit ?? null, hasShopifyApp: Boolean(platform.shopifyClientId && platform.shopifyClientSecret) }
      : undefined,
  };
}

export async function encryptShopTokens(tokens: object): Promise<string> {
  return encrypt(JSON.stringify(tokens), await tokenSecret());
}

export async function decryptShopTokens<T>(enc: string): Promise<T | null> {
  const json = decrypt(enc, await tokenSecret());
  return json ? (JSON.parse(json) as T) : null;
}

/** Credits left on the Keywords Everywhere plan and spent this month, for the admin's settings. */
async function keCreditInfo(hasKey: boolean): Promise<{ keLeft: number | null; keSpent: number | null }> {
  if (!hasKey) return { keLeft: null, keSpent: null };
  const ke = await import("./keywords-everywhere");
  const [keLeft, keSpent] = await Promise.all([ke.creditsLeft().catch(() => null), ke.creditsSpent().catch(() => null)]);
  return { keLeft, keSpent };
}
