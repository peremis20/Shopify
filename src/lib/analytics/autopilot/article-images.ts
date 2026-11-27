import { ensureSchema, sql } from "../db";
import { readProfile } from "../profile";
import type { Problem } from "./inspector";
import { readAccountAutopilot } from "./settings";
import { listArticlesWithoutImage, listProductImages, setArticleImage, shopName, type ArticleImage, type StoreAccess } from "./shopify";
import { report } from "./status";
import { postNote } from "./team";

/**
 * Featured images for blog posts. The app has no image generator and never takes images from other sites, so a
 * post gets the featured image of the store's own product it is about: the product whose distinctive title words
 * (not the brand, sizes, counts or words every supplement shares) the post uses most. New articles get one when
 * they are posted (new-articles.ts); each hour the Inspector's sweep gives one to published posts that still have
 * none, and tells the owner about a post no product fits, once per post.
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

const BUNDLE = /\b(bundle|bundles|kit|kits|stack|stacks|pack|packs|set|sets|duo|trio|combo)\b|\+|&/i;

const stem = (w: string) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** Lowercase words, without markup, numbers, sizes ("60", "500mg", "90ct") or anything shorter than 3 letters. */
function words(text: string): string[] {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .toLowerCase()
    .split(/[^a-z0-9À-ɏ]+/)
    .filter((w) => w.length >= 3 && /[a-zÀ-ɏ]/.test(w) && !/^\d+[a-z]{0,4}$/.test(w))
    .map(stem);
}

/** The words of a product title that can tell it apart: no stopwords, sizes, counts, generic words or brand. */
export function distinctiveWords(title: string, brand: Set<string> = new Set()): string[] {
  return [...new Set(words(title).filter((w) => !STOP.has(w) && !GENERIC.has(w) && !brand.has(w)))];
}

/**
 * Picks the product image for a blog post: the product whose distinctive title words appear in the post, scored by
 * how many match, where (the post's title counts more than its body) and how rare the word is among the store's
 * products (a word only one product has says more than one five share). Null when no product with an image shares a
 * distinctive word. On a tie a single product goes before a bundle. `text` is the post's title and body (HTML is fine).
 */
export function bestProductImage(products: ProductImage[], text: string, opts: { title?: string; brand?: string | null } = {}): ArticleImage | null {
  const brand = new Set(words(opts.brand ?? ""));
  const withImage = products.filter((p) => p.imageUrl && p.title.trim());
  if (!withImage.length) return null;
  const titleWords = new Set(words(opts.title ?? ""));
  const counts = new Map<string, number>();
  for (const w of words(`${opts.title ?? ""} ${text}`)) counts.set(w, (counts.get(w) ?? 0) + 1);
  const own = withImage.map((p) => ({ p, words: distinctiveWords(p.title, brand), bundle: BUNDLE.test(p.title) }));
  // How many products share each word: a rare word is a stronger match.
  const shared = new Map<string, number>();
  for (const o of own) for (const w of o.words) shared.set(w, (shared.get(w) ?? 0) + 1);
  let best: { score: number; bundle: boolean; p: ProductImage } | null = null;
  for (const o of own) {
    let score = 0;
    for (const w of o.words) {
      const n = counts.get(w) ?? 0;
      if (!n) continue;
      const rarity = 1 + Math.log(own.length / (shared.get(w) ?? 1));
      score += rarity * ((titleWords.has(w) ? 3 : 0) + Math.min(n, 5));
    }
    if (score <= 0) continue;
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
 * Finds the store's published posts without a featured image, gives up to a few of them the best product image and
 * notes each on the team board, and keeps the list of posts no product fits. Throws when Shopify fails, after
 * saving what it did, so the caller reports it.
 */
export async function sweepArticleImages(accountId: string, store: StoreAccess): Promise<{ fixed: number; needs: SweepState["needs"] }> {
  const missing = await listArticlesWithoutImage(store);
  const needs: SweepState["needs"] = [];
  let fixed = 0;
  const errors: string[] = [];
  if (missing.length) {
    const profile = await readProfile(accountId).catch(() => null);
    const shop = await shopName(store).catch(() => "");
    const brand = [profile?.brandName, shop].filter(Boolean).join(" ");
    const products = await listProductImages(store);
    for (const a of missing) {
      const image = bestProductImage(products, a.body, { title: a.title, brand });
      if (!image) {
        needs.push({ id: a.id, title: a.title, path: a.path });
        continue;
      }
      if (fixed >= REPAIRS_PER_RUN) continue;
      try {
        await setArticleImage(store, a.id, image);
        fixed++;
        await postNote(accountId, "Article images", "did", `The blog post "${a.title}" had no image, so it now shows the image of the store's own product that fits it best (${image.altText}).`, {
          ref: `article-image:${a.id}`,
        });
      } catch (e) {
        errors.push(`"${a.title}": ${(e as Error).message}`);
      }
    }
  }
  await saveState(accountId, { at: new Date().toISOString(), needs });
  if (errors.length) throw new Error(`A blog post image couldn't be set in Shopify (${errors.join("; ").slice(0, 400)})`);
  return { fixed, needs };
}

/**
 * The Inspector's part: on a repair pass it runs the sweep for a connected Shopify store and reports how it went to
 * the status board; on every pass it returns the posts only the owner can give an image, one problem per post (the
 * team board keeps one note per post, so the owner is told once, not every hour).
 */
export async function articleImageProblems(accountId: string, opts: { repair?: boolean } = {}): Promise<Problem[]> {
  const auto = await readAccountAutopilot(accountId);
  if (!auto.shopDomain || !auto.shopTokenEnc) return [];
  if (opts.repair) {
    try {
      await sweepArticleImages(accountId, { accountId, shopDomain: auto.shopDomain });
      await report("article-images", true);
    } catch (e) {
      console.error(`article images sweep failed for ${accountId}: ${(e as Error).message}`);
      await report("article-images", false, (e as Error).message);
    }
  }
  const state = await readState(accountId).catch(() => null);
  return (state?.needs ?? []).map((n) => ({
    id: `article-image:${n.id}`,
    text: `The blog post "${n.title}" has no image, so its card on the blog shows an empty box. None of your products fits it, so the app can't add one.`,
    fix: `Add an image to it in Shopify: Online Store, Blog posts, open "${n.title}", then add an image and save.`,
    who: "owner" as const,
  }));
}
