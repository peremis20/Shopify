import Anthropic from "@anthropic-ai/sdk";
import type { AiProvider } from "./settings";
import type { StoreResource } from "./shopify";

/**
 * Writes on-page improvements with Claude (or Groq or Gemini when Claude has no key). Every answer comes back as JSON
 * matching a schema, and all HTML is cleaned before it reaches the store.
 */

const MODEL = "claude-opus-5-5";

const RULES = `You are the SEO editor for a Shopify store that sells dietary supplements.
Write for real shoppers first, search engines second.

Hard rules:
- Never claim a product or ingredient cures, treats, prevents, heals or diagnoses any disease or condition. Use careful wording such as "supports" or "may help", and only for well established, general wellness benefits.
- Never invent studies, statistics, quotes, reviews, prices, guarantees, certifications or ingredients. Only state facts present in the page text you are given.
- Match the existing brand voice. Plain, friendly, confident. No hype, no exclamation marks, no emojis.
- Use the target search phrase naturally once in the title and once in the description. Never repeat keywords unnaturally.
- The title and description may only promise what the page actually delivers. Don't use words like "brands", "top 10", "best of", "reviews", "ranked", "vs", "prices" or a year unless the page text really contains that (named brands, a ranked list, a comparison, prices, that year).
- Fix obvious spelling and terminology mistakes instead of copying them (for example "berberine HCl", hydrochloride, never "HCI").`;

export interface PageImprovement {
  metaTitle: string;
  metaDescription: string;
  /** Empty string when the page already covers the topic well. */
  contentSectionHtml: string;
  altTexts: { imageId: string; alt: string }[];
  reason: string;
  /** False when searchers want something the page can't honestly give (e.g. a list of named brands it doesn't have). */
  intentMatch: boolean;
  /** When intentMatch is false: what the page would need, as a content idea. */
  missingForIntent: string;
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
    intentMatch: {
      type: "boolean",
      description:
        "True if this page can honestly give people searching the target phrase what they want, using only its own facts. False if they want something it lacks and can't add from its facts, for example a list of named brands, a ranking, prices or product comparisons the page doesn't have.",
    },
    missingForIntent: {
      type: "string",
      description: "If intentMatch is false: one sentence on what the page would need (a content idea for the store owner). Otherwise an empty string.",
    },
  },
  required: ["metaTitle", "metaDescription", "contentSectionHtml", "altTexts", "reason", "intentMatch", "missingForIntent"],
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

/** Fixes mistakes writers copy from existing text: chemical forms, doubled brand suffixes, stray spaces. */
export function polish(text: string): string {
  return (text ?? "")
    .replace(/\bHCI\b/g, "HCl") // hydrochloride salts (berberine HCl), often mistyped with a capital i
    .replace(/(\s*\|\s*[^|]+)\1+$/, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const plainText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function askClaude<T>(apiKey: string, prompt: string, schema: Record<string, unknown>): Promise<T> {
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

// ---------- Gemini ----------

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
let geminiModels: { key: string; names: string[] } | null = null;

/**
 * Gemini models this key can use, best first: newest stable "flash", then "flash-lite", then "pro"
 * (or just GEMINI_MODEL if set). The later ones are backups for when the first is overloaded.
 */
async function pickGeminiModels(apiKey: string): Promise<string[]> {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];
  if (geminiModels?.key === apiKey) return geminiModels.names;
  const res = await fetch(`${GEMINI_API}/models?pageSize=200&key=${encodeURIComponent(apiKey)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini didn't accept the key: ${body?.error?.message ?? res.status}`);
  const usable = ((body.models ?? []) as { name: string; supportedGenerationMethods?: string[] }[])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /^gemini-[\d.]+-(flash|flash-lite|pro)$/.test(n));
  const rank = (n: string) => (n.endsWith("flash") ? 0 : n.endsWith("flash-lite") ? 1 : 2);
  const version = (n: string) => parseFloat(n.split("-")[1]);
  usable.sort((a, b) => rank(a) - rank(b) || version(b) - version(a));
  if (!usable.length) throw new Error("No Gemini model is available for this key.");
  geminiModels = { key: apiKey, names: usable.slice(0, 4) };
  return geminiModels.names;
}

/** Gemini's schema format: OpenAPI style types and no additionalProperties. */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "additionalProperties") continue;
    out[k] = k === "type" && typeof v === "string" ? v.toUpperCase() : toGeminiSchema(v);
  }
  return out;
}

/** Overloaded or rate limited: worth a retry, or another model. */
const aiBusy = (status: number) => status === 429 || status === 500 || status === 503;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function askGemini<T>(apiKey: string, prompt: string, schema: Record<string, unknown>): Promise<T> {
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: RULES }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: toGeminiSchema(schema) },
  });
  let lastError = "";
  for (const model of await pickGeminiModels(apiKey)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await pause(2000);
      const res = await fetch(`${GEMINI_API}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        const text = (body.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
        if (!text) throw new Error("Gemini declined to write this change.");
        return JSON.parse(text) as T;
      }
      lastError = body?.error?.message ?? String(res.status);
      if (!aiBusy(res.status)) throw new Error(`Gemini request failed: ${lastError}`);
    }
  }
  throw new Error(`Gemini is busy right now. (${lastError})`);
}

// ---------- Groq ----------

const GROQ_API = "https://api.groq.com/openai/v1";
/** Preferred Groq models, best first. Any other chat model the key can use is a last resort. */
const GROQ_PREFERRED = ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "qwen/qwen3-32b", "openai/gpt-oss-20b"];
let groqModels: { key: string; names: string[] } | null = null;

async function pickGroqModels(apiKey: string): Promise<string[]> {
  if (process.env.GROQ_MODEL) return [process.env.GROQ_MODEL];
  if (groqModels?.key === apiKey) return groqModels.names;
  const res = await fetch(`${GROQ_API}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Groq didn't accept the key: ${body?.error?.message ?? res.status}`);
  const ids = ((body.data ?? []) as { id: string; active?: boolean }[])
    .filter((m) => m.active !== false && !/whisper|tts|guard|embed|vision/i.test(m.id))
    .map((m) => m.id);
  const names = [...GROQ_PREFERRED.filter((n) => ids.includes(n)), ...ids.filter((n) => !GROQ_PREFERRED.includes(n))].slice(0, 3);
  if (!names.length) throw new Error("No Groq model is available for this key.");
  groqModels = { key: apiKey, names };
  return names;
}

/** The first complete JSON object in a reply, ignoring any text or code fences around it. */
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ---------- GitHub Models ----------

const GITHUB_API = "https://models.github.ai";
/** Preferred GitHub Models, best first; only ones in the catalog are used. */
const GITHUB_PREFERRED = ["openai/gpt-4.1", "openai/gpt-4.1-mini", "openai/gpt-4o-mini", "meta/llama-3.3-70b-instruct"];
const githubHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});
let githubModels: string[] | null = null;

async function pickGithubModels(token: string): Promise<string[]> {
  if (process.env.GITHUB_MODEL) return [process.env.GITHUB_MODEL];
  if (githubModels) return githubModels;
  const res = await fetch(`${GITHUB_API}/catalog/models`, { headers: githubHeaders(token) }).catch(() => null);
  const ids = res?.ok ? (((await res.json().catch(() => [])) as { id: string }[]).map((m) => m.id.toLowerCase())) : [];
  // If the catalog can't be read, try the preferred models anyway.
  githubModels = ids.length ? GITHUB_PREFERRED.filter((n) => ids.includes(n)).slice(0, 3) : GITHUB_PREFERRED.slice(0, 3);
  return githubModels;
}

// ---------- OpenAI style chat services (Groq, GitHub Models) ----------

interface ChatService {
  name: string;
  url: string;
  headers: (key: string) => Record<string, string>;
  models: (key: string) => Promise<string[]>;
  options: (model: string) => Record<string, unknown>;
}

const GROQ: ChatService = {
  name: "Groq",
  url: `${GROQ_API}/chat/completions`,
  headers: (key) => ({ Authorization: `Bearer ${key}` }),
  models: pickGroqModels,
  options: (model) => ({ max_completion_tokens: 8192, ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}) }),
};

const GITHUB: ChatService = {
  name: "GitHub Models",
  url: `${GITHUB_API}/inference/chat/completions`,
  headers: githubHeaders,
  models: pickGithubModels,
  options: () => ({ max_tokens: 4096 }),
};

/**
 * The schema goes in the instructions and the reply is checked here. Each
 * model is tried in JSON mode first; when the service rejects its JSON, the
 * rejected text is salvaged if it's complete, then the same model is asked
 * again in plain mode and the JSON is read out of its reply. Only then is the
 * next model tried.
 */
async function askChat<T>(svc: ChatService, apiKey: string, prompt: string, schema: Record<string, unknown>): Promise<T> {
  const required = (schema.required as string[]) ?? [];
  const messages = [
    {
      role: "system",
      content: `${RULES}\n\nReply with only one JSON object, no other text, that matches this JSON schema:\n${JSON.stringify(schema)}\nInside strings, escape double quotes and don't use raw line breaks.`,
    },
    { role: "user", content: prompt },
  ];
  const valid = (out: Record<string, unknown> | null): out is Record<string, unknown> =>
    Boolean(out) && required.every((k) => k in out!);

  let lastError = "";
  for (const model of await svc.models(apiKey)) {
    for (const jsonMode of [true, false]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await pause(2000);
        const res = await fetch(svc.url, {
          method: "POST",
          headers: { ...svc.headers(apiKey), "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.3,
            ...svc.options(model),
            ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          const text: string = body.choices?.[0]?.message?.content ?? "";
          const out = extractJson(text);
          if (valid(out)) return out as T;
          lastError = text ? "the answer wasn't complete JSON" : "the answer was empty";
          break; // try plain mode, or the next model
        }
        lastError = body?.error?.message ?? String(res.status);
        if (res.status === 401 || res.status === 403) throw new Error(`${svc.name} didn't accept the key: ${lastError}`);
        if (res.status === 400 || res.status === 404 || res.status === 422) {
          // Rejected JSON (often fine apart from a stray character or a cut off end), or a model this key can't use.
          const salvaged = extractJson(String(body?.error?.failed_generation ?? ""));
          if (valid(salvaged)) return salvaged as T;
          break;
        }
        if (!aiBusy(res.status)) throw new Error(`${svc.name} request failed: ${lastError}`);
      }
    }
  }
  throw new Error(`${svc.name} couldn't write this change right now. (${lastError})`);
}

function askOne<T>(ai: AiProvider, prompt: string, schema: Record<string, unknown>): Promise<T> {
  if (ai.kind === "groq") return askChat<T>(GROQ, ai.key, prompt, schema);
  if (ai.kind === "github") return askChat<T>(GITHUB, ai.key, prompt, schema);
  return ai.kind === "gemini" ? askGemini<T>(ai.key, prompt, schema) : askClaude<T>(ai.key, prompt, schema);
}

/** Asks the main AI, and each backup in turn if it fails. */
async function askJson<T>(ai: AiProvider, prompt: string, schema: Record<string, unknown>): Promise<T> {
  const errors: string[] = [];
  for (const one of [ai, ...(ai.backups ?? [])]) {
    try {
      return await askOne<T>(one, prompt, schema);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  throw new Error(`${errors.join(" ")} The next run will try again.`);
}

/** Title, description, alt text and (optionally) a new section for one page. */
export interface WriteTarget {
  query: string;
  position: number;
  impressions: number;
  mode: "defend" | "top" | "climb";
  previousPosition?: number;
}

export async function writeImprovement(
  ai: AiProvider,
  page: StoreResource,
  target: WriteTarget,
  /** What each connected app knows about this search and page. */
  briefs: string[],
  allowContent: boolean
): Promise<PageImprovement> {
  const editableBody = page.type === "article" || page.type === "page";
  const goal =
    target.mode === "defend"
      ? `This page held position ${target.previousPosition?.toFixed(1) ?? "near the top"} on Google for "${target.query}" and has slipped to ${target.position.toFixed(1)} over the last 7 days. Refresh it so it wins the spot back and keeps it.`
      : target.mode === "top"
        ? `This page ranks around position ${target.position.toFixed(1)} on Google for "${target.query}". Improve it so it takes position 1.`
        : `Improve this page so it reaches the top 3 on Google for the search "${target.query}". It ranks around position ${target.position.toFixed(1)} now.`;
  const prompt = `${goal}
It had ${target.impressions} impressions in the last ${target.mode === "defend" ? 7 : 28} days.

${briefs.filter(Boolean).join("\n\n")}

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

  const out = await askJson<PageImprovement>(ai, prompt, IMPROVEMENT_SCHEMA);
  return {
    metaTitle: polish(out.metaTitle).slice(0, 70),
    metaDescription: polish(out.metaDescription).slice(0, 170),
    contentSectionHtml: allowContent && editableBody ? cleanHtml(polish(out.contentSectionHtml)) : "",
    altTexts: (out.altTexts ?? [])
      .filter((a) => page.imagesMissingAlt.some((i) => i.id === a.imageId) && a.alt.trim())
      .map((a) => ({ imageId: a.imageId, alt: polish(a.alt).slice(0, 140) })),
    reason: out.reason.trim(),
    intentMatch: out.intentMatch !== false,
    missingForIntent: (out.missingForIntent ?? "").trim(),
  };
}

/** One sentence for the end of another article, linking to the page being boosted. */
export async function writeInternalLink(
  ai: AiProvider,
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

  const out = await askJson<{ sentenceHtml: string }>(ai, prompt, LINK_SCHEMA);
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
export async function checkAiKey(ai: AiProvider): Promise<void> {
  if (ai.kind === "gemini") {
    await pickGeminiModels(ai.key);
    return;
  }
  if (ai.kind === "groq") {
    await pickGroqModels(ai.key);
    return;
  }
  if (ai.kind === "github") {
    const res = await fetch(GITHUB.url, {
      method: "POST",
      headers: { ...githubHeaders(ai.key), "Content-Type": "application/json" },
      body: JSON.stringify({ model: (await pickGithubModels(ai.key))[0], messages: [{ role: "user", content: "Say ok." }], max_tokens: 2 }),
    });
    if (!res.ok) throw new Error(`GitHub Models didn't accept the token (${res.status}).`);
    return;
  }
  const client = new Anthropic({ apiKey: ai.key });
  await client.models.retrieve(MODEL);
}
