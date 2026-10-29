import { ensureSchema, hasDatabase, sql } from "../db";
import { tokenSecret } from "../oauth-client";
import { readProfile } from "../profile";
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
  /** A GitHub token with the models permission, for GitHub Models. */
  githubModelsKey?: string;
  /** serper.dev, for Google page one results and competitor analysis. */
  serperKey?: string;
  /** Optional Google API key for PageSpeed Insights (higher limits than without one). */
  pagespeedKey?: string;
  shopifyClientId?: string;
  shopifyClientSecret?: string;
}

export interface AccountAutopilot {
  enabled: boolean;
  maxPagesPerWeek: number;
  allowContent: boolean;
  shopDomain?: string;
}

/** What the page may see: no secrets. */
export interface AutopilotSettingsView extends AccountAutopilot {
  shopConnected: boolean;
  /** A non-Shopify website read from its sitemap: changes come as a fix list. */
  website: { domain: string; platform: string | null; wordpress: { connected: boolean; seoPlugin: string | null } } | null;
  platformReady: boolean;
  /** Only filled in for admins. */
  platform?: { hasAnthropic: boolean; hasGemini: boolean; hasGroq: boolean; hasGithub: boolean; hasSerper: boolean; hasPagespeed: boolean; hasShopifyApp: boolean };
}

const PLATFORM_KEY = "platform_autopilot";

export async function readPlatformSettings(): Promise<PlatformSettings> {
  let stored: PlatformSettings = {};
  if (hasDatabase()) {
    await ensureSchema();
    const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${PLATFORM_KEY}`;
    const json = row?.value ? decrypt(row.value, await tokenSecret()) : null;
    if (json) stored = JSON.parse(json);
  }
  return {
    anthropicKey: process.env.ANTHROPIC_API_KEY || stored.anthropicKey,
    geminiKey: process.env.GEMINI_API_KEY || stored.geminiKey,
    groqKey: process.env.GROQ_API_KEY || stored.groqKey,
    githubModelsKey: process.env.GITHUB_MODELS_TOKEN || stored.githubModelsKey,
    serperKey: process.env.SERPER_API_KEY || stored.serperKey,
    pagespeedKey: process.env.PAGESPEED_API_KEY || stored.pagespeedKey,
    shopifyClientId: process.env.SHOPIFY_API_KEY || stored.shopifyClientId,
    shopifyClientSecret: process.env.SHOPIFY_API_SECRET || stored.shopifyClientSecret,
  };
}

export async function savePlatformSettings(patch: PlatformSettings): Promise<void> {
  const next = { ...(await readPlatformSettings()) };
  for (const [k, v] of Object.entries(patch) as [keyof PlatformSettings, string | undefined][]) {
    if (v?.trim()) next[k] = v.trim(); // blank means keep what's saved
  }
  const value = encrypt(JSON.stringify(next), await tokenSecret());
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${PLATFORM_KEY}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/**
 * The AI that writes changes, with every other configured AI as a backup, in
 * this order: Claude, Groq, GitHub Models, Gemini.
 */
export function aiProvider(p: PlatformSettings): AiProvider | null {
  const all: AiProvider[] = [];
  if (p.anthropicKey) all.push({ kind: "claude", key: p.anthropicKey });
  if (p.groqKey) all.push({ kind: "groq", key: p.groqKey });
  if (p.githubModelsKey) all.push({ kind: "github", key: p.githubModelsKey });
  if (p.geminiKey) all.push({ kind: "gemini", key: p.geminiKey });
  return all.length ? { ...all[0], backups: all.slice(1) } : null;
}

export interface AiProvider {
  kind: "claude" | "groq" | "github" | "gemini";
  key: string;
  /** Tried in order when this one fails. */
  backups?: AiProvider[];
  /** The customer's business, so the writer fits it (brand for titles, what they sell). */
  site?: { brand: string | null; sells: string };
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
    allowContent: row ? yes(row.allow_content) : true,
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
    allowContent: patch.allowContent ?? cur.allowContent,
    shop: patch.shopDomain !== undefined ? patch.shopDomain || null : cur.shopDomain ?? null,
    token: patch.shopTokenEnc !== undefined ? patch.shopTokenEnc : cur.shopTokenEnc,
  };
  await sql`
    INSERT INTO insights_account_autopilot (account_id, enabled, max_pages_per_week, allow_content, shop_domain, shop_token_enc)
    VALUES (${accountId}, ${next.enabled}, ${next.max}, ${next.allowContent}, ${next.shop}, ${next.token})
    ON CONFLICT (account_id) DO UPDATE SET enabled = EXCLUDED.enabled, max_pages_per_week = EXCLUDED.max_pages_per_week,
      allow_content = EXCLUDED.allow_content, shop_domain = EXCLUDED.shop_domain, shop_token_enc = EXCLUDED.shop_token_enc`;
}

export async function autopilotView(accountId: string, admin: boolean): Promise<AutopilotSettingsView> {
  const [acct, platform, profile, wp] = await Promise.all([
    readAccountAutopilot(accountId),
    readPlatformSettings(),
    readProfile(accountId),
    readWp(accountId).catch(() => null),
  ]);
  const shopConnected = Boolean(acct.shopDomain && acct.shopTokenEnc);
  return {
    website:
      !shopConnected && profile.siteDomain
        ? { domain: profile.siteDomain, platform: profile.platform, wordpress: { connected: Boolean(wp), seoPlugin: wp?.seoPlugin ?? null } }
        : null,
    enabled: acct.enabled,
    maxPagesPerWeek: acct.maxPagesPerWeek,
    allowContent: acct.allowContent,
    shopDomain: acct.shopDomain,
    shopConnected: Boolean(acct.shopDomain && acct.shopTokenEnc),
    platformReady: platformReady(platform),
    platform: admin
      ? { hasAnthropic: Boolean(platform.anthropicKey), hasGemini: Boolean(platform.geminiKey), hasGroq: Boolean(platform.groqKey), hasGithub: Boolean(platform.githubModelsKey), hasSerper: Boolean(platform.serperKey), hasPagespeed: Boolean(platform.pagespeedKey), hasShopifyApp: Boolean(platform.shopifyClientId && platform.shopifyClientSecret) }
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
