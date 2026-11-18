import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPricing, listedSkus, matchCatalog, pricingNote, skuSplits, unitsOf, type Catalog, type CatalogVariant, type SoldPrices } from "../src/lib/analytics/autopilot/pricing-check";

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
const NOW = Date.parse("2026-11-18T12:00:00Z");
/** Orders read back to 60 days ago. */
const soldMap = (entries: [string, number][], since = "2026-09-19T00:00:00Z"): SoldPrices => ({ top: new Map(entries), since });

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
  assert.deepEqual(skuSplits("46710-822-2PK")[0], { base: "46710-822", units: 2 });
  assert.deepEqual(skuSplits("ABC-3PACK")[0], { base: "ABC", units: 3 });
  assert.deepEqual(skuSplits("ABC"), []);
  // Longest base first: "10012PK" is item 1001 times 2 before item 100 times 12.
  assert.deepEqual(skuSplits("10012PK").slice(0, 2), [
    { base: "1001", units: 2 },
    { base: "100", units: 12 },
  ]);
  // One item with a plus in its SKU is not a list.
  assert.deepEqual(listedSkus("SPF50+"), []);
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
  const cat = before();
  const sold = soldMap(cat.variants.map((x) => [x.variantId, x.price]));
  const f = checkPricing(cat, origin, sold, NOW);
  const kinds = (product: string, option: string | null = null) => f.filter((x) => x.product === product && x.option === option).map((x) => x.kind);
  // Two of the same bottle cost more than a mixed bundle holding that bottle.
  assert.ok(kinds("Mushroom 10X", "2 Pack").includes("pack-vs-mix"));
  // A saving too small to notice.
  assert.ok(kinds("Moringa and Raspberry Bundle").includes("small-saving"));
  // Crossed out prices that aren't the items' own prices added up.
  assert.ok(kinds("Neuro Plus and Mushroom 10X Bundle").includes("compare-at-sum"));
  // A single item's crossed out price no order was charged.
  assert.ok(kinds("Neuro Plus").includes("compare-at-never-charged"));
  // The most important first, and each id names what it is about (unique, never a place in the list).
  assert.equal(f[0].impact, "high");
  assert.equal(new Set(f.map((x) => x.id)).size, f.length);
  assert.ok(f.every((x) => x.id.startsWith(`${x.kind}:`)));
  // The claim names the dates the orders actually cover.
  assert.match(f.find((x) => x.kind === "compare-at-never-charged")!.problem, /no order since September 19, 2026/);
  // Plain words for the owner: no hyphens or dashes.
  for (const x of f) assert.doesNotMatch(`${x.problem} ${x.fix}`, /[-‐-―]/);
});

test("the fixed store has nothing left to flag", () => {
  const neuro = v("Neuro Plus", "Default Title", "N1", 2299, null);
  const mush1 = v("Mushroom", "1 Bottle", "M1", 2299, null, "M");
  const mush2 = v("Mushroom", "2 Pack", "M1-2PK", 3899, 4598, "M");
  const mush3 = v("Mushroom", "3 Pack", "M1-3PK", 5499, 6897, "M");
  const mix = v("Neuro and Mushroom Bundle", "Default Title", "N1,M1", 3999, 4598);
  const sold = soldMap([[neuro.variantId, 2299]]);
  assert.deepEqual(checkPricing({ currency: "USD", capped: false, variants: [neuro, mush1, mush2, mush3, mix] }, origin, sold, NOW), []);
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
  const charged = checkPricing({ currency: "USD", capped: false, variants: [one, two] }, origin, soldMap([[one.variantId, 2500]]), NOW);
  assert.ok(!charged.some((x) => x.kind === "compare-at-never-charged"));
  // Orders covering only a few days are too few to judge.
  const fewDays = checkPricing({ currency: "USD", capped: false, variants: [one, two] }, origin, soldMap([[one.variantId, 1000]], "2026-11-10T00:00:00Z"), NOW);
  assert.ok(!fewDays.some((x) => x.kind === "compare-at-never-charged"));
  const never = checkPricing({ currency: "USD", capped: false, variants: [one, two] }, origin, soldMap([[one.variantId, 1000]]), NOW);
  const n1 = never.find((x) => x.kind === "compare-at-never-charged");
  assert.equal(n1?.apply?.compareAtAfter, null);
  assert.match(n1!.problem, /highest was \$10\.00/);
});

test("the note says plainly what was and wasn't checked", () => {
  assert.equal(pricingNote({ findings: [], checked: { variants: 9, packs: 2, bundles: 1 }, orders: "read" }), "2 packs and 1 bundle checked, nothing to fix");
  assert.match(pricingNote({ findings: [], checked: { variants: 1, packs: 0, bundles: 0 }, orders: "no-access" }), /may not read orders/);
});

test("exactly 10% off is not called a saving under 10%", () => {
  const one = v("Soap", "1 Bar", "S1", 1000, null, "S");
  const two = v("Soap", "2 Pack", "S1-2PK", 1800, 2000, "S");
  assert.deepEqual(checkPricing({ currency: "USD", capped: false, variants: [one, two] }, origin, null).map((x) => x.kind), []);
});

test("a numeric SKU never matches a pack to a different product", () => {
  const widget = v("Widget", "Default Title", "100", 500, null);
  const gadget = v("Gadget", "Default Title", "1001", 3000, null);
  const pack = v("Gadget 2 Pack", "Default Title", "10012PK", 5500, 6000);
  const m = matchCatalog([widget, gadget, pack]);
  assert.equal(m.packs.length, 1);
  assert.equal(m.packs[0].single.variantId, gadget.variantId);
});

test("a crossed out price at or below the price isn't shown, so it is treated as missing", () => {
  const one = v("Soap", "1 Bar", "S1", 1000, null, "S");
  const two = v("Soap", "2 Pack", "S1-2PK", 1700, 1700, "S");
  const f = checkPricing({ currency: "USD", capped: false, variants: [one, two] }, origin, null);
  assert.deepEqual(f.map((x) => x.kind), ["compare-at-missing"]);
  // Apply checks the crossed out price that is really saved, so it isn't refused as changed.
  assert.equal(f[0].apply?.compareAtBefore, 1700);
});

test("a free sample is never a price to compare against", () => {
  const sample = v("Soap", "1 Bar", "S1", 0, null, "S");
  const two = v("Soap", "2 Pack", "S1-2PK", 1700, null, "S");
  assert.deepEqual(checkPricing({ currency: "USD", capped: false, variants: [sample, two] }, origin, null), []);
});

test("no 'never charged' claim when an order had more lines than were read", () => {
  const one = v("Soap", "1 Bar", "S1", 1000, 2500, "S");
  const f = checkPricing({ currency: "USD", capped: false, variants: [one] }, origin, { ...soldMap([[one.variantId, 1000]]), truncated: true }, NOW);
  assert.ok(!f.some((x) => x.kind === "compare-at-never-charged"));
});
