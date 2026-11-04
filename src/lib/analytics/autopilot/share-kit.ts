import { ensureSchema, sql } from "../db";
import { plainText } from "./guards";
import type { AiProvider } from "./settings";
import { report } from "./status";
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
  let items: ShareItem[] = [];
  try {
    const parsed = row ? JSON.parse(String(row.value)) : [];
    items = Array.isArray(parsed) ? (parsed as ShareItem[]) : [];
  } catch {
    return [];
  }
  if (!items.length) return items;
  // An article that was undone no longer exists on the site: its posts would link nowhere.
  const ids = items.map((i) => Number(i.changeId)).filter(Number.isFinite);
  const gone = await sql`SELECT id FROM insights_autopilot_changes WHERE account_id = ${accountId} AND id = ANY(${ids}) AND reverted_at IS NOT NULL`.catch(() => []);
  const goneIds = new Set(gone.map((g) => String(g.id)));
  return items.filter((i) => !goneIds.has(i.changeId));
}

async function saveShareKits(accountId: string, items: ShareItem[]): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${keyOf(accountId)}, ${JSON.stringify(items.slice(0, KEEP))})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

const triesKey = (accountId: string) => `sharekit_tries:${accountId}`;

async function readTries(accountId: string): Promise<Record<string, number>> {
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${triesKey(accountId)}`;
  try {
    const v = row ? JSON.parse(String(row.value)) : {};
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

async function saveTries(accountId: string, tries: Record<string, number>): Promise<void> {
  // Only the newest few matter (articles from the last 30 days).
  const kept = Object.fromEntries(Object.entries(tries).slice(-30));
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${triesKey(accountId)}, ${JSON.stringify(kept)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** The owner posted it (or chose not to): it moves out of the to do list but stays for reference. */
export async function markSharePosted(accountId: string, changeId: string, posted: boolean): Promise<ShareItem[]> {
  const items = await readShareKits(accountId);
  if (!items.some((i) => i.changeId === changeId)) return items;
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
  const tries = await readTries(accountId);
  // Each article gets at most two tries, so one that can't be written never holds up the next.
  const done = new Set([...items.map((i) => i.changeId), ...Object.entries(tries).filter(([, n]) => n >= 2).map(([id]) => id)]);
  // Only live articles: a draft the public can't see isn't worth posting about.
  const rows = await sql`
    SELECT id, page_url, after_value, created_at FROM insights_autopilot_changes
    WHERE account_id = ${accountId} AND field = 'new_article' AND status IN ('applied', 'kept') AND note LIKE 'Published%'
      AND reverted_at IS NULL AND page_url LIKE 'http%' AND created_at > now() - interval '30 days'
    ORDER BY created_at DESC LIMIT 10`;
  let next: (typeof rows)[number] | null = null;
  let article = { title: "", text: "" };
  for (const r of rows) {
    if (done.has(String(r.id))) continue;
    const a = articleFromLog(String(r.after_value ?? ""));
    if (!a.title || a.text.split(/\s+/).length < 200) continue;
    next = r;
    article = a;
    break;
  }
  if (!next) return null;
  const { title, text } = article;
  const summary = text.split(/(?<=[.?!])\s+/).slice(0, 3).join(" ");
  let kit: ShareKit;
  try {
    kit = await writeShareKit(ai, { title, url: String(next.page_url), summary, text, brand, site: site || "this site" });
  } catch (e) {
    await saveTries(accountId, { ...tries, [String(next.id)]: (tries[String(next.id)] ?? 0) + 1 });
    void report("share-kit", false, (e as Error).message);
    throw e;
  }
  void report("share-kit", true);
  await saveShareKits(accountId, [
    { changeId: String(next.id), url: String(next.page_url), title, at: new Date().toISOString(), kit, postedAt: null },
    ...items,
  ]);
  return `Wrote social posts and a short video script for "${title}". They're ready to post under Share this week.`;
}
