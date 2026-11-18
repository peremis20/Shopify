import { test } from "node:test";
import assert from "node:assert/strict";
import { baseSku, checkPricing, listedSkus, matchCatalog, pricingNote, unitsOf, type Catalog, type CatalogVariant } from "../src/lib/analytics/autopilot/pricing-check";

let n = 0;
const v = (productTitle: string, variantTitle: string, sku: string, price: number, compareAt: number | null, productId = productTitle): CatalogVariant => ({
  productId,
  productTitle,
  handle: productTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  variantId: `v${++n}`,
  variantTitle,
  sku,
  price,
  compareAt,
});

const origin = "https://shop.example";

test("units come from pack words, never from capsule counts or sizes", () => {
  assert.equal(unitsOf("2 Pack", "Moringa, 60 Capsules", false), 2);
  assert.equal(unitsOf("3 Bottles", "Magnesium, 90 Count", false), 3);
  assert.equal(unitsOf("1 Bottle", "Magnesium, 90 Count", false), 1);
  assert.equal(unitsOf("Default Title", "Liver Support, 2 Bottle Bundle (60 Day Supply)", true), 2);
  assert.equal(unitsOf("Default Title", "Turmeric, 60 Capsules", true), 1);
  assert.equal(unitsOf("Default Title", "Magnesium Glycinate Capsules, 90 Count", true), 1);
  assert.equal(unitsOf("Set of 3", "Candles", false), 3);
  assert.equal(unitsOf("Large", "T shirt", false), 1);
});

test("SKUs point packs and mixed bundles to their items", () => {
  assert.equal(baseSku("46710-822-2PK"), "46710-822");
  assert.equal(baseSku("ABC-3PACK"), "ABC");
  assert.equal(baseSku("ABC"), null);
  assert.deepEqual(listedSkus("A1,B2"), ["A1", "B2"]);
  assert.deepEqual(listedSkus("A1 + B2"), ["A1", "B2"]);
  assert.deepEqual(listedSkus("A1"), []);
});

test("a mixed bundle counts only when every listed SKU is a known single item", () => {
  const a = v("Alpha", "Default Title", "A1", 2299, null);
  const b = v("Beta", "Default Title", "B1", 2299, null);
  const ok = v("Alpha and Beta Bundle", "Default Title", "A1,B1", 3999, 4598);
  const unknown = v("Alpha and Gamma Bundle", "Default Title", "A1,G1", 3999, null);
  const m = matchCatalog([a, b, ok, unknown]);
  assert.equal(m.mixes.length, 1);
  assert.equal(m.mixes[0].v.variantId, ok.variantId);
});

/** The store as it was before its prices were fixed. */
function before(): Catalog {
  const mush = "Mushroom 10X";
  const neuro = v("Neuro Plus", "Default Title", "46711-812", 2299, 5999);
  const d3 = v("Vitamin D3 K2", "Default Title", "46720-831", 2299, null);
  const mush1 = v(mush, "1 Bottle", "46715-838", 2299, 4599, mush);
  const mush2 = v(mush, "2 Pack", "46715-838-2PK", 4299, 5998, mush);
  const mush3 = v(mush, "3 Pack", "46715-838-3PK", 5999, 8997, mush);
  const moringa = v("Moringa", "Default Title", "46714-811", 2299, 4100);
  const rasp = v("Raspberry Ketone", "Default Title", "46718-126", 2299, 5999);
  return {
    currency: "USD",
    capped: false,
    variants: [
      neuro,
      d3,
      mush1,
      mush2,
      mush3,
      moringa,
      rasp,
      v("Neuro Plus and Mushroom 10X Bundle", "Default Title", "46711-812,46715-838", 4199, 5998),
      v("Moringa and Raspberry Bundle", "Default Title", "46714-811,46718-126", 4299, 4998),
    ],
  };
}

test("the problems the owner found by hand are all flagged", () => {
  const sold = new Map<string, number>();
  const cat = before();
  for (const x of cat.variants) sold.set(x.variantId, x.price);
  const f = checkPricing(cat, origin, sold);
  const kinds = (product: string, option: string | null = null) => f.filter((x) => x.product === product && x.option === option).map((x) => x.kind);
  // Two of the same bottle cost more than a mixed bundle holding that bottle.
  assert.ok(kinds("Mushroom 10X", "2 Pack").includes("pack-vs-mix"));
  // A saving too small to notice.
  assert.ok(kinds("Moringa and Raspberry Bundle").includes("small-saving"));
  // Crossed out prices that aren't the items' own prices added up.
  assert.ok(kinds("Neuro Plus and Mushroom 10X Bundle").includes("compare-at-sum"));
  // A single item's crossed out price no order was charged.
  assert.ok(kinds("Neuro Plus").includes("compare-at-never-charged"));
  // The most important first, numbered in order.
  assert.equal(f[0].impact, "high");
  assert.deepEqual(f.map((x) => x.id), f.map((_, i) => String(i + 1)));
  // Plain words for the owner: no hyphens or dashes.
  for (const x of f) assert.doesNotMatch(`${x.problem} ${x.fix}`, /[-‐-―]/);
});

test("the fixed store has nothing left to flag", () => {
  const neuro = v("Neuro Plus", "Default Title", "N1", 2299, null);
  const mush1 = v("Mushroom", "1 Bottle", "M1", 2299, null, "M");
  const mush2 = v("Mushroom", "2 Pack", "M1-2PK", 3899, 4598, "M");
  const mush3 = v("Mushroom", "3 Pack", "M1-3PK", 5499, 6897, "M");
  const mix = v("Neuro and Mushroom Bundle", "Default Title", "N1,M1", 3999, 4598);
  const sold = new Map([[neuro.variantId, 2299]]);
  assert.deepEqual(checkPricing({ currency: "USD", capped: false, variants: [neuro, mush1, mush2, mush3, mix] }, origin, sold), []);
});

test("a bigger pack that costs more per item than a smaller one is flagged", () => {
  const one = v("Tea", "1 Bag", "T1", 1000, null, "T");
  const two = v("Tea", "2 Bags", "T1-2PK", 1600, null, "T");
  const three = v("Tea", "3 Bags", "T1-3PK", 2700, null, "T");
  const f = checkPricing({ currency: "USD", capped: false, variants: [one, two, three] }, origin, null);
  assert.ok(f.some((x) => x.kind === "ladder" && x.option === "3 Bags"));
});

test("a pack that saves nothing is high impact, with a suggested price ending like the store's", () => {
  const one = v("Soap", "1 Bar Pack", "S1", 899, null, "S");
  const two = v("Soap", "2 Pack", "S1-2PK", 1798, null, "S");
  const f = checkPricing({ currency: "USD", capped: false, variants: [one, two] }, origin, null);
  const x = f.find((y) => y.kind === "no-saving");
  assert.ok(x);
  assert.equal(x.impact, "high");
  assert.match(x.fix, /\$14\.99/);
});

test("crossed out prices: Apply is offered only for a change that is certain, and order history is needed for singles", () => {
  const one = v("Soap", "1 Bar", "S1", 1000, 2500, "S");
  const two = v("Soap", "2 Pack", "S1-2PK", 1700, 3000, "S");
  const noOrders = checkPricing({ currency: "USD", capped: false, variants: [one, two] }, origin, null);
  assert.ok(!noOrders.some((x) => x.kind === "compare-at-never-charged"));
  const sum = noOrders.find((x) => x.kind === "compare-at-sum");
  assert.deepEqual(sum?.apply, { productId: "S", variantId: two.variantId, price: 1700, compareAtBefore: 3000, compareAtAfter: 2000 });
  // Sold at the crossed out price once: it's a real former price, so it stays.
  const charged = checkPricing({ currency: "USD", capped: false, variants: [one, two] }, origin, new Map([[one.variantId, 2500]]));
  assert.ok(!charged.some((x) => x.kind === "compare-at-never-charged"));
  const never = checkPricing({ currency: "USD", capped: false, variants: [one, two] }, origin, new Map([[one.variantId, 1000]]));
  const n1 = never.find((x) => x.kind === "compare-at-never-charged");
  assert.equal(n1?.apply?.compareAtAfter, null);
  assert.match(n1!.problem, /highest was \$10\.00/);
});

test("the note says plainly what was and wasn't checked", () => {
  assert.equal(pricingNote({ findings: [], checked: { variants: 9, packs: 2, bundles: 1 }, orders: "read" }), "2 packs and 1 bundle checked, nothing to fix");
  assert.match(pricingNote({ findings: [], checked: { variants: 1, packs: 0, bundles: 0 }, orders: "no-access" }), /may not read orders/);
});
