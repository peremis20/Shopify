import { AsyncLocalStorage } from "node:async_hooks";
import { ensureSchema, sql } from "../db";
import { readPlatformSettings } from "./settings";

/**
 * Spending limits per site. Every AI request and every paid Google results lookup made while working on a site is
 * counted against that site for the month. Past the limit, that site's agents pause what costs money until next month
 * (the owner sees why); the other sites carry on. Work not tied to one site is not counted.
 */
const site = new AsyncLocalStorage<{ accountId: string }>();

/** Runs `work` on behalf of one site, so what it spends is counted for that site. */
export const forSite = <T>(accountId: string, work: () => Promise<T>): Promise<T> => site.run({ accountId }, work);
export const currentSite = (): string | null => site.getStore()?.accountId ?? null;

export type Spend = "ai" | "search";
/** Defaults the platform owner can change in the platform keys (aiMonthlyLimit, searchMonthlyLimit). */
export const DEFAULT_LIMITS: Record<Spend, number> = { ai: 3000, search: 1500 };

let cached: { at: number; limits: Record<Spend, number> } | null = null;
export async function monthlyLimits(): Promise<Record<Spend, number>> {
  if (cached && Date.now() - cached.at < 60_000) return cached.limits;
  const p = await readPlatformSettings().catch(() => null);
  const pick = (v: unknown, d: number) => (typeof v === "number" && v > 0 ? v : d);
  const limits = { ai: pick(p?.aiMonthlyLimit, DEFAULT_LIMITS.ai), search: pick(p?.searchMonthlyLimit, DEFAULT_LIMITS.search) };
  cached = { at: Date.now(), limits };
  return limits;
}

export class SpendingLimitReached extends Error {
  name = "SpendingLimitReached";
}

/**
 * For a `.catch` that turns a failed lookup into "nothing found": a reached spending limit is passed on instead, so
 * the work pauses visibly rather than saving "nothing found" as if it were a result.
 */
export const nullUnlessLimit = (e: unknown): null => {
  if (e instanceof SpendingLimitReached) throw e;
  return null;
};

const month = () => new Date().toISOString().slice(0, 7);

/** Counts one paid request for the current site, and refuses it once the site's monthly limit is used up. */
export async function spend(kind: Spend): Promise<void> {
  const accountId = currentSite();
  if (!accountId) return;
  await ensureSchema();
  const limit = (await monthlyLimits())[kind];
  const [row] = await sql`
    INSERT INTO insights_usage (account_id, month, ai, search) VALUES (${accountId}, ${month()}, ${kind === "ai" ? 1 : 0}, ${kind === "search" ? 1 : 0})
    ON CONFLICT (account_id, month) DO UPDATE SET ai = insights_usage.ai + EXCLUDED.ai, search = insights_usage.search + EXCLUDED.search
    RETURNING ai, search`;
  const used = Number(kind === "ai" ? row.ai : row.search);
  if (used > limit) {
    // Refused requests aren't spent, so they don't count.
    await sql`UPDATE insights_usage SET ai = ai - ${kind === "ai" ? 1 : 0}, search = search - ${kind === "search" ? 1 : 0}
      WHERE account_id = ${accountId} AND month = ${month()}`.catch(() => undefined);
    throw new SpendingLimitReached(
      `This site used its ${kind === "ai" ? "AI" : "Google results"} limit for the month (${limit}). That part pauses until next month.`
    );
  }
}

export async function usageThisMonth(accountId: string): Promise<{ ai: number; search: number; limits: Record<Spend, number> }> {
  await ensureSchema();
  const [row] = await sql`SELECT ai, search FROM insights_usage WHERE account_id = ${accountId} AND month = ${month()}`;
  return { ai: Number(row?.ai ?? 0), search: Number(row?.search ?? 0), limits: await monthlyLimits() };
}
