import type { StoreResource } from "./shopify";

/**
 * Structured data (schema.org JSON-LD) built only from what's on the page:
 * - BlogPosting for blog posts, when neither the theme nor the post has it
 * - FAQPage when the page has question headings with answers, unless it has one
 * Google uses it to understand the page and, where eligible, show rich results.
 */

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** schema.org types already present in some HTML. */
export function schemaTypesIn(html: string): Set<string> {
  const types = new Set<string>();
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const t of m[1].matchAll(/"@type"\s*:\s*(?:"([^"]+)"|\[([^\]]+)\])/g)) {
      (t[1] ? [t[1]] : t[2].split(",").map((x) => x.replace(/["\s]/g, ""))).forEach((x) => types.add(x));
    }
  }
  return types;
}

/** Question headings (h2 or h3 ending in "?") with the paragraphs under them as the answer. */
export function faqPairs(html: string): { q: string; a: string }[] {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  const pairs: { q: string; a: string }[] = [];
  const re = /<h([23])[^>]*>([\s\S]*?)<\/h\1>([\s\S]*?)(?=<h[1-6][^>]*>|$)/gi;
  for (const m of body.matchAll(re)) {
    const q = text(m[2]);
    if (!q.endsWith("?")) continue;
    const answer = [...m[3].matchAll(/<(p|li)[^>]*>([\s\S]*?)<\/\1>/gi)].map((p) => text(p[2])).filter(Boolean).join(" ");
    if (answer.length >= 20) pairs.push({ q, a: answer.slice(0, 1200) });
  }
  return pairs.slice(0, 20);
}

const BLOCK_RE = /<!-- autopilot:([^ ]+-schema) -->[\s\S]*?<!-- \/autopilot:\1 -->/g;

/** The body without any structured data the autopilot added before (it is rebuilt each time). */
export const withoutAutopilotSchema = (body: string) => body.replace(BLOCK_RE, "").trimEnd();

/**
 * JSON-LD to add for this page, or null when it already has what it needs.
 * `liveHtml` is the published page, so structured data from the theme counts too.
 */
export function buildSchema(page: StoreResource, body: string, liveHtml: string, storeName: string): string | null {
  const own = withoutAutopilotSchema(body);
  const present = new Set([...schemaTypesIn(own), ...schemaTypesIn(withoutAutopilotSchema(liveHtml))]);
  const graph: Record<string, unknown>[] = [];

  // Without the live page we can't see what the theme adds, so only FAQs (which come from the body) are safe.
  if (page.type === "article" && page.article && liveHtml && !present.has("BlogPosting") && !present.has("Article") && !present.has("NewsArticle")) {
    graph.push({
      "@type": "BlogPosting",
      headline: page.title.slice(0, 110),
      ...(page.metaDescription ? { description: page.metaDescription } : {}),
      mainEntityOfPage: page.url,
      ...(page.article.image ? { image: page.article.image } : {}),
      ...(page.article.publishedAt ? { datePublished: page.article.publishedAt } : {}),
      ...(page.article.updatedAt ? { dateModified: page.article.updatedAt } : {}),
      ...(page.article.author ? { author: { "@type": "Person", name: page.article.author } } : {}),
      publisher: { "@type": "Organization", name: storeName },
    });
  }

  if ((page.type === "article" || page.type === "page") && !present.has("FAQPage")) {
    const pairs = faqPairs(own);
    if (pairs.length >= 2) {
      graph.push({
        "@type": "FAQPage",
        mainEntity: pairs.map((p) => ({ "@type": "Question", name: p.q, acceptedAnswer: { "@type": "Answer", text: p.a } })),
      });
    }
  }

  if (!graph.length) return null;
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

/** The published page's HTML, for structured data the theme adds. Empty if it can't be read. */
export async function liveHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; InsightsSEO/1.0)" }, signal: AbortSignal.timeout(10000) }).catch(() => null);
  return res?.ok ? (await res.text().catch(() => "")).slice(0, 3_000_000) : "";
}
