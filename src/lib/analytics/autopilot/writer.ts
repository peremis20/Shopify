import Anthropic from "@anthropic-ai/sdk";
import type { StoreResource } from "./shopify";

/**
 * Writes on-page improvements with Claude. Every answer comes back as JSON
 * matching a schema, and all HTML is cleaned before it reaches the store.
 */

const MODEL = "claude-opus-5-5";

const RULES = `You are the SEO editor for a Shopify store that sells dietary supplements.
Write for real shoppers first, search engines second.

Hard rules:
- Never claim a product or ingredient cures, treats, prevents, heals or diagnoses any disease or condition. Use careful wording such as "supports" or "may help", and only for well established, general wellness benefits.
- Never invent studies, statistics, quotes, reviews, prices, guarantees, certifications or ingredients. Only state facts present in the page text you are given.
- Match the existing brand voice. Plain, friendly, confident. No hype, no exclamation marks, no emojis.
- Use the target search phrase naturally once in the title and once in the description. Never repeat keywords unnaturally.`;

export interface PageImprovement {
  metaTitle: string;
  metaDescription: string;
  /** Empty string when the page already covers the topic well. */
  contentSectionHtml: string;
  altTexts: { imageId: string; alt: string }[];
  reason: string;
}

const IMPROVEMENT_SCHEMA = {
  type: "object",
  properties: {
    metaTitle: { type: "string", description: "SEO title, 60 characters or fewer, ending with ' | Peremis' when it fits." },
    metaDescription: { type: "string", description: "Meta description, 120 to 155 characters, with a reason to click." },
    contentSectionHtml: {
      type: "string",
      description: "A new section to append (120 to 250 words): one <h2>, then <p>, <ul>/<li> or a short FAQ with <h3> questions. Empty string if not needed or not allowed.",
    },
    altTexts: {
      type: "array",
      items: {
        type: "object",
        properties: { imageId: { type: "string" }, alt: { type: "string", description: "Under 120 characters, describes the image." } },
        required: ["imageId", "alt"],
        additionalProperties: false,
      },
    },
    reason: { type: "string", description: "One or two sentences on what was missing and what this change fixes." },
  },
  required: ["metaTitle", "metaDescription", "contentSectionHtml", "altTexts", "reason"],
  additionalProperties: false,
};

const LINK_SCHEMA = {
  type: "object",
  properties: {
    sentenceHtml: {
      type: "string",
      description: "One <p> of one or two sentences that fits the end of the article and contains exactly one <a href> to the target. Empty string if no natural fit.",
    },
  },
  required: ["sentenceHtml"],
  additionalProperties: false,
};

const plainText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function askJson<T>(apiKey: string, prompt: string, schema: Record<string, unknown>): Promise<T> {
  const client = new Anthropic({ apiKey });
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
    system: RULES,
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "refusal") throw new Error("Claude declined to write this change.");
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return JSON.parse(text) as T;
}

/** Title, description, alt text and (optionally) a new section for one page. */
export async function writeImprovement(
  apiKey: string,
  page: StoreResource,
  target: { query: string; position: number; impressions: number },
  relatedQueries: string[],
  allowContent: boolean
): Promise<PageImprovement> {
  const editableBody = page.type === "article" || page.type === "page";
  const prompt = `Improve this page so it ranks higher on Google for the search "${target.query}".
It currently ranks around position ${target.position.toFixed(1)} with ${target.impressions} impressions in the last 28 days.
Other searches this page appears for: ${relatedQueries.slice(0, 15).join(", ") || "none"}.

Page type: ${page.type}
Address: ${page.url}
Page title: ${page.title}
Current SEO title: ${page.metaTitle ?? "(not set, Shopify uses the page title)"}
Current meta description: ${page.metaDescription ?? "(not set)"}

Page text:
"""
${plainText(page.body).slice(0, 12000)}
"""

${page.imagesMissingAlt.length ? `Images with no alt text (write one for each): ${page.imagesMissingAlt.map((i) => `${i.id} (${i.url})`).join(", ")}` : "No images need alt text; return an empty altTexts list."}

${
  allowContent && editableBody
    ? `If the page text does not already answer what people searching "${target.query}" want to know, write contentSectionHtml: a new section that fills that gap using only facts consistent with the page. Do not repeat what is already there. Otherwise return an empty string.`
    : "Return an empty string for contentSectionHtml."
}

Keep the SEO title and description if they are already strong for this search; you may return them unchanged.`;

  const out = await askJson<PageImprovement>(apiKey, prompt, IMPROVEMENT_SCHEMA);
  return {
    metaTitle: out.metaTitle.trim().slice(0, 70),
    metaDescription: out.metaDescription.trim().slice(0, 170),
    contentSectionHtml: allowContent && editableBody ? cleanHtml(out.contentSectionHtml) : "",
    altTexts: out.altTexts
      .filter((a) => page.imagesMissingAlt.some((i) => i.id === a.imageId) && a.alt.trim())
      .map((a) => ({ imageId: a.imageId, alt: a.alt.trim().slice(0, 140) })),
    reason: out.reason.trim(),
  };
}

/** One sentence for the end of another article, linking to the page being boosted. */
export async function writeInternalLink(
  apiKey: string,
  source: { title: string; body: string },
  target: { path: string; query: string; title: string }
): Promise<string> {
  const prompt = `Write one short closing paragraph for the article below that naturally points readers to a related page.
Link text should be close to "${target.query}". Link to exactly this address: ${target.path}
Related page title: ${target.title}

Article title: ${source.title}
Article text:
"""
${plainText(source.body).slice(0, 6000)}
"""

If the link would feel forced in this article, return an empty string.`;

  const out = await askJson<{ sentenceHtml: string }>(apiKey, prompt, LINK_SCHEMA);
  return cleanHtml(out.sentenceHtml, target.path);
}

const ALLOWED = new Set(["h2", "h3", "p", "ul", "ol", "li", "strong", "em", "a"]);

/** Keeps only simple formatting tags; links are allowed only to `linkPath`. */
export function cleanHtml(html: string, linkPath?: string): string {
  const cleaned = html
    .replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (tag, name: string, attrs: string) => {
      const n = name.toLowerCase();
      if (!ALLOWED.has(n)) return "";
      const closing = tag.startsWith("</");
      if (n === "a") {
        if (!linkPath) return "";
        if (closing) return "</a>";
        const href = /href\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
        return href === linkPath ? `<a href="${linkPath}">` : "";
      }
      return closing ? `</${n}>` : `<${n}>`;
    })
    .trim();
  if (linkPath && !cleaned.includes(`href="${linkPath}"`)) return "";
  return cleaned;
}

/** Quick check that the key works, without generating anything. */
export async function checkAnthropicKey(apiKey: string): Promise<void> {
  const client = new Anthropic({ apiKey });
  await client.models.retrieve(MODEL);
}
