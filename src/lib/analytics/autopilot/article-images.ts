import { ensureSchema, sql } from "../db";
import { readProfile } from "../profile";
import { logChange } from "./engine";
import type { Problem } from "./inspector";
import { readAccountAutopilot } from "./settings";
import { listArticlesWithoutImage, listProductImages, setArticleImage, shopName, type ArticleImage, type StoreAccess } from "./shopify";
import { report } from "./status";
import { postNote } from "./team";

/**
 * Featured images for blog posts. The app has no image generator and never takes images from other sites, so a
 * post gets the featured image of the store's own product it is about, and only when the post is plainly about that
 * product: every distinctive word of the product's title (not the brand, sizes, counts or words every supplement
 * shares) is in the post's title or first paragraph. Otherwise no image is picked and the owner is told. New
 * articles get one when they are posted (new-articles.ts); the Inspector's hourly sweep gives one to published posts
 * that still have none, when the owner lets the autopilot change live content, and logs each so it can be undone.
 */

export interface ProductImage {
  title: string;
  imageUrl: string | null;
  imageAlt: string | null;
}

const STOP = new Set(
  (
    "a an and are as at be best by can do does for from get how in into is it its more most my new no not of on or our " +
    "should than that the their them this to too top up use was what when which who why will with without you your " +
    "vs versus all any per plus only just also very much many each other own same so"
  ).split(" ")
);

/** Words every product page or supplement title shares: they say nothing about which product a post is about. */
const GENERIC = new Set(
  (
    "supplement supplements capsule capsules cap caps complex daily bundle bundles pack packs kit kits set sets stack stacks " +
    "tablet tablets softgel softgels gummy gummies powder liquid drop drops formula blend support extra strength strong " +
    "count ct serving servings day days month months supply size bottle bottles mg mcg g kg oz ml l iu lb lbs " +
    "premium natural organic pure original advanced max ultra high dose vegan gluten free non gmo made usa product products " +
    "women men adult adults kids value pro one two three"
  ).split(" ")
);

/** Names made of a word and a short letter code: "vitamin c" and "vitamin d3" are different products. */
const CODED = new Set(["vitamin", "vit", "omega"]);

const BUNDLE = /\b(bundle|bundles|kit|kits|stack|stacks|pack|packs|set|sets|duo|trio|combo)\b|\+|&/i;

const stem = (w: string) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** A short code such as d3, k2, b12 or c: kept, unlike sizes and counts ("60", "500mg", "90ct"). */
const isCode = (w: string) => /^[a-z]\d{0,3}$/.test(w);
const isSize = (w: string) => /^\d+[a-z]{0,4}$/.test(w);

const plain = (text: string) => text.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");

/** Lowercase words without markup, sizes or counts. Short codes like d3, k2 and b12 are kept; after "vitamin" a
 * code joins it ("vitamin c"). Single letters elsewhere (the l of L-Threonate) are dropped. */
function words(text: string): string[] {
  const raw = plain(text).toLowerCase().split(/[^a-z0-9À-ɏ]+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];
    if (CODED.has(w) && raw[i + 1] && isCode(raw[i + 1])) {
      out.push(`${w} ${raw[++i]}`);
      continue;
    }
    if (isSize(w)) continue;
    if (w.length >= 3 || (w.length === 2 && /^[a-z]\d$/.test(w)) || (/\d/.test(w) && /^[a-z]/.test(w))) out.push(stem(w));
  }
  return out;
}

/** The words of a product title that tell it apart: no stopwords, sizes, counts, generic words or brand. */
export function distinctiveWords(title: string, brand: Set<string> = new Set()): string[] {
  return [...new Set(words(title).filter((w) => !STOP.has(w) && !GENERIC.has(w) && !brand.has(w)))];
}

/** The post's opening: its first paragraph, or the first few hundred characters when it has no paragraph tags. */
function firstParagraph(html: string): string {
  const m = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  if (m && plain(m[1]).trim()) return m[1];
  return plain(html).trim().slice(0, 400);
}

/**
 * Picks the product image for a blog post. A product qualifies only when every one of its distinctive title words is
 * in the post's title or first paragraph; among those, the most specific (more words, rarer among the store's
 * products, more of them in the title) wins, and on a tie a single product goes before a bundle. Null when no
 * product with an image qualifies: the owner is then told, rather than the post getting a wrong product.
 * `text` is the post's body (HTML is fine).
 */
export function bestProductImage(products: ProductImage[], text: string, opts: { title?: string; brand?: string | null } = {}): ArticleImage | null {
  const brand = new Set(words(opts.brand ?? ""));
  const withImage = products.filter((p) => p.imageUrl && p.title.trim());
  if (!withImage.length) return null;
  const titleWords = new Set(words(opts.title ?? ""));
  const opening = new Set([...titleWords, ...words(firstParagraph(text))]);
  const own = withImage.map((p) => ({ p, words: distinctiveWords(p.title, brand), bundle: BUNDLE.test(p.title) }));
  // How many products share each word: a rare word says more about which product it is.
  const shared = new Map<string, number>();
  for (const o of own) for (const w of o.words) shared.set(w, (shared.get(w) ?? 0) + 1);
  let best: { score: number; bundle: boolean; p: ProductImage } | null = null;
  for (const o of own) {
    if (!o.words.length || !o.words.every((w) => opening.has(w))) continue;
    let score = 0;
    for (const w of o.words) score += (1 + Math.log(own.length / (shared.get(w) ?? 1))) * (titleWords.has(w) ? 2 : 1);
    const better = !best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && best.bundle && !o.bundle);
    if (better) best = { score, bundle: o.bundle, p: o.p };
  }
  if (!best) return null;
  return { url: best.p.imageUrl!, altText: (best.p.imageAlt?.trim() || best.p.title.trim()).slice(0, 255) };
}

/** Picks the image for a new post from the store's own products. Throws when the products can't be read. */
export async function pickArticleImage(store: StoreAccess, post: { title: string; html: string }, brand: string | null): Promise<ArticleImage | null> {
  const products = await listProductImages(store);
  return bestProductImage(products, post.html, { title: post.title, brand });
}

/** At most this many posts get an image per sweep, so one run stays short. */
const REPAIRS_PER_RUN = 3;
const KEY = (accountId: string) => `article_images:${accountId}`;
const FAILING = "article_images:failing";

interface SweepState {
  at: string;
  /** Published posts with no image that no product fits: only the owner can add one. */
  needs: { id: string; title: string; path: string }[];
}

async function readState(accountId: string): Promise<SweepState | null> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${KEY(accountId)}`;
  try {
    return row?.value ? (JSON.parse(row.value) as SweepState) : null;
  } catch {
    return null;
  }
}

async function saveState(accountId: string, state: SweepState): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${KEY(accountId)}, ${JSON.stringify(state)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/**
 * The status board holds one entry for the whole platform, so the accounts whose sweep is failing are kept here:
 * one account's success clears only its own failure, and the part shows as working only when none is failing.
 */
export async function reportFor(accountId: string, error: string | null): Promise<void> {
  try {
    await ensureSchema();
    const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${FAILING}`;
    let failing: Record<string, string> = {};
    try {
      failing = row?.value ? (JSON.parse(row.value) as Record<string, string>) : {};
    } catch {
      failing = {};
    }
    if (error) failing[accountId] = error.slice(0, 200);
    else delete failing[accountId];
    await sql`
      INSERT INTO insights_settings (key, value) VALUES (${FAILING}, ${JSON.stringify(failing)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    const list = Object.entries(failing);
    await report("article-images", !list.length, list.length ? list.map(([id, e]) => `account ${id}: ${e}`).join("; ") : null);
  } catch (e) {
    // The list couldn't be kept: still report this account's own result, with its id.
    await report("article-images", !error, error ? `account ${accountId}: ${error}` : null);
    console.error(`article images status not kept: ${(e as Error).message}`);
  }
}

/**
 * Finds the store's published posts without a featured image. When `change` is true it gives up to a few of them the
 * matching product image, logs each in the change history (undoable) and notes it on the team board; it always keeps
 * the list of posts no product fits. Throws when Shopify fails, after saving what it did, so the caller reports it.
 */
export async function sweepArticleImages(accountId: string, store: StoreAccess, opts: { change: boolean }): Promise<{ fixed: number; needs: SweepState["needs"] }> {
  const missing = await listArticlesWithoutImage(store);
  const needs: SweepState["needs"] = [];
  let fixed = 0;
  const errors: string[] = [];
  if (missing.length) {
    const profile = await readProfile(accountId).catch(() => null);
    const shop = await shopName(store).catch(() => "");
    const brand = [profile?.brandName, shop].filter(Boolean).join(" ");
    const origin = `https://${profile?.siteDomain ?? store.shopDomain}`;
    const products = await listProductImages(store);
    for (const a of missing) {
      const image = bestProductImage(products, a.body, { title: a.title, brand });
      if (!image) {
        needs.push({ id: a.id, title: a.title, path: a.path });
        continue;
      }
      if (!opts.change || fixed >= REPAIRS_PER_RUN) continue;
      const base = { accountId, runId: null, pageUrl: `${origin}${a.path}`, resourceType: "article", resourceId: a.id, query: "", field: "article_image" as const, before: null };
      const reason = `The post had no image, so its blog card showed an empty box. It now shows the store's own product it is about (${image.altText}).`;
      try {
        const live = await setArticleImage(store, a.id, image);
        fixed++;
        await logChange({ ...base, after: live ?? image.url, reason, status: "applied" });
        await postNote(accountId, "Article images", "did", `The blog post "${a.title}" had no image, so it now shows the image of the store's own product that fits it (${image.altText}). You can undo it in the change history.`, {
          ref: `article-image:${a.id}`,
        });
      } catch (e) {
        errors.push(`"${a.title}": ${(e as Error).message}`);
        await logChange({ ...base, after: image.url, reason, status: "failed", note: (e as Error).message }).catch(() => undefined);
      }
    }
  }
  await saveState(accountId, { at: new Date().toISOString(), needs });
  if (errors.length) throw new Error(`A blog post image couldn't be set in Shopify (${errors.join("; ").slice(0, 300)})`);
  return { fixed, needs };
}

/**
 * The Inspector's part: on a repair pass it runs the sweep for a connected Shopify store (images are set only while
 * the autopilot is on and allowed to change live content, the same switches the engine obeys) and reports how it
 * went to the status board; on every pass it returns one problem listing the posts only the owner can give an image.
 * The team board keeps it as one note, so the owner is told once, not every hour.
 */
export async function articleImageProblems(accountId: string, opts: { repair?: boolean } = {}): Promise<Problem[]> {
  const auto = await readAccountAutopilot(accountId);
  if (!auto.shopDomain || !auto.shopTokenEnc) return [];
  if (opts.repair) {
    try {
      await sweepArticleImages(accountId, { accountId, shopDomain: auto.shopDomain }, { change: auto.enabled && auto.allowContent });
      await reportFor(accountId, null);
    } catch (e) {
      console.error(`article images sweep failed for ${accountId}: ${(e as Error).message}`);
      await reportFor(accountId, (e as Error).message);
    }
  }
  const state = await readState(accountId).catch(() => null);
  return imageNeedsProblem(state?.needs ?? []);
}

/** One owner problem for every published post no product fits, naming up to 10 of them. */
export function imageNeedsProblem(needs: { title: string }[]): Problem[] {
  if (!needs.length) return [];
  const named = needs.slice(0, 10).map((n) => `"${n.title}"`).join(", ");
  const more = needs.length > 10 ? `, and ${needs.length - 10} more` : "";
  const one = needs.length === 1;
  return [
    {
      id: "article-image:needs",
      text: `${one ? "A blog post has" : `${needs.length} blog posts have`} no image, so ${one ? "its card" : "their cards"} on the blog ${one ? "shows" : "show"} an empty box: ${named}${more}. None of your products fits ${one ? "it" : "them"}, so the app can't add one.`,
      fix: "Add an image to each in Shopify: Online Store, Blog posts, open the post, add an image and save.",
      who: "owner",
    },
  ];
}
