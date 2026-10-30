import Anthropic from "@anthropic-ai/sdk";
import { isRisky } from "./claims";
import { trimWords } from "./guards";
import type { AiProvider } from "./settings";
import type { StoreResource } from "./shopify";

/**
 * Writes on-page improvements with Claude (or Groq or Gemini when Claude has no key). Every answer comes back as JSON
 * matching a schema, and all HTML is cleaned before it reaches the store.
 */

const MODEL = "claude-opus-5-5";

/** Instructions for every request, fitted to the customer's business (see AiProvider.site). */
function rulesFor(site: AiProvider["site"]): string {
  const who = site?.brand ? `"${site.brand}", a website` : "a website";
  return `You are the SEO editor for ${who} that sells ${site?.sells ?? "health and wellness products"}.
Write for real shoppers first, search engines second.
${site?.brand ? `\nEnd SEO titles with " | ${site.brand}" when it fits within 60 characters; never use another brand name there.\n` : ""}${RULES}`;
}

/**
 * How a real person writes, so pages don't read as AI made. Taken from a
 * review of AI written articles where the same skeleton, openings, pet
 * phrases and jokes repeated across every piece.
 */
const VOICE = `
Sound like a real person who knows this subject, not like AI:
- Don't follow a template. Pick the shape this piece needs: sometimes a list, sometimes plain paragraphs, sometimes a few questions. Don't add a FAQ, a "key takeaways" box, a summary or a "read this next" line out of habit.
- Open with something specific to this topic: a fact, a detail, a plain statement. Never open with a "you" scene ("It is 3 p.m.", "The alarm goes off"), and never with "Maybe", "Picture", "Imagine", "Most people", "Have you ever" or "In today's world".
- Never use these phrases: "here is", "here's the thing", "you are not alone", "let's dive in", "dive into", "navigate", "journey", "game changer", "unlock", "elevate", "in conclusion", "the bottom line", "it's important to note", "whether you're".
- No cute asides or tidy jokes. If something is funny, it comes from the facts, not a quip.
- Vary sentence length. Short ones are fine. Not every paragraph needs three sentences.
- Don't use em dashes or hyphens to join clauses; use a comma or a new sentence.
- Use concrete details from the page (names, places, products, numbers it states) instead of general statements. Never make up a quote or a person.`;

/** Phrases and openings that give away AI writing; a block with one is rewritten by the editor or dropped. */
const AI_TELLS = [
  /\bhere(?: is|'s)\b/i,
  /\byou are not alone\b|\byou're not alone\b/i,
  /\b(?:let's )?dive (?:in|into)\b/i,
  /\bgame[ -]changer\b/i,
  /\bunlock(?:s|ing)? the\b/i,
  /\bin conclusion\b|\bthe bottom line\b|\bit'?s (?:important|worth) (?:to note|noting)\b/i,
  /\bwhether you're\b|\bin today's\b/i,
  /^(?:maybe|picture|imagine|have you ever|most people)\b/i,
  /^it is \d{1,2}(?::\d{2})?\s*(?:a\.?m|p\.?m)/i,
  /^the alarm goes off\b/i,
  /\bkey takeaways?\b|\bread this next\b/i,
  /\u2014/,
];

export const hasAiTell = (text: string) => AI_TELLS.some((r) => r.test(text.trim()));

const RULES = `
Hard rules:
- Never claim a product or ingredient cures, treats, prevents, heals or diagnoses any disease or condition. Use careful wording such as "supports" or "may help", and only for well established, general wellness benefits.
- Never write "FDA approved", "clinically proven", "doctor recommended", "miracle", "no side effects", "guaranteed results", a number of pounds to lose, or anything suggesting people replace or stop medication. Everything you write is checked for these and dropped if found.
- Never invent studies, statistics, quotes, reviews, prices, guarantees, certifications or ingredients. Only state facts present in the page text you are given.
- That includes doses, percentages, purity levels, timelines and plant or species names: if the page text doesn't state it, don't write it (any number the page doesn't contain is removed automatically).
- Match the existing brand voice. Plain, friendly, confident. No hype, no exclamation marks, no emojis.
- Use the target search phrase naturally once in the title and once in the description. Never repeat keywords unnaturally.
- The title and description may only promise what the page actually delivers. Don't use words like "brands", "top 10", "best of", "reviews", "ranked", "vs", "prices" or a year unless the page text really contains that (named brands, a ranked list, a comparison, prices, that year).
- Fix obvious spelling and terminology mistakes instead of copying them (for example "berberine HCl", hydrochloride, never "HCI").
${VOICE}`;


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
    metaTitle: { type: "string", description: "SEO title, 60 characters or fewer, ending with the brand name after ' | ' when it fits." },
    metaDescription: { type: "string", description: "Meta description, 120 to 155 characters, with a reason to click." },
    contentSectionHtml: {
      type: "string",
      description:
        "A new section to append (120 to 250 words): one <h2>, then whatever shape fits this topic (<p>, <ul>/<li>, or <h3> questions only when people really ask them). Empty string if not needed or not allowed.",
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

/** Numbers in a text, with thousands separators dropped ("1,500" and "1500" match) and decimal commas as points. */
const numbersIn = (text: string) =>
  new Set((text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,(?=\d{3}(?!\d))/g, "").replace(",", ".")));

/** Removes the paragraphs and list items `drop` picks, then any list or question left with nothing under it. */
export function dropBlocks(html: string, drop: (text: string, index: number) => boolean): string {
  let i = 0;
  return html
    .replace(/<(p|li)>([\s\S]*?)<\/\1>/g, (block, _tag, inner: string) => (drop(plainText(inner), i++) ? "" : block))
    .replace(/<(ul|ol)>\s*<\/\1>/g, "")
    .replace(/<h3>(?:(?!<\/h3>)[\s\S])*<\/h3>\s*(?=<h[23]>|$)/g, "")
    .trim();
}

export const blocksOf = (html: string) => [...html.matchAll(/<(p|li)>([\s\S]*?)<\/\1>/g)].map((m) => plainText(m[2]));

/**
 * Drops paragraphs and list items from a new section that state a number
 * (a dose, a percentage, a study figure) the page itself doesn't have, so the
 * writer can't add health facts the store hasn't published. Headings stay.
 */
export function onlyKnownNumbers(html: string, pageBody: string): string {
  const known = numbersIn(plainText(pageBody));
  return dropBlocks(html, (text) => ![...numbersIn(text)].every((n) => known.has(n)));
}

const CHECK_SCHEMA = {
  type: "object",
  properties: {
    unsupported: {
      type: "array",
      items: { type: "integer" },
      description: "Numbers of the blocks to remove.",
    },
  },
  required: ["unsupported"],
  additionalProperties: false,
};

/**
 * A second, separate pass: checks every paragraph and list item of a new
 * section against the page and removes the ones the page doesn't support.
 */
async function factCheck(ai: AiProvider, html: string, pageBody: string): Promise<string> {
  const blocks = blocksOf(html);
  if (!blocks.length) return html;
  const prompt = `You are fact checking a new section before it's added to a store's page.

Page text (the only source of truth):
"""
${plainText(pageBody).slice(0, 12000)}
"""

New section, numbered:
${blocks.map((b, i) => `[${i}] ${b}`).join("\n")}

List the numbers of blocks to remove. Remove a block if it:
- states a health effect, benefit, timeline, dose, usage advice, safety advice or combination advice (for example with coffee or medication) that the page text doesn't state
- claims what "many users", customers, studies or experts say or do, unless the page says it
- names ingredients, species or products the page doesn't mention
- is filler that says nothing (for example "below are answers to common questions")
Keep blocks that only restate or reorganize what the page says. When unsure, remove it.`;
  const out = await askJson<{ unsupported: number[] }>(ai, prompt, CHECK_SCHEMA);
  const remove = new Set((out.unsupported ?? []).map(Number));
  return dropBlocks(html, (_t, i) => remove.has(i));
}

const EDIT_SCHEMA = {
  type: "object",
  properties: {
    sectionHtml: { type: "string", description: "The section, edited. Same tags as given: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>." },
    notes: { type: "string", description: "One sentence on what read as AI and what you changed." },
  },
  required: ["sectionHtml", "notes"],
  additionalProperties: false,
};

/**
 * A different AI (another service when one is set up) reads the section as a
 * human editor would and rewrites what sounds machine made. It may only
 * reword: the facts are checked again afterwards, and any block still showing
 * an AI tell is dropped.
 */
async function humanEdit(ai: AiProvider, html: string, pageBody: string): Promise<string> {
  const others = [ai, ...(ai.backups ?? [])];
  const editor = others.find((o) => o.kind !== ai.kind) ?? ai;
  const reviewer: AiProvider = { ...editor, site: ai.site, backups: others.filter((o) => o !== editor) };
  const prompt = `You are a human copy editor. Another writer drafted this section for a website, and it must read as if a person who knows the subject wrote it. Readers and Google both notice AI writing.

Section:
"""
${html}
"""

Rewrite only what sounds machine made:
- formula openings, stock phrases and pet words (see the rules above)
- the same tidy shape every time (a FAQ, takeaways or summary that the piece doesn't need)
- cute asides, filler sentences, sentences that all have the same length and rhythm
Keep every fact exactly as given and add no new facts, numbers, names or quotes. If it already reads naturally, return it unchanged.`;
  const out = await askJson<{ sectionHtml: string }>(reviewer, prompt, EDIT_SCHEMA);
  const edited = onlyKnownNumbers(cleanHtml(polish(out.sectionHtml ?? "")), pageBody);
  return dropBlocks(edited, (text) => hasAiTell(text));
}

const plainText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function askClaude<T>(apiKey: string, system: string, prompt: string, schema: Record<string, unknown>): Promise<T> {
  const client = new Anthropic({ apiKey });
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
    system,
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

async function askGemini<T>(apiKey: string, system: string, prompt: string, schema: Record<string, unknown>): Promise<T> {
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
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
async function askChat<T>(svc: ChatService, apiKey: string, system: string, prompt: string, schema: Record<string, unknown>): Promise<T> {
  const required = (schema.required as string[]) ?? [];
  const messages = [
    {
      role: "system",
      content: `${system}\n\nReply with only one JSON object, no other text, that matches this JSON schema:\n${JSON.stringify(schema)}\nInside strings, escape double quotes and don't use raw line breaks.`,
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

function askOne<T>(ai: AiProvider, system: string, prompt: string, schema: Record<string, unknown>): Promise<T> {
  if (ai.kind === "groq") return askChat<T>(GROQ, ai.key, system, prompt, schema);
  if (ai.kind === "github") return askChat<T>(GITHUB, ai.key, system, prompt, schema);
  return ai.kind === "gemini" ? askGemini<T>(ai.key, system, prompt, schema) : askClaude<T>(ai.key, system, prompt, schema);
}

/** Asks the main AI, and each backup in turn if it fails. */
async function askJson<T>(ai: AiProvider, prompt: string, schema: Record<string, unknown>): Promise<T> {
  const errors: string[] = [];
  const system = rulesFor(ai.site);
  for (const one of [ai, ...(ai.backups ?? [])]) {
    try {
      return await askOne<T>(one, system, prompt, schema);
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
  let section = allowContent && editableBody ? onlyKnownNumbers(cleanHtml(polish(out.contentSectionHtml)), page.body) : "";
  // Nothing goes on the page unchecked: if the check itself fails, the section is left out.
  if (section) section = await factCheck(ai, section, page.body).catch(() => "");
  // A second AI edits it so it reads as a person wrote it; if that fails, blocks with AI tells are dropped.
  if (section) section = await humanEdit(ai, section, page.body).catch(() => dropBlocks(section, (text) => hasAiTell(text)));
  // Claim guard: no paragraph that reads as a disease claim or an unprovable promise.
  if (section) section = dropBlocks(section, (text) => isRisky(text));
  // A section reduced to headings alone isn't worth adding.
  if (!blocksOf(section).length) section = "";
  // A risky title or description is never written; the current one stays.
  const safe = (text: string, current: string | null) => (isRisky(text) ? (current ?? "") : text);
  return {
    metaTitle: safe(trimWords(polish(out.metaTitle), 70), page.metaTitle),
    metaDescription: safe(trimWords(polish(out.metaDescription), 170), page.metaDescription),
    contentSectionHtml: section,
    altTexts: (out.altTexts ?? [])
      .filter((a) => page.imagesMissingAlt.some((i) => i.id === a.imageId) && a.alt.trim() && !isRisky(a.alt))
      .map((a) => ({ imageId: a.imageId, alt: trimWords(polish(a.alt), 140) })),
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
  const html = cleanHtml(out.sentenceHtml, target.path);
  return isRisky(html) || hasAiTell(plainText(html)) ? "" : html;
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

export interface NewArticle {
  title: string;
  metaTitle: string;
  metaDescription: string;
  /** Short summary for blog listings. */
  summary: string;
  html: string;
  slug: string;
}

const ARTICLE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "The article's headline, plain and specific, under 70 characters." },
    metaTitle: { type: "string", description: "SEO title, 60 characters or fewer, with the search phrase near the start." },
    metaDescription: { type: "string", description: "Meta description, 120 to 155 characters, with a reason to click." },
    summary: { type: "string", description: "One or two sentences for the blog listing." },
    html: {
      type: "string",
      description:
        "The article body, 900 to 1400 words, no <h1> (the title is the headline): <h2> sections with <p>, and <ul>/<li> or <h3> only where they fit. No links.",
    },
    slug: { type: "string", description: "URL slug: lowercase words joined by hyphens, 3 to 6 words, built from the search phrase." },
  },
  required: ["title", "metaTitle", "metaDescription", "summary", "html", "slug"],
  additionalProperties: false,
};

/**
 * A whole new article for a search no page on the site covers yet. It's
 * planned from what ranks on Google page one (their headings and the
 * questions people ask), written to the same rules as every change, then
 * edited by a second AI, and stripped of any paragraph with a number (no
 * source page to check numbers against) or a health claim.
 */
export async function writeNewArticle(
  ai: AiProvider,
  brief: {
    keyword: string;
    competitors: { domain: string; title: string; headings: string[] }[];
    questions: string[];
    related: string[];
    /** Titles of the site's own articles, so the new one doesn't repeat them. */
    ownTitles: string[];
    /** Broad searches to work in naturally as support (the main search stays the focus). */
    supporting?: string[];
  }
): Promise<NewArticle | null> {
  const prompt = `Write a new article for this website that can rank on Google page one for the search "${brief.keyword}".

What ranks on page one now (learn what searchers expect; never copy their wording):
${brief.competitors.map((c) => `- ${c.domain}: "${c.title}". Sections: ${c.headings.slice(0, 10).join(" / ") || "(none read)"}`).join("\n") || "(not available)"}

Questions people also ask: ${brief.questions.join(" | ") || "(none)"}
Related searches: ${brief.related.join(" | ") || "(none)"}
${brief.supporting?.length ? `Broader searches to mention naturally where they fit, to support the main one (never the focus): ${brief.supporting.join(" | ")}\n` : ""}
The site already has these articles, so don't repeat them: ${brief.ownTitles.slice(0, 40).join(" | ") || "(none)"}

Cover what searchers want better and more clearly than the pages above, in this site's own voice. Answer the main question early, in plain words.
Only use well established, general knowledge. Write no numbers at all: no doses, percentages, statistics, prices, years or counts (paragraphs with numbers are removed).
If this search isn't a fit for this website's business, return an empty string for html.`;

  const out = await askJson<NewArticle>(ai, prompt, ARTICLE_SCHEMA);
  let html = onlyKnownNumbers(cleanHtml(polish(out.html ?? "").replace(/<h1[\s\S]*?<\/h1>/gi, "")), "");
  if (!html) return null;
  // A second AI edits it so it reads as a person wrote it.
  html = await humanEdit(ai, html, "").catch(() => dropBlocks(html, (text) => hasAiTell(text)));
  html = dropBlocks(html, (text) => isRisky(text) || hasAiTell(text));
  // Too little left to stand as an article.
  if (blocksOf(html).length < 8 || plainText(html).split(/\s+/).length < 500) return null;

  const safe = (text: string) => (isRisky(text) || hasAiTell(text) ? "" : text);
  const slug = (out.slug || brief.keyword)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const title = safe(trimWords(polish(out.title), 90)) || brief.keyword.replace(/^./, (c) => c.toUpperCase());
  return {
    title,
    metaTitle: safe(trimWords(polish(out.metaTitle), 70)) || title,
    metaDescription: safe(trimWords(polish(out.metaDescription), 170)),
    summary: safe(trimWords(polish(out.summary), 300)),
    html,
    slug: slug || "article",
  };
}
