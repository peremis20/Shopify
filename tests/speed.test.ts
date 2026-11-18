import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { pagesToTest, pngIsOpaque, readLighthouse, sameCdnFile, sameSize, speedFixes, storeFileName } from "../src/lib/analytics/autopilot/speed";

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
/** Filters a row the way a PNG encoder does (types 0 to 4), so the decoder's unfiltering is really tested. */
function filterRow(type: number, row: Buffer, prev: Buffer, bpp: number): Buffer {
  const out = Buffer.alloc(row.length);
  for (let x = 0; x < row.length; x++) {
    const left = x >= bpp ? row[x - bpp] : 0;
    const up = prev[x];
    const ul = x >= bpp ? prev[x - bpp] : 0;
    const pa = Math.abs(up - ul);
    const pb = Math.abs(left - ul);
    const pc = Math.abs(left + up - 2 * ul);
    const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
    const pred = [0, left, up, (left + up) >> 1, paeth][type];
    out[x] = (row[x] - pred) & 0xff;
  }
  return Buffer.concat([Buffer.from([type]), out]);
}
/** A tiny RGBA PNG, each row with a different filter, with the given alpha per pixel. */
function rgba(w: number, h: number, alpha: (x: number, y: number) => number) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(w * 4);
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(w * 4);
    for (let x = 0; x < w; x++) row.set([x * 37, y * 53, 200 - x, alpha(x, y)], x * 4);
    rows.push(filterRow(y % 5, row, prev, 4));
    prev = row;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

test("a PNG is opaque only when every pixel is", () => {
  assert.equal(pngIsOpaque(rgba(6, 10, () => 255)), true);
  for (let y = 0; y < 10; y++) assert.equal(pngIsOpaque(rgba(6, 10, (x, yy) => (x === 5 && yy === y ? 254 : 255))), false, `row ${y}`);
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

test("Lighthouse 13's insight audits are read too", () => {
  const page = readLighthouse("https://shop.example/", {
    lighthouseResult: {
      categories: { performance: { score: 0.5 } },
      audits: {
        "largest-contentful-paint": { numericValue: 6000 },
        "image-delivery-insight": { details: { type: "list", items: [{ type: "table", items: [{ url: "https://shop.example/cdn/shop/files/a.png", wastedBytes: 700_000, totalBytes: 900_000 }] }] } } as never,
        "lcp-discovery-insight": { details: { type: "checklist", items: { eagerlyLoaded: { value: false } } } } as never,
        "lcp-breakdown-insight": { details: { type: "list", items: [{ type: "node", nodeLabel: "Hero banner" }] } } as never,
        "render-blocking-insight": { details: { type: "table", items: [{ url: "https://shop.example/x.css", wastedMs: 500 }] } } as never,
        "third-parties-insight": { details: { type: "table", items: [{ entity: "Some App", transferSize: 100_000, mainThreadTime: 800 }] } } as never,
      },
    },
  });
  assert.equal(page.images[0]?.wastedBytes, 700_000);
  assert.equal(page.lcpLazy, true);
  assert.equal(page.lcpElement, "Hero banner");
  assert.equal(page.blocking[0]?.wastedMs, 500);
  assert.deepEqual(page.thirdParty[0], { entity: "Some App", transferSize: 100_000, blockingTime: 800 });
});

test("a CDN image is this store's file only when the folder matches, and sizes allow Shopify's few bytes", () => {
  assert.equal(sameCdnFile("https://cdn.shopify.com/s/files/1/0505/8822/1614/files/logo.png", "https://cdn.shopify.com/s/files/1/0505/8822/1614/files/logo.png?v=2"), true);
  assert.equal(sameCdnFile("https://cdn.shopify.com/s/files/1/9999/files/logo.png", "https://cdn.shopify.com/s/files/1/0505/8822/1614/files/logo.png?v=2"), false);
  assert.equal(sameSize(2_006_772, 2_006_724), true);
  assert.equal(sameSize(250_869, 2_006_724), false);
  assert.equal(sameSize(null, 10), false);
});
