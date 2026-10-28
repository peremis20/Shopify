import { ensureSchema, hasDatabase, sql } from "../db";
import { tokenSecret } from "../oauth-client";
import { decrypt, encrypt } from "../secrets";

/**
 * Autopilot settings and credentials, stored encrypted in Neon. Environment
 * variables (SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET,
 * ANTHROPIC_API_KEY) take precedence when set.
 */

export interface AutopilotSettings {
  enabled: boolean;
  /** Pages improved per rolling 7 days. */
  maxPagesPerWeek: number;
  /** Whether new content sections may be added to blog posts and pages. */
  allowContent: boolean;
  shopDomain?: string;
  shopifyClientId?: string;
  shopifyClientSecret?: string;
  anthropicKey?: string;
}

/** What the page may see: no secrets. */
export interface AutopilotSettingsView {
  enabled: boolean;
  maxPagesPerWeek: number;
  allowContent: boolean;
  shopDomain?: string;
  hasShopify: boolean;
  hasAnthropic: boolean;
}

const KEY = "autopilot";
const DEFAULTS: AutopilotSettings = { enabled: false, maxPagesPerWeek: 4, allowContent: true };

export const normalizeShop = (d?: string) =>
  d?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") || undefined;

export async function readAutopilotSettings(): Promise<AutopilotSettings> {
  let stored: Partial<AutopilotSettings> = {};
  if (hasDatabase()) {
    await ensureSchema();
    const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${KEY}`;
    const json = row?.value ? decrypt(row.value, await tokenSecret()) : null;
    if (json) stored = JSON.parse(json);
  }
  const s = { ...DEFAULTS, ...stored };
  return {
    ...s,
    shopDomain: normalizeShop(process.env.SHOPIFY_STORE_DOMAIN) ?? s.shopDomain,
    shopifyClientId: process.env.SHOPIFY_CLIENT_ID ?? s.shopifyClientId,
    shopifyClientSecret: process.env.SHOPIFY_CLIENT_SECRET ?? s.shopifyClientSecret,
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? s.anthropicKey,
  };
}

export async function saveAutopilotSettings(patch: Partial<AutopilotSettings>): Promise<void> {
  const current = await readAutopilotSettings();
  const next: AutopilotSettings = { ...current };
  for (const [k, v] of Object.entries(patch) as [keyof AutopilotSettings, unknown][]) {
    if (v === undefined) continue;
    // Blank secret fields mean "keep what's saved".
    if (typeof v === "string" && !v.trim() && k !== "shopDomain") continue;
    (next as unknown as Record<string, unknown>)[k] = typeof v === "string" ? v.trim() : v;
  }
  next.shopDomain = normalizeShop(next.shopDomain);
  next.maxPagesPerWeek = Math.min(14, Math.max(1, Math.round(next.maxPagesPerWeek || DEFAULTS.maxPagesPerWeek)));
  const value = encrypt(JSON.stringify(next), await tokenSecret());
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${KEY}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

export function viewOf(s: AutopilotSettings): AutopilotSettingsView {
  return {
    enabled: s.enabled,
    maxPagesPerWeek: s.maxPagesPerWeek,
    allowContent: s.allowContent,
    shopDomain: s.shopDomain,
    hasShopify: Boolean(s.shopDomain && s.shopifyClientId && s.shopifyClientSecret),
    hasAnthropic: Boolean(s.anthropicKey),
  };
}
