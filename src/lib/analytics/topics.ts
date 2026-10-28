import type { KeywordIdea } from "./keyword-options";

/**
 * Groups keywords into content topics without any API: keywords that share
 * most of their meaningful words land in the same topic, and each topic
 * gets a suggested content type from the words people search with.
 */

export interface Topic {
  title: string;
  keywords: KeywordIdea[];
  totalSearches: number;
  contentType: string;
}

const STOP = new Set(["a", "an", "and", "are", "can", "do", "does", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with", "you", "your", "my", "i"]);

const tokens = (k: string) =>
  new Set(
    k
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !STOP.has(w))
      .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
  );

function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  a.forEach((w) => b.has(w) && shared++);
  return shared / Math.min(a.size, b.size || 1);
}

export function contentTypeFor(keywords: string[]): string {
  const text = ` ${keywords.join(" ").toLowerCase()} `;
  if (/ (buy|price|cost|cheap|sale|discount|coupon|near me|shop|order) /.test(text)) return "Product or collection page";
  if (/ (best|top|vs|versus|review|reviews|compare|comparison|alternative) /.test(text)) return "Comparison or roundup";
  if (/ (how|what|why|when|which|does|benefit|benefits|guide|tips|ways|side effects) /.test(text)) return "Guide or blog post";
  return "Blog post or landing page";
}

export function groupTopics(ideas: KeywordIdea[]): Topic[] {
  const sorted = [...ideas].sort((a, b) => (b.avgMonthlySearches ?? 0) - (a.avgMonthlySearches ?? 0));
  const groups: { seed: Set<string>; items: KeywordIdea[] }[] = [];
  for (const idea of sorted) {
    const t = tokens(idea.keyword);
    if (!t.size) continue;
    const home = groups.find((g) => overlap(t, g.seed) >= 0.6);
    if (home) home.items.push(idea);
    else groups.push({ seed: t, items: [idea] });
  }
  return groups
    .map((g) => ({
      title: g.items[0].keyword,
      keywords: g.items,
      totalSearches: g.items.reduce((s, i) => s + (i.avgMonthlySearches ?? 0), 0),
      contentType: contentTypeFor(g.items.map((i) => i.keyword)),
    }))
    .sort((a, b) => b.totalSearches - a.totalSearches || b.keywords.length - a.keywords.length);
}
