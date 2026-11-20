/**
 * Which of the owner's products to pitch to a business, from what that business does. The owner lists each product
 * with the kinds of practice or interest it fits (their own words, like "sports, joint, chiropract"), and each contact
 * is matched by its type, segment and name. Nothing is invented: a product is suggested only when one of its words
 * appears in what the contact is, and the matching words are shown as the reason. Pure, so the page and the server
 * agree.
 */

export interface PitchProduct {
  name: string;
  /** Words for the businesses it fits, matched by their start ("chiropract" matches Chiropractic and Chiropractor). */
  fits: string[];
}

export interface Pitch {
  name: string;
  /** The words of the contact that matched. */
  why: string[];
}

const clean = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n) : "");

/** The product list from saved settings or a form: at most 40 products, 20 fit words each. */
export function cleanProducts(input: unknown): PitchProduct[] {
  if (!Array.isArray(input)) return [];
  const out: PitchProduct[] = [];
  for (const p of input) {
    const r = (p ?? {}) as Record<string, unknown>;
    const name = clean(r.name, 80);
    if (!name || out.some((o) => o.name.toLowerCase() === name.toLowerCase())) continue;
    const fits = [...new Set((Array.isArray(r.fits) ? r.fits : String(r.fits ?? "").split(",")).map((f) => clean(f, 40).toLowerCase()).filter((f) => f.length >= 3))].slice(0, 20);
    out.push({ name, fits });
  }
  return out.slice(0, 40);
}

/** "Magnesium Complex: sports, sleep" lines into products, and back. */
export function productsFromLines(text: string): PitchProduct[] {
  return cleanProducts(
    text
      .split("\n")
      .map((line) => {
        const i = line.indexOf(":");
        return i < 0 ? { name: line, fits: [] } : { name: line.slice(0, i), fits: line.slice(i + 1) };
      }),
  );
}

export const productsToLines = (list: PitchProduct[]) => list.map((p) => `${p.name}: ${p.fits.join(", ")}`).join("\n");

/**
 * The products that fit a contact best, most matching words first (ties keep the owner's order), up to `max`.
 * `text` is what the contact is: its type, segment, company name and the like.
 */
export function matchProducts(text: string, products: PitchProduct[], max = 3): Pitch[] {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  if (!words.length) return [];
  const scored = products
    .map((p, order) => {
      const why = [...new Set(p.fits.filter((f) => words.some((w) => w.startsWith(f) || (w.length >= 5 && f.startsWith(w)))))];
      return { name: p.name, why, order };
    })
    .filter((p) => p.why.length);
  scored.sort((a, b) => b.why.length - a.why.length || a.order - b.order);
  return scored.slice(0, max).map(({ name, why }) => ({ name, why }));
}
