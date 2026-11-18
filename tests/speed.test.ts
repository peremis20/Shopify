import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { pagesToTest, pngIsOpaque, readLighthouse, speedFixes, storeFileName } from "../src/lib/analytics/autopilot/speed";

const crc = (b: Buffer) => {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
};
/** A tiny RGBA PNG, each row with a different filter, with the given alpha for every pixel but one. */
function rgba(w: number, h: number, alpha: (x: number, y: number) => number) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    row[0] = 0; // no filter: the bytes are the pixels
    for (let x = 0; x < w; x++) row.set([x * 10, y * 10, 50, alpha(x, y)], 1 + x * 4);
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

test("a PNG is opaque only when every pixel is", () => {
  assert.equal(pngIsOpaque(rgba(4, 3, () => 255)), true);
  assert.equal(pngIsOpaque(rgba(4, 3, (x, y) => (x === 3 && y === 2 ? 254 : 255))), false);
  assert.equal(pngIsOpaque(Buffer.from("not a png")), false);
});

test("only the store's own Shopify files are replaced", () => {
  assert.equal(storeFileName("https://peremis.com/cdn/shop/files/hero.png?v=1&width=2400", "peremis.com"), "hero.png");
  assert.equal(storeFileName("https://cdn.shopify.com/s/files/1/05/files/bottle.jpg", "peremis.com"), "bottle.jpg");
  assert.equal(storeFileName("https://other.com/files/hero.png", "peremis.com"), null);
  assert.equal(storeFileName("https://peremis.com/cdn/shop/t/165/assets/about-hero.webp", "peremis.com"), null);
});

test("key pages to test leave out tracking frames and the cart", () => {
  const o = "https://peremis.com";
  assert.deepEqual(pagesToTest([`${o}/web-pixels@abc/sandbox/products/x`, `${o}/cart`, `${o}/products/fiber-blend`, `${o}/collections/all`], o), [`${o}/`, `${o}/products/fiber-blend`, `${o}/collections/all`]);
});

test("fixes come only from what Google measured, in plain words", () => {
  const page = readLighthouse("https://peremis.com/", {
    lighthouseResult: {
      categories: { performance: { score: 0.66 } },
      audits: {
        "largest-contentful-paint": { numericValue: 8076 },
        "largest-contentful-paint-element": { details: { items: [{ items: [{ node: { nodeLabel: "Peremis hero image" } }] }] } },
        "modern-image-formats": { details: { items: [{ url: "https://peremis.com/cdn/shop/files/hero.png", wastedBytes: 1_800_000, totalBytes: 2_000_000 }] } },
        "uses-optimized-images": { details: { items: [{ url: "https://peremis.com/cdn/shop/files/hero.png", wastedBytes: 900_000, totalBytes: 2_000_000 }] } },
        "render-blocking-resources": { details: { items: [{ url: "https://peremis.com/cdn/shop/t/1/assets/base.css", wastedMs: 450 }] } },
        "third-party-summary": { details: { items: [{ entity: { text: "Klaviyo" }, transferSize: 300_000, blockingTime: 700 }] } },
      },
    },
  });
  assert.equal(page.score, 66);
  assert.equal(page.images.length, 1);
  assert.equal(page.images[0].wastedBytes, 1_800_000);
  const f = speedFixes(page, "peremis.com");
  assert.deepEqual(f.map((x) => x.id.split(":")[0]), ["lcp", "images", "blocking", "app"]);
  assert.match(f[0].problem, /8\.1 seconds \(Google names: Peremis hero image\)/);
  assert.ok(f[1].byImageAgent);
  for (const x of f) assert.doesNotMatch(`${x.problem} ${x.fix}`, /[‐-―]|(?<=\s)-(?=\s)/);
});
