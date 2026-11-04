import { ensureSchema, sql } from "../db";
import { plainText } from "./guards";
import type { AiProvider } from "./settings";
import { writeShareKit, type ShareKit } from "./writer";

/**
 * Share kits: for each new article the autopilot publishes, social posts for each channel and a short video script,
 * checked by a second AI, waiting for the owner to post them. Kept per site (its own data only), the newest first.
 */
export interface ShareItem {
  changeId: string;
  url: string;
  title: string;
  at: string;
  kit: ShareKit;
  /** Set when the owner marks it posted. */
  postedAt?: string | null;
}

const KEEP = 10;
const keyOf = (accountId: string) => `sharekit:${accountId}`;

export async function readShareKits(accountId: string): Promise<ShareItem[]> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${keyOf(accountId)}`;
  try {
    const items = row ? (JSON.parse(String(row.value)) as ShareItem[]) : [];
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

async function saveShareKits(accountId: string, items: ShareItem[]): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${keyOf(accountId)}, ${JSON.stringify(items.slice(0, KEEP))})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** The owner posted it (or chose not to): it moves out of the to do list but stays for reference. */
export async function markSharePosted(accountId: string, changeId: string, posted: boolean): Promise<ShareItem[]> {
  const items = await readShareKits(accountId);
  const next = items.map((i) => (i.changeId === changeId ? { ...i, postedAt: posted ? new Date().toISOString() : null } : i));
  await saveShareKits(accountId, next);
  return next;
}

/** Title and text of an article as the autopilot logged it: `<h1>title</h1>` then the summary block, then the body. */
export function articleFromLog(after: string): { title: string; text: string } {
  const title = (after.match(/<h1>([\s\S]*?)<\/h1>/i)?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
  return { title, text: plainText(after.replace(/<h1>[\s\S]*?<\/h1>/i, "").replace(/<p><strong>SEO title:[\s\S]*?<\/p>/i, "")) };
}

/**
 * Makes the kit for the newest published article from the last 30 days that has none yet; at most one per call, so a
 * run stays short. Returns a line for the run summary, or null when there was nothing to do.
 */
export async function makeNextShareKit(accountId: string, ai: AiProvider, brand: string | null, site: string): Promise<string | null> {
  await ensureSchema();
  const items = await readShareKits(accountId);
  const done = new Set(items.map((i) => i.changeId));
  const rows = await sql`
    SELECT id, page_url, after_value, created_at FROM insights_autopilot_changes
    WHERE account_id = ${accountId} AND field = 'new_article' AND status IN ('applied', 'kept')
      AND reverted_at IS NULL AND page_url LIKE 'http%' AND created_at > now() - interval '30 days'
    ORDER BY created_at DESC LIMIT 5`;
  const next = rows.find((r) => !done.has(String(r.id)));
  if (!next) return null;
  const { title, text } = articleFromLog(String(next.after_value ?? ""));
  if (!title || text.split(/\s+/).length < 200) return null;
  const summary = text.split(/(?<=[.?!])\s+/).slice(0, 3).join(" ");
  const kit = await writeShareKit(ai, { title, url: String(next.page_url), summary, text, brand, site });
  await saveShareKits(accountId, [
    { changeId: String(next.id), url: String(next.page_url), title, at: new Date().toISOString(), kit, postedAt: null },
    ...items,
  ]);
  return `Wrote social posts and a short video script for "${title}". They're ready to post under Share this week.`;
}
