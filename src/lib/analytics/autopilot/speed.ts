import { inflateSync } from "node:zlib";
import { ensureSchema, sql } from "../db";
import { isSabbath } from "./sabbath";
import { shopifyGql, type StoreAccess } from "./shopify";
import { report } from "./status";
import { byDeadline } from "./store-audit";
import { runWeekly, saveRunMarker, type RunOutcome } from "./weekly-run";

/**
 * Two agents that make a store faster on phones, each with its own job:
 *
 * - The Speed agent (weekly): runs Google's own phone speed test (PageSpeed Insights) on the store's key pages and
 *   turns what it measured into plain fixes: the main image or text that shows late, oversized images, scripts that
 *   hold the page back, and which outside apps cost the most. Only what Google measured is said; the numbers are
 *   Google's own.
 * - The Image agent (weekly, after the Speed agent): for every image Google flagged that lives in the store's own
 *   Shopify files, it works out a lighter copy (a sensible width, and JPEG for a PNG with no transparent pixels, which
 *   is checked pixel by pixel), measures it, and offers it only when it is clearly smaller. On the owner's Shrink click
 *   (their approval) the original is kept as a backup file first, then the file's content is replaced in place, so its
 *   address and every page that shows it stay the same. Undo puts the original back.
 *
 * Each site is worked on with its own data only.
 */

// ---------- Google's phone speed test ----------

export interface SpeedPage {
  url: string;
  score: number | null;
  lcpMs: number | null;
  /** What shows last as the main content, as Google names it. */
  lcpElement: string | null;
  lcpLazy: boolean;
  images: { url: string; wastedBytes: number; totalBytes: number }[];
  blocking: { url: string; wastedMs: number }[];
  thirdParty: { entity: string; transferSize: number; blockingTime: number }[];
  unusedJs: { url: string; wastedBytes: number }[];
  totalBytes: number | null;
}

type Items = Record<string, unknown>[];
interface Audit {
  score?: number | null;
  numericValue?: number;
  details?: { items?: Items };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** One page's phone test from PageSpeed Insights, reduced to what the agents use. */
export function readLighthouse(url: string, d: { lighthouseResult?: { categories?: { performance?: { score?: number } }; audits?: Record<string, Audit> } }): SpeedPage {
  const a = d.lighthouseResult?.audits ?? {};
  const items = (k: string): Items => a[k]?.details?.items ?? [];
  const images = new Map<string, { url: string; wastedBytes: number; totalBytes: number }>();
  for (const k of ["uses-optimized-images", "modern-image-formats", "uses-responsive-images"])
    for (const it of items(k)) {
      const u = str(it.url);
      if (!u) continue;
      const prev = images.get(u);
      // The same image can be flagged by several checks; its largest saving counts once.
      if (!prev || num(it.wastedBytes) > prev.wastedBytes) images.set(u, { url: u, wastedBytes: num(it.wastedBytes), totalBytes: num(it.totalBytes) });
    }
  // The element Google names as the main content: a nested table of one node.
  const lcpItems = items("largest-contentful-paint-element");
  const nested = (lcpItems[0]?.items as Items | undefined)?.[0] ?? lcpItems[0];
  const node = (nested?.node ?? {}) as Record<string, unknown>;
  const score = d.lighthouseResult?.categories?.performance?.score;
  return {
    url,
    score: typeof score === "number" ? Math.round(score * 100) : null,
    lcpMs: a["largest-contentful-paint"]?.numericValue != null ? Math.round(num(a["largest-contentful-paint"]?.numericValue)) : null,
    lcpElement: str(node.nodeLabel) || str(node.snippet).slice(0, 160) || null,
    lcpLazy: a["lcp-lazy-loaded"]?.score === 0,
    images: [...images.values()].sort((x, y) => y.wastedBytes - x.wastedBytes).slice(0, 10),
    blocking: items("render-blocking-resources")
      .map((it) => ({ url: str(it.url), wastedMs: Math.round(num(it.wastedMs)) }))
      .filter((x) => x.url && x.wastedMs > 0)
      .slice(0, 8),
    thirdParty: items("third-party-summary")
      .map((it) => ({ entity: str((it.entity as { text?: string } | undefined)?.text ?? it.entity), transferSize: Math.round(num(it.transferSize)), blockingTime: Math.round(num(it.blockingTime)) }))
      .filter((x) => x.entity)
      .sort((x, y) => y.blockingTime - x.blockingTime || y.transferSize - x.transferSize)
      .slice(0, 8),
    unusedJs: items("unused-javascript")
      .map((it) => ({ url: str(it.url), wastedBytes: Math.round(num(it.wastedBytes)) }))
      .filter((x) => x.url && x.wastedBytes > 0)
      .slice(0, 8),
    totalBytes: a["total-byte-weight"]?.numericValue != null ? Math.round(num(a["total-byte-weight"]?.numericValue)) : null,
  };
}

async function lighthouse(url: string, key: string): Promise<SpeedPage> {
  const params = new URLSearchParams({ url, strategy: "mobile", category: "performance", key });
  const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, { signal: AbortSignal.timeout(70_000) });
  if (!res.ok) throw new Error(`PageSpeed ${res.status}`);
  return readLighthouse(url, await res.json());
}

export interface SpeedFix {
  id: string;
  page: string;
  problem: string;
  fix: string;
  impact: "high" | "medium" | "low";
  /** The Image agent takes it from here. */
  byImageAgent?: boolean;
}

const kb = (b: number) => `${Math.round(b / 1000).toLocaleString("en-US")} KB`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} seconds`;
const fileName = (u: string) => {
  try {
    return decodeURIComponent(new URL(u).pathname.split("/").pop() ?? u);
  } catch {
    return u;
  }
};
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
};

/** Plain fixes from one page's measurements, only where Google measured a real cost. */
export function speedFixes(p: SpeedPage, storeHost: string): SpeedFix[] {
  const out: SpeedFix[] = [];
  const id = (k: string) => `${k}:${p.url}`;
  if (p.lcpMs !== null && p.lcpMs > 2500)
    out.push({
      id: id("lcp"),
      page: p.url,
      problem: `On a phone the main content shows after ${secs(p.lcpMs)}${p.lcpElement ? ` (Google names: ${p.lcpElement})` : ""}. Google counts 2.5 seconds or less as good.`,
      fix: p.lcpLazy
        ? "That main image is set to load late. In the theme, turn off lazy loading for the first image on the page."
        : "Make that first image or block lighter, and keep it near the top of the page code. The fixes below say what is slowing it.",
      impact: "high",
    });
  const saved = p.images.reduce((s, i) => s + i.wastedBytes, 0);
  if (saved >= 100_000)
    out.push({
      id: id("images"),
      page: p.url,
      problem: `Images on this page could be ${kb(saved)} lighter (${p.images.length} flagged, the largest ${fileName(p.images[0].url)}).`,
      fix: "The Image agent makes lighter copies of the ones in your Shopify files. Shrink each one below.",
      impact: saved >= 500_000 ? "high" : "medium",
      byImageAgent: true,
    });
  const wait = p.blocking.reduce((s, b) => s + b.wastedMs, 0);
  if (wait >= 300)
    out.push({
      id: id("blocking"),
      page: p.url,
      problem: `${p.blocking.length} ${p.blocking.length === 1 ? "file makes" : "files make"} the page wait about ${secs(wait)} before it shows (the biggest: ${fileName(p.blocking[0].url)}).`,
      fix: "Load these after the page (defer or async), or remove the app or code that adds them if it isn't needed.",
      impact: wait >= 1000 ? "high" : "medium",
    });
  for (const t of p.thirdParty.filter((x) => x.blockingTime >= 250 && !t2own(x.entity, storeHost)).slice(0, 3))
    out.push({
      id: id(`app:${t.entity}`),
      page: p.url,
      problem: `${t.entity} holds the phone busy for ${secs(t.blockingTime)} and loads ${kb(t.transferSize)}.`,
      fix: `If you don't need ${t.entity} on every page, remove it or limit it to the pages that use it.`,
      impact: t.blockingTime >= 600 ? "high" : "medium",
    });
  const unused = p.unusedJs.reduce((s, u) => s + u.wastedBytes, 0);
  if (unused >= 200_000)
    out.push({
      id: id("unused"),
      page: p.url,
      problem: `About ${kb(unused)} of code loads on this page but isn't used (most from ${hostOf(p.unusedJs[0].url)}).`,
      fix: "Remove apps you no longer use; their code often stays in the theme after they are uninstalled.",
      impact: "medium",
    });
  return out;
}
const t2own = (entity: string, host: string) => entity.toLowerCase().includes(host.replace(/^www\./, "").split(".")[0].toLowerCase());

// ---------- storage ----------

async function schema() {
  await ensureSchema();
  await sql`CREATE TABLE IF NOT EXISTS insights_speed (
    account_id bigint PRIMARY KEY REFERENCES insights_accounts (id) ON DELETE CASCADE,
    data jsonb NOT NULL,
    ran_at timestamptz NOT NULL DEFAULT now()
  )`;
}

export interface ImageCandidate {
  fileId: string;
  name: string;
  page: string;
  before: number;
  after: number;
  width: number;
  newWidth: number;
  toJpeg: boolean;
  source: string;
}

export interface ImageChange {
  fileId: string;
  name: string;
  backupId: string;
  before: number;
  after: number;
  at: string;
}

export interface SpeedReport {
  speed?: { at: string; pages: SpeedPage[]; fixes: SpeedFix[]; history: { at: string; score: number | null }[]; note: string } | null;
  images?: { at: string; candidates: ImageCandidate[]; note: string } | null;
  imageChanges?: ImageChange[];
}

export async function readSpeed(accountId: string): Promise<SpeedReport | null> {
  await schema();
  const [row] = await sql`SELECT data FROM insights_speed WHERE account_id = ${accountId}`;
  if (!row?.data) return null;
  try {
    return (typeof row.data === "string" ? JSON.parse(row.data) : row.data) as SpeedReport;
  } catch {
    return null;
  }
}

/** Saves one agent's part, leaving the other's part and the owner's changes as they are in the row. */
async function savePart(accountId: string, part: "speed" | "images", value: unknown) {
  await sql`INSERT INTO insights_speed (account_id, data, ran_at) VALUES (${accountId}, jsonb_build_object(${part}::text, ${JSON.stringify(value)}::jsonb), now())
    ON CONFLICT (account_id) DO UPDATE SET data = jsonb_set(insights_speed.data, ARRAY[${part}::text], ${JSON.stringify(value)}::jsonb), ran_at = now()`;
}

/** Stores with the autopilot on whose weekly run of this agent is due. */
export async function accountsDue(agent: "speed" | "images", limit: number): Promise<string[]> {
  await schema();
  const prefix = `${agent}_run:`;
  const rows = await sql`
    SELECT a.account_id FROM insights_account_autopilot a
    JOIN insights_account_profile p ON p.account_id = a.account_id
    LEFT JOIN insights_settings s ON s.key = ${prefix} || a.account_id::text
    WHERE a.enabled AND coalesce(p.site_domain, '') <> '' AND (s.updated_at IS NULL OR s.updated_at < now() - interval '7 days')
    ORDER BY s.updated_at NULLS FIRST LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}

const autopilotOn = async (accountId: string) => (await import("./settings").then((m) => m.readAccountAutopilot(accountId))).enabled;

// ---------- the Speed agent ----------

/** Key pages to test: those the Store audit read (home, top products, a collection), real pages only, at most 3. */
export function pagesToTest(urls: string[], origin: string): string[] {
  const ok = urls.filter((u) => u.startsWith(origin) && !/\/web-pixels@|\/cart\/?$|\/checkout/.test(u));
  return [...new Set([`${origin}/`, ...ok])].slice(0, 3);
}

export function runSpeed(accountId: string, deadline = Date.now() + 100_000): Promise<string> {
  return runWeekly({
    name: "Speed agent",
    started: "The last speed check didn't finish. It tries again within a day.",
    sabbath: () => isSabbath(),
    autopilotOn: () => autopilotOn(accountId),
    mark: (note, days) => saveRunMarker(`speed_run:${accountId}`, note, days ?? 7),
    report: (ok, detail) => report("speed", ok, detail),
    work: () => speedPass(accountId, deadline),
    plainFailure: () => "The speed check hit a problem and tries again next week.",
  });
}

async function speedPass(accountId: string, deadline: number): Promise<RunOutcome> {
  await schema();
  const [{ readProfile }, { siteVerified }, { readPlatformSettings }, { readStoreAudit }] = await Promise.all([import("../profile"), import("./usage"), import("./settings"), import("./store-audit")]);
  const profile = await readProfile(accountId);
  if (!profile.siteDomain) return { note: "Speed check skipped: no website address yet.", skip: true };
  if (!(await siteVerified(accountId))) return { note: "Speed check waits until the site is shown to be the account's.", skip: true, retryInDays: 1 };
  const key = (await readPlatformSettings()).pagespeedKey;
  if (!key) return { note: "Speed check waits for a PageSpeed key.", skip: true, problem: "No PageSpeed key is set up, so phone speed can't be measured." };
  if (deadline - Date.now() < 75_000) return { note: "Speed check waits for a run with more time.", skip: true, retryInDays: 1 };
  const origin = `https://${profile.siteDomain}`;
  const audit = await readStoreAudit(accountId).catch(() => null);
  const urls = pagesToTest((audit?.pages ?? []).filter((p) => p.facts).map((p) => p.url), origin);
  const results = await Promise.all(urls.map((u) => byDeadline(lighthouse(u, key), deadline - 5_000).catch((e) => (console.error(`speed: ${u} not tested: ${(e as Error).message}`), null))));
  const pages = results.filter((r): r is SpeedPage => r !== null);
  if (!pages.length) throw new Error("None of the key pages could be speed tested.");
  const fixes = pages.flatMap((p) => speedFixes(p, profile.siteDomain!)).sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.impact] - ({ high: 0, medium: 1, low: 2 })[b.impact]);
  const prev = (await readSpeed(accountId).catch(() => null))?.speed;
  const home = pages.find((p) => p.url === `${origin}/`) ?? pages[0];
  const history = [...(prev?.history ?? []), { at: new Date().toISOString(), score: home.score }].slice(-12);
  const note = `Phone speed score ${home.score ?? "not known"} of 100 on ${new URL(home.url).pathname}, ${fixes.length} ${fixes.length === 1 ? "fix" : "fixes"}`;
  await savePart(accountId, "speed", { at: new Date().toISOString(), pages, fixes, history, note });
  return { note, ...(pages.length < urls.length ? { problem: `${urls.length - pages.length} of ${urls.length} pages couldn't be speed tested.` } : {}) };
}

// ---------- the Image agent ----------

/** Whether a PNG has no transparent pixel: read from the file itself, pixel by pixel. Unsure means false. */
export function pngIsOpaque(buf: Buffer, maxRaw = 60_000_000): boolean {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return false;
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const kind = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === "tRNS") return false;
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    off += 12 + len;
  }
  if (type === 0 || type === 2) return true;
  if (type === 3) return true;
  if ((type !== 4 && type !== 6) || interlace !== 0 || (depth !== 8 && depth !== 16)) return false;
  const channels = type === 6 ? 4 : 2;
  const bpp = (channels * depth) / 8;
  const stride = width * bpp;
  if ((stride + 1) * height > maxRaw) return false;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return false;
  }
  if (raw.length < (stride + 1) * height) return false;
  let prev = Buffer.alloc(stride);
  const row = Buffer.alloc(stride);
  const alphaAt = bpp - depth / 8;
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const f = raw[start];
    for (let x = 0; x < stride; x++) {
      const v = raw[start + 1 + x];
      const left = x >= bpp ? row[x - bpp] : 0;
      const up = prev[x];
      const ul = x >= bpp ? prev[x - bpp] : 0;
      let out: number;
      if (f === 0) out = v;
      else if (f === 1) out = v + left;
      else if (f === 2) out = v + up;
      else if (f === 3) out = v + ((left + up) >> 1);
      else if (f === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        out = v + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
      } else return false;
      row[x] = out & 0xff;
    }
    for (let x = alphaAt; x < stride; x += bpp) {
      if (row[x] !== 0xff) return false;
      if (depth === 16 && row[x + 1] !== 0xff) return false;
    }
    prev = Buffer.from(row);
  }
  return true;
}

/** A sensible width for a store image: none wider than 1600 pixels. */
export const MAX_WIDTH = 1600;
/** A lighter copy is offered only when it is at most this share of the original, and saves at least 50 KB. */
export const MIN_SHRINK = 0.7;

/** The Shopify file an image address points to: the name after /files/, on the store's own address or Shopify's CDN. */
export function storeFileName(url: string, storeHost: string): string | null {
  try {
    const u = new URL(url);
    const own = u.hostname === storeHost || u.hostname === `www.${storeHost}` || u.hostname === "cdn.shopify.com";
    const m = u.pathname.match(/\/files\/([^/]+\.(?:png|jpe?g))$/i);
    return own && m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

async function download(url: string, max = 15_000_000): Promise<Buffer | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!res?.ok) return null;
  const b = Buffer.from(await res.arrayBuffer());
  return b.length <= max ? b : null;
}

interface FileInfo {
  id: string;
  url: string;
  width: number;
  mime: string;
  size: number;
}

async function findFile(store: StoreAccess, name: string): Promise<FileInfo | null> {
  const d = await shopifyGql<{ files: { nodes: { id: string; mimeType?: string; image?: { url: string; width: number } | null; originalSource?: { fileSize: number | null; url: string | null } | null }[] } }>(
    store,
    `query($q: String!) { files(first: 5, query: $q) { nodes { id ... on MediaImage { mimeType image { url width } originalSource { fileSize url } } } } }`,
    { q: `filename:'${name.replace(/'/g, "")}'` },
  );
  const f = d.files.nodes.find((n) => n.image && fileName(n.image.url) === name);
  if (!f?.image || !f.originalSource?.fileSize) return null;
  return { id: f.id, url: f.image.url.split("?")[0], width: f.image.width, mime: f.mimeType ?? "", size: f.originalSource.fileSize };
}

export function runImages(accountId: string, deadline = Date.now() + 100_000): Promise<string> {
  return runWeekly({
    name: "Image agent",
    started: "The last image check didn't finish. It tries again within a day.",
    sabbath: () => isSabbath(),
    autopilotOn: () => autopilotOn(accountId),
    mark: (note, days) => saveRunMarker(`images_run:${accountId}`, note, days ?? 7),
    report: (ok, detail) => report("images", ok, detail),
    work: () => imagesPass(accountId, deadline),
    plainFailure: () => "The image check hit a problem and tries again next week.",
  });
}

async function imagesPass(accountId: string, deadline: number): Promise<RunOutcome> {
  await schema();
  const [{ readProfile }, { siteFor }] = await Promise.all([import("../profile"), import("./site-source")]);
  const profile = await readProfile(accountId);
  const site = await siteFor(accountId).catch(() => null);
  if (site?.mode !== "shopify" || !site.store || !profile.siteDomain) return { note: "Image check skipped: it works on Shopify stores.", skip: true };
  const r = await readSpeed(accountId);
  const speed = r?.speed;
  if (!speed || Date.now() - Date.parse(speed.at) > 8 * 864e5) return { note: "Image check waits for this week's speed check.", skip: true, retryInDays: 1 };
  const seen = new Set<string>();
  const flagged = speed.pages.flatMap((p) => p.images.map((i) => ({ ...i, page: p.url }))).filter((i) => i.wastedBytes >= 50_000);
  const done = new Set((r?.imageChanges ?? []).map((c) => c.fileId));
  const candidates: ImageCandidate[] = [];
  for (const img of flagged) {
    if (deadline - Date.now() < 10_000 || candidates.length >= 8) break;
    const name = storeFileName(img.url, profile.siteDomain);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const file = await findFile(site.store, name).catch(() => null);
    if (!file || done.has(file.id)) continue;
    const png = /png/i.test(file.mime);
    const jpeg = /jpe?g/i.test(file.mime);
    if (!png && !jpeg) continue;
    const original = png ? await download(file.url) : null;
    const toJpeg = png && original !== null && pngIsOpaque(original);
    const newWidth = Math.min(file.width, MAX_WIDTH);
    if (!toJpeg && newWidth === file.width && !jpeg) continue;
    const source = `${file.url}?width=${newWidth}${toJpeg || jpeg ? "&format=pjpg" : ""}`;
    const copy = await download(source);
    if (!copy) continue;
    if (copy.length > file.size * MIN_SHRINK || file.size - copy.length < 50_000) continue;
    candidates.push({ fileId: file.id, name, page: img.page, before: file.size, after: copy.length, width: file.width, newWidth, toJpeg, source });
  }
  const saved = candidates.reduce((s, c) => s + c.before - c.after, 0);
  const note = candidates.length ? `${candidates.length} ${candidates.length === 1 ? "image" : "images"} can be ${kb(saved)} lighter` : "No image needs a lighter copy";
  await savePart(accountId, "images", { at: new Date().toISOString(), candidates, note });
  return { note };
}

// ---------- the owner's Shrink and Undo ----------

async function fileReady(store: StoreAccess, id: string, tries = 10): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    const d = await shopifyGql<{ node: { fileStatus: string; image?: { url: string } | null } | null }>(store, `query($id: ID!) { node(id: $id) { ... on MediaImage { fileStatus image { url } } } }`, { id });
    if (d.node?.fileStatus === "READY" && d.node.image?.url) return d.node.image.url.split("?")[0];
    if (d.node?.fileStatus === "FAILED") return null;
    await new Promise((res) => setTimeout(res, 1_500));
  }
  return null;
}

const fileSize = async (store: StoreAccess, id: string) =>
  (await shopifyGql<{ node: { originalSource?: { fileSize: number | null } | null } | null }>(store, `query($id: ID!) { node(id: $id) { ... on MediaImage { originalSource { fileSize } } } }`, { id })).node?.originalSource?.fileSize ?? null;

/**
 * The owner's Shrink on one image: reserved first (one statement, so two clicks never do it twice), the original kept
 * as a backup file, then the file's content replaced in place with the measured lighter copy. Undo puts the backup's
 * content back. Returns why not, or null when done.
 */
export async function applyImage(accountId: string, fileId: string, checkAt: string | null, undo = false): Promise<string | null> {
  const r = await readSpeed(accountId);
  const { siteFor } = await import("./site-source");
  const site = await siteFor(accountId).catch(() => null);
  if (site?.mode !== "shopify" || !site.store) return "Connect your Shopify store first.";
  const store = site.store;
  if (undo) {
    const c = (r?.imageChanges ?? []).find((x) => x.fileId === fileId);
    if (!c) return "That change isn't on the list anymore.";
    const backup = await fileReady(store, c.backupId, 2);
    if (!backup) return "The original copy couldn't be found in your Shopify files, so it can't be put back from here.";
    await shopifyGql(store, `mutation($f: [FileUpdateInput!]!) { fileUpdate(files: $f) { userErrors { field message } } }`, { f: [{ id: c.fileId, originalSource: backup }] });
    await sql`UPDATE insights_speed SET data = jsonb_set(data, '{imageChanges}',
      (SELECT coalesce(jsonb_agg(e ORDER BY n), '[]'::jsonb) FROM jsonb_array_elements(coalesce(data->'imageChanges', '[]'::jsonb)) WITH ORDINALITY AS t(e, n) WHERE e->>'fileId' <> ${fileId}))
      WHERE account_id = ${accountId}`;
    await shopifyGql(store, `mutation($ids: [ID!]!) { fileDelete(fileIds: $ids) { userErrors { field message } } }`, { ids: [c.backupId] }).catch(() => undefined);
    return null;
  }
  const images = r?.images;
  if (!images || checkAt !== images.at) return "A newer check came in. Look it over and shrink again.";
  const c = images.candidates.find((x) => x.fileId === fileId);
  if (!c) return "That image isn't in the latest check.";
  if ((await fileSize(store, fileId)) !== c.before) return "That image changed since the check. It's checked again next week.";
  const change: ImageChange = { fileId, name: c.name, backupId: "", before: c.before, after: c.after, at: new Date().toISOString() };
  const reserved = await sql`UPDATE insights_speed SET data = jsonb_set(data, '{imageChanges}', coalesce(data->'imageChanges', '[]'::jsonb) || ${JSON.stringify([change])}::jsonb)
    WHERE account_id = ${accountId} AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(data->'imageChanges', '[]'::jsonb)) e WHERE e->>'fileId' = ${fileId})
    RETURNING account_id`;
  if (!reserved.length) return "That image was already made lighter.";
  const drop = () =>
    sql`UPDATE insights_speed SET data = jsonb_set(data, '{imageChanges}',
      (SELECT coalesce(jsonb_agg(e ORDER BY n), '[]'::jsonb) FROM jsonb_array_elements(coalesce(data->'imageChanges', '[]'::jsonb)) WITH ORDINALITY AS t(e, n) WHERE e->>'fileId' <> ${fileId}))
      WHERE account_id = ${accountId}`.catch(async () => report("images", false, "An image change was reserved but couldn't be cleared after it failed."));
  // The original, kept first as its own file, so Undo can always put it back.
  const made = await shopifyGql<{ fileCreate: { files: { id: string }[] } }>(store, `mutation($f: [FileCreateInput!]!) { fileCreate(files: $f) { files { id } userErrors { field message } } }`, {
    f: [{ originalSource: (await fileReady(store, fileId, 1)) ?? "", filename: `dashpatrol-original-${c.name}`, contentType: "IMAGE" }],
  }).catch(() => null);
  const backupId = made?.fileCreate.files[0]?.id;
  if (!backupId || !(await fileReady(store, backupId))) {
    await drop();
    if (backupId) await shopifyGql(store, `mutation($ids: [ID!]!) { fileDelete(fileIds: $ids) { userErrors { field message } } }`, { ids: [backupId] }).catch(() => undefined);
    return "The original couldn't be backed up, so nothing was changed. Try again later.";
  }
  await sql`UPDATE insights_speed SET data = jsonb_set(data, '{imageChanges}',
    (SELECT coalesce(jsonb_agg(CASE WHEN e->>'fileId' = ${fileId} THEN jsonb_set(e, '{backupId}', to_jsonb(${backupId}::text)) ELSE e END ORDER BY n), '[]'::jsonb)
     FROM jsonb_array_elements(coalesce(data->'imageChanges', '[]'::jsonb)) WITH ORDINALITY AS t(e, n)))
    WHERE account_id = ${accountId}`;
  try {
    await shopifyGql(store, `mutation($f: [FileUpdateInput!]!) { fileUpdate(files: $f) { userErrors { field message } } }`, { f: [{ id: fileId, originalSource: c.source }] });
  } catch (e) {
    await drop();
    await shopifyGql(store, `mutation($ids: [ID!]!) { fileDelete(fileIds: $ids) { userErrors { field message } } }`, { ids: [backupId] }).catch(() => undefined);
    throw e;
  }
  return null;
}

/** Everything the Speed card shows. */
export async function speedView(accountId: string) {
  const [r, [s], [i]] = await Promise.all([
    readSpeed(accountId),
    sql`SELECT value FROM insights_settings WHERE key = ${`speed_run:${accountId}`}`,
    sql`SELECT value FROM insights_settings WHERE key = ${`images_run:${accountId}`}`,
  ]);
  const noteOf = (v: unknown) => {
    try {
      return v ? ((JSON.parse(String(v)) as { note?: string }).note ?? null) : null;
    } catch {
      return null;
    }
  };
  return { report: r, speedNote: noteOf(s?.value), imagesNote: noteOf(i?.value) };
}
