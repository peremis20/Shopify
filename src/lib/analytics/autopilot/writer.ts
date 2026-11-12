import { spend } from "./usage";
import { AsyncLocalStorage } from "node:async_hooks";
import { hasDatabase, sql } from "../db";
import { report } from "./status";
import Anthropic from "@anthropic-ai/sdk";
import { isRisky } from "./claims";
import { trimWords } from "./guards";
import type { AiProvider } from "./settings";
import type { StoreResource } from "./shopify";

/**
 * Writes on-page improvements with Claude (or Groq or Gemini when Claude has no key). Every answer comes back as JSON
 * matching a schema, and all HTML is cleaned before it reaches the store.
 */

// Sonnet writes: nearly the same quality for articles at about half the cost; the check comes from another provider (Groq).
const MODEL = "claude-sonnet-5-5";
/**
 * Simple yes or no checks and reading facts off a page (site type, business details, whether a statement is on the
 * page, which backlink sites fit) don't need the writing model: they run on Haiku, about 20 times cheaper. Writing,
 * content checks, plans and the customer view review stay on Sonnet.
 */
const LIGHT_MODEL = "claude-haiku-5-5";

/** The position a search gets when the daily rank check no longer finds it in the range it reads (not a measurement). */
export const UNRANKED_POSITION = 25;

/** Instructions for every request, fitted to the customer's business (see AiProvider.site). */
function rulesFor(site: AiProvider["site"]): string {
  return baseRules(site) + (site?.about ? `\n\nAbout this business (from its own site and owner; write for it specifically, and never claim anything beyond this or the page):\n${site.about}` : "");
}

function baseRules(site: AiProvider["site"]): string {
  const who = site?.brand ? `"${site.brand}", a website` : "a website";
  return site?.readers
    ? `You are the SEO editor for ${who} that publishes ${site.sells}.
Write for real readers first, search engines second. Never sell or push products; inform and help.
${site.brand ? `\nEnd SEO titles with " | ${site.brand}" when it fits within 60 characters; never use another brand name there.\n` : ""}${RULES}`
    : `You are the SEO editor for ${who} that sells ${site?.sells ?? "its products and services"}.
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

/** Claims leaning on sources nobody can check: "studies show", "many users notice", "experts say". */
const UNSOURCED =
  /\b(?:(?:some|many|several|recent|new|clinical)\s+)?(?:studies|research|trials?)\s+(?:show|shows|suggest|suggests|have\s+shown|have\s+observed|observed|found|indicate|point)\b|\b(?:many|most|some)\s+(?:users|people|customers)\s+(?:notice|report|find|say)\b|\bexperts?\s+(?:say|agree|recommend)\b|\banecdotal\b/i;
export const isUnsourced = (text: string) => UNSOURCED.test(text);

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
  /** What the reviewing AI turned down, in plain words. */
  reviewNote?: string;
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

const DAY = "(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|rsday|urday|sday)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DAY_RANGE = new RegExp(`\\b(${DAY})\\.?(?:\\s*[\\u2013\\u2014\\u2015]\\s*|\\s+-\\s+)(${DAY})\\b`, "gi");

/** Fixes mistakes writers copy from existing text: chemical forms, doubled brand suffixes, stray spaces. */
export function polish(text: string): string {
  return (text ?? "")
    .replace(/\bHCI\b/g, "HCl") // hydrochloride salts (berberine HCl), often mistyped with a capital i
    .replace(/[\u2010\u2011]/g, "-") // unusual hyphen characters some models write, shown oddly by some fonts
    // No dashes in anything the site shows: a dash between words (em, en or a spaced hyphen) becomes a comma.
    .replace(/(\d(?:\s*[ap]\.?m\.?)?)(?:\s*[\u2013\u2014\u2015]\s*|\s+-\s+)(\d)/gi, "$1 to $2") // a range: "2–3 weeks" reads "2 to 3 weeks"
    .replace(DAY_RANGE, "$1 to $2") // and so do days and months: "Mon–Fri" reads "Mon to Fri"
    .replace(/\b([A-Z][A-Za-z]{0,3})[\u2013\u2014\u2015](\d)/g, "$1$2") // a letter and a number stay one name: "B–12" reads "B12"
    .replace(/(^|<(?:p|li|h2|h3)>)\s*[\u2013-\u2015]\s*/g, "$1") // a dash opening a block is dropped
    .replace(/\s*[\u2013-\u2015]\s*(?=<\/(?:p|li|h2|h3)>|$)/g, "") // and so is one closing it
    .replace(/\s*[\u2013-\u2015]\s*/g, ", ")
    .replace(/\s+-\s+/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/(\s*\|\s*[^|]+)\1+$/, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Units a spelled out number is read with ("two weeks", "fifty percent"), so it counts as a number too. */
const UNITS =
  "percent|per cent|mg|milligrams?|grams?|g|kg|kilos?|mcg|micrograms?|iu|ml|milliliters?|millilitres?|liters?|litres?|ounces?|oz|pounds?|lbs?|calories|kcal|hours?|minutes?|seconds?|days?|weeks?|months?|years?|times|servings?|capsules?|tablets?|pills?|softgels?|gummies|scoops?|cups?|glasses|doses?|drops?|teaspoons?|tablespoons?|inches|cm|miles|km|steps|dollars|people|customers|users";
const ONES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, dozen: 12, hundred: 100, thousand: 1000,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SPELLED = new RegExp(
  `\\b(?:(${Object.keys(TENS).join("|")})(?:[\\s-]+(${Object.keys(ONES).slice(0, 9).join("|")}))?|(${Object.keys(ONES).join("|")}))\\s+(${UNITS})\\b`,
  "gi"
);
/** Words after a number that say nothing about what it counts ("50 of them", "2 to 3"): the number stands alone. */
const NOT_A_UNIT = /^(?:of|and|or|to|the|a|an|in|on|at|for|with|by|is|are|was|were|from|per|than|out|more|less|over|under|about|it|its|this|that)$/;

/**
 * Each number in a text with what it counts: "50%" is "50 %", "50 capsules" is "50 capsule", "two weeks" is "2 week".
 * Thousands separators are dropped ("1,500" and "1500" match), decimal commas read as points, and a letter and number
 * name stays whole ("B12", "omega-3"). A number followed by nothing it counts is "50 " alone.
 */
export function quantitiesIn(text: string): string[] {
  const t = text
    .toLowerCase()
    .replace(SPELLED, (_m, tens?: string, ones?: string, one?: string, unit?: string) => `${tens ? TENS[tens] + (ones ? ONES[ones] : 0) : ONES[one!]} ${unit}`)
    .replace(/\bper cent\b|\bpercent\b/g, "%");
  const out: string[] = [];
  for (const m of t.matchAll(/(\$\s*)?(?:([\p{L}]+-?)(?=\d))?(\d+(?:[.,]\d+)*)(?:\s*(%)|\s*([\p{L}]+))?/gu)) {
    const n = m[3].replace(/,(?=\d{3}(?!\d))/g, "").replace(",", ".");
    if (m[2]) {
      out.push(`${m[2].replace(/-$/, "")}${n} `);
      continue;
    }
    const word = m[5] && !NOT_A_UNIT.test(m[5]) ? m[5].replace(/(?<=\p{L}{3})s$/u, "") : "";
    out.push(`${n} ${m[1] ? "$" : (m[4] ?? word)}`);
  }
  return out;
}

/** True when every number in `text` appears in `facts` with the same thing counted (a bare number anywhere in them). */
export function numbersKnown(text: string, facts: string): boolean {
  // Dose talk ("take 3 a day") never gets the small count allowance: an invented dose is advice.
  const dose = /\b(?:take|takes|taking|daily|a day|per day|times|twice|dose|doses|serving|servings)\b/i.test(plainText(text));
  const known = quantitiesIn(plainText(facts)).map(unitNormal);
  const pairs = new Set(known);
  const bare = new Set(known.map((q) => q.split(" ")[0]));
  return quantitiesIn(plainText(text))
    .map(unitNormal)
    .every((q) => {
      const [n, unit = ""] = q.split(" ");
      // A measurement (%, money, doses, time spans, weights) must match with its unit.
      if (MEASURE.has(unit)) return pairs.has(q);
      // A count or label ("Step 1", "3 ways", "2 capsules" vs "2 daily") needs only the number, and small counts are fine.
      return (!dose && Number(n) <= 10 && Number.isInteger(Number(n))) || bare.has(n);
    });
}

/** Unit spellings read the same: "500 milligrams" is "500 mg". */
const UNIT_ALIASES: Record<string, string> = {
  milligram: "mg", microgram: "mcg", gram: "g", kilogram: "kg", ounce: "oz", pound: "lb", lbs: "lb", millilit: "ml",
  milliliter: "ml", millilitre: "ml", liter: "l", litre: "l", calorie: "kcal", cal: "kcal", minute: "min", hr: "hour", yr: "year",
};
const MEASURE = new Set(["%", "$", "mg", "mcg", "g", "kg", "oz", "lb", "ml", "l", "kcal", "iu", "min", "hour", "day", "week", "month", "year", "time", "x",
  // Doses: an invented "take 2 capsules" is advice, so it must match the page.
  "capsule", "tablet", "pill", "serving", "scoop", "drop", "dose", "softgel", "gummy", "gummie"]);
function unitNormal(q: string): string {
  const [n, unit] = q.split(" ");
  if (!unit) return q;
  return `${n} ${UNIT_ALIASES[unit] ?? unit}`;
}

const BODY = /<(p|li)>([\s\S]*?)<\/\1>/g;
const BODY_AND_HEADINGS = /<(h2|h3|p|li)>([\s\S]*?)<\/\1>/g;

/**
 * Removes the paragraphs and list items `drop` picks, then any list or question left with nothing under it. With
 * `headings`, <h2> and <h3> are checked too, and a heading that is dropped takes its whole section with it.
 */
export function dropBlocks(html: string, drop: (text: string, index: number) => boolean, headings = false): string {
  let i = 0;
  // The level of the dropped heading whose section is being removed, 0 for none.
  let skipping = 0;
  return html
    .replace(new RegExp(headings ? BODY_AND_HEADINGS : BODY), (block, tag: string, inner: string) => {
      const level = tag[0] === "h" ? Number(tag[1]) : 0;
      if (level && skipping && level <= skipping) skipping = 0;
      const index = i++;
      if (skipping) return "";
      if (!drop(plainText(inner), index)) return block;
      if (level) skipping = level;
      return "";
    })
    .replace(/<(ul|ol)>\s*<\/\1>/g, "")
    .replace(/<h3>(?:(?!<\/h3>)[\s\S])*<\/h3>\s*(?=<h[23]>|$)/g, "")
    .trim();
}

/** The text of each paragraph and list item (with `headings`, each <h2> and <h3> too), numbered as dropBlocks counts them. */
export const blocksOf = (html: string, headings = false) => [...html.matchAll(new RegExp(headings ? BODY_AND_HEADINGS : BODY))].map((m) => plainText(m[2]));

/**
 * Drops paragraphs, list items and headings from a new section that state a number (a dose, a percentage, a study
 * figure) the page itself doesn't have with the same unit, so the writer can't add health facts the site hasn't published.
 */
export function onlyKnownNumbers(html: string, pageBody: string): string {
  return dropBlocks(html, (text) => !numbersKnown(text, pageBody), true);
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
  const blocks = blocksOf(html, true);
  if (!blocks.length) return html;
  const prompt = `You are fact checking a new section before it's added to a store's page.

Page text (the only source of truth):
"""
${plainText(pageBody).slice(0, 12000)}
"""

New section, numbered:
${blocks.map((b, i) => `[${i}] ${b}`).join("\n")}

List the numbers of blocks to remove (removing a heading removes its whole section). Remove a block if it:
- states a health effect, benefit, timeline, dose, usage advice, safety advice or combination advice (for example with coffee or medication) that the page text doesn't state
- claims what "many users", customers, studies or experts say or do, unless the page says it
- names ingredients, species or products the page doesn't mention
- is filler that says nothing (for example "below are answers to common questions")
Keep blocks that only restate or reorganize what the page says. When unsure, remove it.`;
  const out = await askJson<{ unsupported: number[] }>(ai, prompt, CHECK_SCHEMA);
  const remove = new Set((out.unsupported ?? []).map(Number));
  return dropBlocks(html, (_t, i) => remove.has(i), true);
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
  let reviewer: AiProvider;
  try {
    reviewer = reviewerOf(ai);
  } catch (e) {
    // The owner reads it before it goes live; the AI tell filter still runs.
    if (e instanceof OwnerChecks) return dropBlocks(html, (text) => hasAiTell(text), true);
    throw e;
  }
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
  const edited = cleanHtml(polish(out.sectionHtml ?? ""));
  // The edit is checked again like the draft was: if it added a number the page doesn't have, a claim or an
  // unsourced line, or emptied the section, the checked text from before the edit is kept instead.
  const blocks = blocksOf(edited, true);
  const failed =
    !blocksOf(edited).length ||
    blocksOf(onlyKnownNumbers(edited, pageBody), true).length !== blocks.length ||
    blocks.some((text) => isRisky(text) || isUnsourced(text));
  return dropBlocks(failed ? html : edited, (text) => hasAiTell(text), true);
}

const plainText = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

async function askClaude<T>(apiKey: string, system: string, prompt: string, schema: Record<string, unknown>, light = false): Promise<T> {
  const client = new Anthropic({ apiKey });
  const response = await client.beta.messages.create({
    model: light ? LIGHT_MODEL : MODEL,
    max_tokens: 16000,
    // Haiku has no server side fallback; a refusal there is reported like any other.
    ...(light ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
    output_config: { effort: light ? "low" : "medium", format: { type: "json_schema", schema } },
    // The writing rules are the same on every call for a site, so they're cached and billed at a tenth after the first.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
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
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "additionalProperties") continue;
    // A type that allows null (["string", "null"]) becomes Gemini's single type with nullable.
    if (k === "type" && Array.isArray(v)) {
      const real = v.filter((t) => t !== "null");
      out.type = String(real[0] ?? "string").toUpperCase();
      if (v.includes("null")) out.nullable = true;
      continue;
    }
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
    for (let attempt = 0; attempt < 3; attempt++) {
      // Overload usually clears in seconds: wait a little longer each time before trying again.
      if (attempt) await pause(attempt === 1 ? 3000 : 8000);
      const res = await fetch(`${GEMINI_API}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        signal: AbortSignal.timeout(180_000),
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        const text = (body.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
        if (!text) throw new Error("Gemini declined to write this change.");
        return JSON.parse(text) as T;
      }
      lastError = `${model}: ${body?.error?.message ?? res.status}`;
      if (!aiBusy(res.status)) throw new Error(`Gemini request failed: ${lastError}`);
      // Out of quota isn't a passing rush: waiting won't help, so try the next model at once.
      if (res.status === 429 && /quota|per day|RESOURCE_EXHAUSTED/i.test(lastError)) break;
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
// Models from more than one maker, so one maker's content filter (often strict on health topics) can't block them all.
const GITHUB_PREFERRED = ["openai/gpt-4.1", "meta/llama-3.3-70b-instruct", "openai/gpt-4.1-mini", "mistral-ai/mistral-medium-2505", "openai/gpt-4o-mini"];
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
  githubModels = ids.length ? GITHUB_PREFERRED.filter((n) => ids.includes(n)).slice(0, 4) : GITHUB_PREFERRED.slice(0, 4);
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

// ---------- Mistral (free Experiment plan) ----------

const MISTRAL_API = "https://api.mistral.ai/v1";
/** Preferred Mistral models, best first; only ones the key can use are tried. */
const MISTRAL_PREFERRED = ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"];
let mistralModels: { key: string; names: string[] } | null = null;

async function pickMistralModels(apiKey: string): Promise<string[]> {
  if (process.env.MISTRAL_MODEL) return [process.env.MISTRAL_MODEL];
  if (mistralModels?.key === apiKey) return mistralModels.names;
  const res = await fetch(`${MISTRAL_API}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Mistral didn't accept the key: ${body?.message ?? body?.detail ?? res.status}`);
  const ids = ((body.data ?? []) as { id: string }[]).map((m) => m.id);
  const names = MISTRAL_PREFERRED.filter((n) => ids.includes(n));
  const use = names.length ? names : MISTRAL_PREFERRED;
  mistralModels = { key: apiKey, names: use };
  return use;
}

const MISTRAL: ChatService = {
  name: "Mistral",
  url: `${MISTRAL_API}/chat/completions`,
  headers: (key) => ({ Authorization: `Bearer ${key}` }),
  models: pickMistralModels,
  options: () => ({ max_tokens: 8192 }),
};

// ---------- Cerebras (free plan) ----------

const CEREBRAS_API = "https://api.cerebras.ai/v1";
/** Preferred Cerebras models, best first; only ones the key can use are tried, else whatever it lists. */
const CEREBRAS_PREFERRED = ["gpt-oss-120b", "qwen-3-235b-a22b-instruct-2507", "llama-3.3-70b", "qwen-3-32b"];
let cerebrasModels: { key: string; names: string[] } | null = null;

async function pickCerebrasModels(apiKey: string): Promise<string[]> {
  if (cerebrasModels?.key === apiKey) return cerebrasModels.names;
  const res = await fetch(`${CEREBRAS_API}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Cerebras didn't accept the key: ${body?.message ?? body?.error?.message ?? res.status}`);
  const ids = ((body.data ?? []) as { id: string }[]).map((m) => m.id);
  const names = CEREBRAS_PREFERRED.filter((n) => ids.includes(n));
  const use = (names.length ? names : ids).slice(0, 3);
  if (!use.length) throw new Error("Cerebras lists no models for this key.");
  cerebrasModels = { key: apiKey, names: use };
  return use;
}

const CEREBRAS: ChatService = {
  name: "Cerebras",
  url: `${CEREBRAS_API}/chat/completions`,
  headers: (key) => ({ Authorization: `Bearer ${key}` }),
  models: pickCerebrasModels,
  options: (model) => ({ max_completion_tokens: 8192, ...(model.startsWith("gpt-oss") ? { reasoning_effort: "low" } : {}) }),
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
  const tried: string[] = [];
  // One service gets about a minute and a half in all: past that the next service is asked, so one slow or empty
  // service never holds up the hourly run.
  const started = Date.now();
  const spent = () => Date.now() - started > 75_000;
  for (const model of await svc.models(apiKey)) {
    if (lastError) tried.push(lastError);
    lastError = "";
    if (spent()) {
      lastError = `${model}: skipped, ${svc.name} took too long`;
      break;
    }
    modes: for (const jsonMode of [true, false]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (spent()) break modes;
        if (attempt) await pause(2000);
        const res = await fetch(svc.url, {
          method: "POST",
          signal: AbortSignal.timeout(90_000),
          headers: { ...svc.headers(apiKey), "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.3,
            ...svc.options(model),
            ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
          }),
        });
        // Read as text first, so an answer that isn't JSON is still seen in the error, never lost.
        const raw = await res.text().catch(() => "");
        let body: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          body = {};
        }
        // A 200 with a bare "OK" and no answer means the service isn't really serving this key: every model would
        // answer the same, so stop here instead of spending a minute on each.
        if (res.ok && !body.choices && /^\s*OK\s*$/i.test(raw)) throw new Error(`${svc.name} answered "OK" with no reply, so its key or its access to the models likely needs renewing.`);
        if (res.ok) {
          const text: string = body.choices?.[0]?.message?.content ?? "";
          const finish: string = body.choices?.[0]?.finish_reason ?? "";
          const out = extractJson(text);
          if (valid(out)) return out as T;
          // Enough detail to tell a refusal, a filter or a cut off answer apart the next time this happens.
          const refusal: string = body.choices?.[0]?.message?.refusal ?? "";
          const used = body.usage ? ` ${body.usage.prompt_tokens ?? "?"} in, ${body.usage.completion_tokens ?? "?"} out` : "";
          lastError = `${model}: ${text ? "the answer wasn't complete JSON" : "the answer was empty"} (${finish || (body.choices?.length ? "no reason" : `no choices, got ${Object.keys(body).slice(0, 5).join(" ") || (raw ? `"${raw.slice(0, 120).replace(/\s+/g, " ")}"` : `an empty reply, ${res.headers.get("content-type") ?? "no type"}`)}`)}${used}${refusal ? `, refused: ${refusal.slice(0, 80)}` : ""})`;
          // A content filter answers the same in plain mode: go straight to the next model.
          if (finish === "content_filter") break modes;
          break; // try plain mode, or the next model
        }
        lastError = `${model}: ${body?.error?.message ?? body?.message ?? res.status}`;
        if (res.status === 401 || res.status === 403) throw new Error(`${svc.name} didn't accept the key: ${lastError}`);
        if (res.status === 400 || res.status === 404 || res.status === 422) {
          // Rejected JSON (often fine apart from a stray character or a cut off end), or a model this key can't use.
          const salvaged = extractJson(String(body?.error?.failed_generation ?? ""));
          if (valid(salvaged)) return salvaged as T;
          // A filtered prompt is filtered again in plain mode: go straight to the next model.
          if (body?.error?.code === "content_filter" || /content.?filter/i.test(String(body?.error?.message ?? ""))) break modes;
          break;
        }
        if (!aiBusy(res.status)) throw new Error(`${svc.name} request failed: ${lastError}`);
      }
    }
  }
  if (lastError) tried.push(lastError);
  throw new Error(`${svc.name} couldn't write this change right now. (${tried.join("; ")})`);
}

function askOne<T>(ai: AiProvider, system: string, prompt: string, schema: Record<string, unknown>, light = false): Promise<T> {
  if (ai.kind === "groq") return askChat<T>(GROQ, ai.key, system, prompt, schema);
  if (ai.kind === "mistral") return askChat<T>(MISTRAL, ai.key, system, prompt, schema);
  if (ai.kind === "cerebras") return askChat<T>(CEREBRAS, ai.key, system, prompt, schema);
  if (ai.kind === "github") return askChat<T>(GITHUB, ai.key, system, prompt, schema);
  return ai.kind === "gemini" ? askGemini<T>(ai.key, system, prompt, schema) : askClaude<T>(ai.key, system, prompt, schema, light);
}

/**
 * How long a service rests after it said it can't take more: a daily free quota until it resets, a per minute limit
 * for two minutes, a broken service for an hour. Resting services are skipped, so the free quotas aren't burned on
 * calls that will fail, and the run moves straight to a service that can answer. Null: try again next time.
 */
export function restFor(error: string): number | null {
  const cap = (ms: number) => Math.min(24 * 3600_000, ms);
  // The service's own hint: "retry in 13h41m23.4s", "try again in 1m30s", "retry in 750ms", "wait 33000 seconds".
  const hint = /(?:retry|try again) in ((?:[\d.]+(?:h|ms|m|s)\s*)+)/i.exec(error);
  if (hint) {
    let ms = 0;
    for (const [, n, unit] of hint[1].matchAll(/([\d.]+)(h|ms|m|s)/g)) ms += Number(n) * { h: 3600_000, m: 60_000, s: 1000, ms: 1 }[unit as "h" | "m" | "s" | "ms"];
    return ms >= 1000 ? cap(ms) : null;
  }
  const wait = /wait (\d+) seconds/i.exec(error);
  if (wait) return cap(Number(wait[1]) * 1000);
  if (/answered "OK" with no reply/i.test(error)) return 3600_000;
  // A daily cap with no hint waits a while; any other limit only briefly.
  if (/per day|daily|PerDay|ByDay|\b(TPD|RPD)\b/.test(error)) return 6 * 3600_000;
  if (/rate limit|too many requests|\b429\b|quota|exhausted/i.test(error)) return 2 * 60_000;
  return null;
}

const REST_KEY = "ai_rest";
let resting: { at: number; until: Record<string, number> } | null = null;
async function restingUntil(): Promise<Record<string, number>> {
  if (resting && Date.now() - resting.at < 60_000) return resting.until;
  if (!hasDatabase()) return (resting = { at: Date.now(), until: resting?.until ?? {} }).until;
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${REST_KEY}`.catch(() => [] as { value: string | null }[]);
  let until: Record<string, number> = {};
  try {
    until = row?.value ? (JSON.parse(row.value) as Record<string, number>) : {};
  } catch {
    until = {};
  }
  resting = { at: Date.now(), until };
  return until;
}
export async function rest(kind: string, ms: number): Promise<void> {
  const entry = { [kind]: Date.now() + ms };
  resting = { at: resting?.at ?? 0, until: { ...(resting?.until ?? {}), ...entry } };
  if (!hasDatabase()) return;
  // Merged in the database, so two runs resting different services at once don't erase each other's entry.
  await sql`INSERT INTO insights_settings (key, value) VALUES (${REST_KEY}, ${JSON.stringify(entry)})
    ON CONFLICT (key) DO UPDATE SET value = (insights_settings.value::jsonb || EXCLUDED.value::jsonb)::text, updated_at = now()`.catch((e) =>
    console.error(`AI rest not saved: ${(e as Error).message}`),
  );
}

/** A key just saved and checked works again at once, whatever rest its service was on. */
export async function endRest(kinds: string[]): Promise<void> {
  if (!kinds.length) return;
  if (resting) for (const k of kinds) delete resting.until[k];
  if (!hasDatabase()) return;
  await sql`UPDATE insights_settings SET value = (value::jsonb - string_to_array(${kinds.join(",")}, ','))::text, updated_at = now() WHERE key = ${REST_KEY}`.catch((e) =>
    console.error(`AI rest not cleared: ${(e as Error).message}`),
  );
}

/** Asks the main AI, and each backup in turn if it fails. */
async function askJson<T>(ai: AiProvider, prompt: string, schema: Record<string, unknown>, light = false): Promise<T> {
  // Counted against the site being worked on; past its monthly limit this throws and the work waits.
  await spend("ai");
  const errors: string[] = [];
  const system = rulesFor(ai.site);
  const part = ai.role === "review" ? "ai-review" : "ai";
  const until = await restingUntil();
  for (const one of [ai, ...(ai.backups ?? [])]) {
    if ((until[one.kind] ?? 0) > Date.now()) {
      errors.push(`${one.kind} is resting until ${new Date(until[one.kind]).toISOString().slice(11, 16)} UTC after reaching its limit.`);
      continue;
    }
    try {
      const out = await askOne<T>(one, system, prompt, schema, light);
      // Remembered for this run's work, so the service that wrote is never picked to check it.
      if (ai.role !== "review") noteWriter(ai, one.kind);
      void report(part, true);
      return out;
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(msg);
      const ms = restFor(msg);
      if (ms) await rest(one.kind, ms);
    }
  }
  void report(part, false, errors.join(" "));
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
  allowContent: boolean,
  /** Index rescue: Google crawled the page and left it out, so a substantial new section is the point of the change. */
  rescue = false
): Promise<PageImprovement> {
  const editableBody = page.type === "article" || page.type === "page";
  // A search the daily rank check no longer finds is passed on with a stand in position and no impressions; neither is real.
  const unranked = target.mode === "defend" && target.position === UNRANKED_POSITION && target.impressions === 0;
  const goal = rescue
    ? `Google crawled this page and chose not to put it in its index. Make it more useful and distinct for people searching "${target.query}".`
    : target.mode === "defend"
      ? `This page held position ${target.previousPosition?.toFixed(1) ?? "near the top"} on Google for "${target.query}" and ${unranked ? "no longer ranks in the tracked range" : `has slipped to ${target.position.toFixed(1)} over the last 7 days`}. Refresh it so it wins the spot back and keeps it.`
      : target.mode === "top"
        ? `This page ranks around position ${target.position.toFixed(1)} on Google for "${target.query}". Improve it so it takes position 1.`
        : `Improve this page so it reaches the top 3 on Google for the search "${target.query}". It ranks around position ${target.position.toFixed(1)} now.`;
  const prompt = `${goal}
${unranked || rescue ? "" : `It had ${target.impressions} impressions in the last ${target.mode === "defend" ? 7 : 28} days.`}

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
  allowContent && editableBody && rescue
    ? `Google crawled this page and chose not to put it in its index, usually because it reads as thin or too close to other pages. Write contentSectionHtml: a substantial new section (about 300 to 600 words, with its own heading and short paragraphs) that adds genuinely useful, distinct information for people searching "${target.query}" that the page does not cover yet. Use only well established facts consistent with the page; no numbers, doses or claims the page doesn't already make. Make the first sentence under its heading a direct, plain answer. Do not repeat what is already there.`
    : allowContent && editableBody
    ? `If the page text does not already answer what people searching "${target.query}" want to know, write contentSectionHtml: a new section that fills that gap using only facts consistent with the page. Do not repeat what is already there. Make the first sentence under its heading a direct, plain answer that Google could quote on its own. Otherwise return an empty string.`
    : "Return an empty string for contentSectionHtml."
}

Keep the SEO title and description if they are already strong for this search; you may return them unchanged.`;

  const out = await askJson<PageImprovement>(ai, prompt, IMPROVEMENT_SCHEMA);
  let section = allowContent && editableBody ? onlyKnownNumbers(cleanHtml(polish(out.contentSectionHtml)), page.body) : "";
  // Nothing goes on the page unchecked: if the check itself fails, the section is left out.
  if (section) section = await factCheck(ai, section, page.body).catch(() => "");
  // A second AI edits it so it reads as a person wrote it; if that fails, blocks with AI tells are dropped.
  if (section) section = await humanEdit(ai, section, page.body).catch(() => dropBlocks(section, (text) => hasAiTell(text), true));
  // Claim guard: no paragraph or heading that reads as a disease claim or an unprovable promise.
  if (section) section = dropBlocks(section, (text) => isRisky(text) || isUnsourced(text) || hasAiTell(text), true);
  // A section reduced to headings alone isn't worth adding.
  if (!blocksOf(section).length) section = "";
  // A risky title or description, or one with a number the page doesn't state, is never written; the current one stays.
  const facts = `${page.title}\n${page.body}`;
  const sound = (text: string) => !isRisky(text) && !isUnsourced(text) && numbersKnown(text, facts);
  const safe = (text: string, current: string | null) => (sound(text) ? text : (current ?? ""));
  let metaTitle = safe(trimWords(polish(out.metaTitle), 70), page.metaTitle);
  let metaDescription = safe(trimWords(polish(out.metaDescription), 170), page.metaDescription);
  // A second AI checks every part that would change; it can reject a part or offer a stronger title or description.
  // If the check can't run, nothing changes (the run fails visibly and tries again).
  const titleChanged = Boolean(metaTitle) && metaTitle !== (page.metaTitle ?? "");
  const descChanged = Boolean(metaDescription) && metaDescription !== (page.metaDescription ?? "");
  let reviewNote = "";
  if (out.intentMatch !== false && (titleChanged || descChanged || section)) {
    const r = await orOwner(
      reviewImprovement(ai, page, target.query, briefs, {
        metaTitle: titleChanged ? metaTitle : "",
        metaDescription: descChanged ? metaDescription : "",
        contentSectionHtml: section,
      }),
      { keepTitle: true, keepDescription: true, keepSection: true, betterTitle: "", betterDescription: "" },
    );
    const better = (text: string, max: number) => (text && sound(text) && !hasAiTell(text) ? trimWords(polish(text), max) : "");
    const keepOr = (kept: boolean, mine: string, current: string | null) => (kept ? mine : (current ?? ""));
    metaTitle = better(r.betterTitle, 70) || (titleChanged ? keepOr(r.keepTitle, metaTitle, page.metaTitle) : metaTitle);
    metaDescription = better(r.betterDescription, 170) || (descChanged ? keepOr(r.keepDescription, metaDescription, page.metaDescription) : metaDescription);
    // Turned down: the part would have changed and the current one stays.
    const turnedDown = [
      titleChanged && metaTitle === (page.metaTitle ?? "") ? "SEO title" : "",
      descChanged && metaDescription === (page.metaDescription ?? "") ? "meta description" : "",
      section && !r.keepSection ? "new section" : "",
    ].filter(Boolean);
    if (turnedDown.length) reviewNote = `The reviewing AI turned down the ${turnedDown.join(", ")}, so ${turnedDown.length === 1 ? "it was" : "they were"} left out.`;
    if (!r.keepSection) section = "";
  }
  return {
    metaTitle,
    metaDescription,
    contentSectionHtml: section,
    altTexts: (out.altTexts ?? [])
      .filter((a) => page.imagesMissingAlt.some((i) => i.id === a.imageId) && a.alt.trim() && sound(a.alt))
      .map((a) => ({ imageId: a.imageId, alt: trimWords(polish(a.alt), 140) })),
    reason: out.reason.trim(),
    intentMatch: out.intentMatch !== false,
    missingForIntent: (out.missingForIntent ?? "").trim(),
    reviewNote,
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
  const html = cleanHtml(polish(out.sentenceHtml ?? ""), target.path);
  const text = plainText(html);
  if (!html || isRisky(text) || isUnsourced(text) || hasAiTell(text) || !numbersKnown(text, `${source.title}\n${source.body}\n${target.title}`)) return "";
  // A second AI checks the link fits; if it can't check, no link is added.
  return (await orOwner(reviewLink(ai, source, target, html), true).catch((e) => {
    console.error(`internal link not added, the reviewing AI couldn't check it: ${(e as Error).message}`);
    return false;
  }))
    ? html
    : "";
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
  if (ai.kind === "mistral") {
    mistralModels = null;
    await pickMistralModels(ai.key);
    return;
  }
  if (ai.kind === "cerebras") {
    cerebrasModels = null;
    await pickCerebrasModels(ai.key);
    return;
  }
  if (ai.kind === "github") {
    const res = await fetch(GITHUB.url, {
      method: "POST",
      headers: { ...githubHeaders(ai.key), "Content-Type": "application/json" },
      body: JSON.stringify({ model: (await pickGithubModels(ai.key))[0], messages: [{ role: "user", content: "Say ok." }], max_tokens: 2 }),
    });
    if (!res.ok) throw new Error(`GitHub Models didn't accept the token (${res.status}).`);
    // The same check askChat makes: a 200 with a bare "OK" and no answer isn't a working service.
    const raw = await res.text().catch(() => "");
    if (!/"choices"/.test(raw)) throw new Error(`GitHub Models answered without a reply (${raw.slice(0, 40).trim() || "empty"}), so the token likely needs renewing.`);
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
): Promise<NewArticle | { rejected: string } | null> {
  const prompt = `Write a new article for this website that can rank on Google page one for the search "${brief.keyword}".

What ranks on page one now (learn what searchers expect; never copy their wording):
${brief.competitors.map((c) => `- ${c.domain}: "${c.title}". Sections: ${c.headings.slice(0, 10).join(" / ") || "(none read)"}`).join("\n") || "(not available)"}

Questions people also ask: ${brief.questions.join(" | ") || "(none)"}
Related searches: ${brief.related.join(" | ") || "(none)"}
${brief.supporting?.length ? `Broader searches to mention naturally where they fit, to support the main one (never the focus): ${brief.supporting.join(" | ")}\n` : ""}
The site already has these articles, so don't repeat them: ${brief.ownTitles.slice(0, 40).join(" | ") || "(none)"}

Cover what searchers want better and more clearly than the pages above, in this site's own voice.
So Google can quote it as the answer: open with a short paragraph of two or three sentences that answers the search directly in plain words, before anything else. Where people ask questions (see above), use those questions as <h2> headings and answer each one in the first sentence under it.
Only use well established, general knowledge. Never attribute claims to unnamed sources: no "studies show", "research suggests", "many users notice", "experts say" or "anecdotal experience". Describe what is generally known plainly, and use cautious wording ("may support") for any benefit. Write no numbers at all: no doses, percentages, statistics, prices, years or counts (paragraphs with numbers are removed).
If this search isn't a fit for this website's business, return an empty string for html.`;

  const out = await askJson<NewArticle>(ai, prompt, ARTICLE_SCHEMA);
  let html = onlyKnownNumbers(cleanHtml(polish(out.html ?? "").replace(/<h1[\s\S]*?<\/h1>/gi, "")), "");
  if (!html) return null;
  // A second AI edits it so it reads as a person wrote it.
  html = await humanEdit(ai, html, "").catch(() => dropBlocks(html, (text) => hasAiTell(text), true));
  html = dropBlocks(html, (text) => isRisky(text) || hasAiTell(text) || isUnsourced(text), true);
  // Titles and summaries follow the article's rules: no claims, and no number the search itself doesn't have.
  const safe = (text: string) => (isRisky(text) || hasAiTell(text) || isUnsourced(text) || !numbersKnown(text, brief.keyword) ? "" : text);
  if (blocksOf(html).length < 8) return null;

  // A second AI checks it before it is published: it can stop it, drop weak blocks, or offer a stronger title.
  // If the check can't run, the article waits (the error is visible and the next run tries again).
  const r = await orOwner(
    reviewArticle(
      ai,
      brief.keyword,
      brief.competitors.map((c) => `${c.domain}: ${c.title}`),
      { title: out.title, metaTitle: out.metaTitle, metaDescription: out.metaDescription, html }
    ),
    { publish: true, reason: "", drop: [] as number[], betterTitle: "", betterMetaDescription: "" },
  );
  if (!r.publish) return { rejected: r.reason || "The reviewing AI didn't think it was good enough to publish." };
  const drop = new Set(r.drop);
  html = dropBlocks(html, (_t, i) => drop.has(i), true);
  // Too little left to stand as an article.
  if (blocksOf(html).length < 8 || plainText(html).split(/\s+/).length < 500) return null;
  if (r.betterTitle && safe(r.betterTitle)) out.metaTitle = r.betterTitle;
  if (r.betterMetaDescription && safe(r.betterMetaDescription)) out.metaDescription = r.betterMetaDescription;

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

/** A short, personal outreach email asking a site to link to this one. The owner sends it. */
/**
 * A misspelled brand ("Perimis" for "Peremis") is written as the brand. Careful by design: only capitalized words of
 * the same length, a letter off (two for long names), never at the start of a sentence (where real words are
 * capitalized), never inside a link or a domain, and never another site's name.
 */
export function fixBrand(text: string, brand: string | null | undefined, keep: string[] = []): string {
  const b = brand?.trim();
  if (!b || /\s/.test(b) || b.length < 5) return text;
  const most = b.length >= 8 ? 2 : 1;
  const others = new Set(keep.map((k) => k.toLowerCase()));
  const near = (w: string) => {
    if (w === b || w.length !== b.length || w[0] !== b[0] || others.has(w.toLowerCase())) return false;
    let diff = 0;
    for (let i = 0; i < w.length; i++) if (w[i].toLowerCase() !== b[i].toLowerCase()) diff++;
    return diff > 0 && diff <= most;
  };
  // Links and domains are left exactly as written.
  return text
    .split(/(https?:\/\/\S+|\b[\w-]+(?:\.[\w-]+)+\S*)/)
    .map((part, n) =>
      n % 2
        ? part
        : part.replace(/(^|[^A-Za-z])([A-Z][a-z]+)/g, (m, pre: string, w: string, at: number, all: string) => {
            const before = all.slice(0, at + pre.length).replace(/[ \t]+$/, "");
            const startsSentence = !before || /[.!?:\n]$/.test(before);
            const ownLine = /^\s*$/.test(all.slice(at + pre.length + w.length).split("\n")[0] ?? "");
            return near(w) && (!startsSentence || ownLine) ? `${pre}${b}` : m;
          }),
    )
    .join("");
}

/** A template gap like "[Name]" never reaches the owner: the greeting becomes "Hi there," and any other gap is dropped. */
export function noPlaceholders(text: string): string {
  return (
    text
      // A greeting to a placeholder becomes a plain friendly one.
      .replace(/^([ \t]*)(hi|hello|dear|hey)[ \t]*\[[^\]\n]{1,40}\][ \t]*,?/gim, (_m, sp: string) => `${sp}Hello,`)
      // A line or sentence with a template gap left in it is dropped rather than shown broken.
      .split("\n")
      .map((line) => (/\[[^\]\n]{1,40}\]/.test(line) ? line.split(/(?<=[.?!])\s+/).filter((x) => !/\[[^\]\n]{1,40}\]/.test(x)).join(" ") : line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export async function writeOutreach(
  ai: AiProvider,
  p: {
    kind: "mention" | "resource" | "guest" | "podcast" | "roundup" | "broken" | "competitor";
    siteName: string;
    pageTitle: string;
    pageUrl: string;
    ourSite: string;
    ourBrand: string | null;
    topic: string;
    ourPage: string | null;
    brokenLink?: string | null;
    anchor?: string | null;
    /** What the business offers, from its site profile, so the email fits it. */
    sells?: string | null;
  }
): Promise<{ subject: string; body: string }> {
  const ask =
    p.kind === "competitor"
      ? `Their page "${p.pageTitle}" covers ${p.topic}. Suggest ${p.ourPage ?? p.ourSite} as another helpful resource for their readers, in one sentence on what it covers. Never mention or criticize any other site.`
      : p.kind === "broken" && p.brokenLink
      ? `One link on their page no longer works: "${p.anchor ?? "a link"}" (${p.brokenLink}). Point it out helpfully as a small favor, first. Then suggest ${p.ourPage ?? p.ourSite} as a working replacement on the same subject, in one sentence on what it covers. No pressure.`
      : p.kind === "podcast"
        ? `They run a podcast on ${p.topic} that welcomes guests. Offer to be a guest: one specific episode idea on ${p.topic} and what their listeners would take away, from the angle of ${p.ourBrand ?? p.ourSite}. Keep claims modest.`
        : p.kind === "roundup"
          ? `They publish expert roundups on ${p.topic}. Offer a short, genuinely useful answer for a future roundup, naming the question you'd be glad to answer, and ask to be considered (with a link to ${p.ourSite} if they include it).`
          : p.kind === "mention"
      ? `Their page mentions ${p.ourBrand ?? p.ourSite}. Thank them, and ask kindly whether they would add a link to ${p.ourSite} where it is mentioned, so their readers can find it.`
      : p.kind === "resource"
        ? `Their page lists helpful links about ${p.topic}. Suggest ${p.ourPage ?? p.ourSite} as one more for their readers, saying in one sentence what it covers.`
        : `They accept guest articles. Offer one specific, useful article idea on ${p.topic} for their readers (give the working title). Offer it for their readers only, and don't mention links at all.`;
  // What the business offers is a known fact for the writer and for the second AI's check alike.
  const given = `${p.sells ? `What ${p.ourBrand ?? p.ourSite} offers: ${p.sells}. Keep the email about how that fits their page and readers; never invent products, services or offers beyond this.\n` : ""}${ask}`;
  const prompt = `Write an outreach email (under 160 words) from the owner of ${p.ourSite} to the person who runs ${p.siteName}.
Their page: "${p.pageTitle}" (${p.pageUrl}).
${given}
The owner's own style: build a relationship and trust first, ask for little. Warm, sincere, professional, never pushy, no flattery, no hype, no slang, no "I hope this email finds you well", no exclamation marks, no hyphens or dashes. Vary the wording so it never reads like a template. Short paragraphs, each separated by a blank line:
- A friendly greeting on its own line (like "Hi there," or "Hello,").
- One honest sentence about their page by name, based only on its title (don't invent what it says).
- Who you are, in one sentence, using only what is known about ${p.ourBrand ?? p.ourSite} above (if nothing is known, just the name and ${p.ourSite}).
- The reason for writing, exactly as the instructions above say, including their order (a dead link comes first, before anything else about you). When it offers a page, put its address on its own line.
- The ask from those instructions, gently.
- A closing thank you, that you would be glad to stay in touch, then a sign off such as "Best regards," with "The ${p.ourBrand ?? p.ourSite} team" and ${p.ourSite} on their own lines.
Never write a placeholder like [Name]. Spell the brand exactly ${p.ourBrand ?? p.ourSite}, and write product and ingredient names with normal capitals (for example Magnesium L Threonate).
Health topics: offer only general, well established knowledge. No numbers, doses, studies, statistics or health claims, and never invent credentials, titles, experience or results for the sender.
Return JSON with "subject" (under 8 words) and "body" (plain text with line breaks).`;
  const schema = {
    type: "object",
    properties: { subject: { type: "string" }, body: { type: "string" } },
    required: ["subject", "body"],
  };
  // Written, then checked like an article; when the checks remove too much, written once more, else the owner is told.
  const reasons: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    // The second try hears what the checking AI didn't like about the first.
    const feedback = reasons.length ? `\n\nA reviewer turned down the last version: ${reasons[reasons.length - 1]}. Fix exactly that.` : "";
    const out = await askJson<{ subject: string; body: string }>(ai, prompt + feedback, schema);
    const keep = [p.ourBrand, p.ourSite, p.siteName].filter((x): x is string => Boolean(x && x.trim()));
    const urls = [p.pageUrl, p.ourPage ?? "", p.brokenLink ?? "", `https://${p.ourSite}`, `https://${p.ourSite}/`];
    // The brand is spelled exactly as the owner set it, whatever the AI typed.
    const body = safeEmailText(fixBrand(noPlaceholders(out.body ?? ""), p.ourBrand, [p.siteName, p.pageTitle]), keep, urls);
    const subject = safeEmailText(fixBrand(noPlaceholders(out.subject ?? ""), p.ourBrand, [p.siteName, p.pageTitle]), keep, urls);
    if (!body.text || body.dropped > body.total / 3) {
      reasons.push(`the safety filter removed ${body.dropped} of ${body.total} sentences`);
      continue;
    }
    // A second AI checks it and may improve it; its version passes the same checks, else the first one stands.
    const r = await orOwner(reviewOutreach(ai, p, given, { subject: subject.text, body: body.text }), { ok: true, why: "", subject: "", body: "" });
    if (!r.ok) {
      reasons.push(`the checking AI turned it down${r.why ? `: ${r.why}` : ""}`);
      continue;
    }
    const rb = r.body ? safeEmailText(fixBrand(noPlaceholders(r.body), p.ourBrand, [p.siteName, p.pageTitle]), keep, urls) : null;
    const rs = r.subject ? safeEmailText(fixBrand(noPlaceholders(r.subject), p.ourBrand, [p.siteName, p.pageTitle]), keep, urls) : null;
    // The reviewer's version must still carry every link the first draft gave (the page to offer, the dead link).
    const links = [p.ourPage, p.brokenLink, p.pageUrl].filter((u): u is string => Boolean(u) && body.text.includes(u!));
    const keepsLinks = (t: string) => links.every((u) => t.includes(u));
    const useBody = rb && rb.text && rb.dropped === 0 && keepsLinks(rb.text) ? rb.text : body.text;
    const useSubject = rs && rs.text && rs.dropped === 0 ? rs.text : subject.text;
    return { subject: polish(useSubject) || "A quick note about your page", body: useBody };
  }
  throw new Error(`Couldn't write a safe email for this one (${reasons.join("; ") || "no reason given"}). Try again, or write a short note of your own.`);
}

/** Social posts and a short video script made from one published article. The owner posts them. */
export interface ShareKit {
  linkedin: string;
  facebook: string;
  instagram: string;
  x: string;
  video: { hook: string; script: string; caption: string };
}

/**
 * Turns one article into posts for each channel and a short video script, each pointing back to the article. Every
 * line goes through the same checks as an outreach email (no numbers, health claims, unsourced claims or AI tells),
 * and a second AI from another service checks the whole kit. When the checks remove too much, it is written once more.
 */
export async function writeShareKit(
  ai: AiProvider,
  p: { title: string; url: string; summary: string; text: string; brand: string | null; site: string }
): Promise<ShareKit> {
  const prompt = `Turn this article from ${p.brand ?? p.site} into social posts and a short video script that bring readers to it.
Article: "${p.title}" (${p.url})
Summary: ${p.summary}
Article text (start):
"""
${p.text.slice(0, 5000)}
"""
Write:
"linkedin": 60 to 120 words, practical and calm, ending with the link.
"facebook": 40 to 80 words, friendly, ending with the link.
"instagram": 40 to 80 words plus 3 to 5 relevant hashtags at the end; say "link in bio" instead of the link.
"x": under 240 characters including the link.
"video": a 30 to 45 second vertical video: "hook" (the first spoken line, under 12 words), "script" (what to say, short lines, about 90 words, ending with where to read more) and "caption" (under 25 words).
Use this exact link everywhere a link goes: ${p.url}
Use only what the article says. Sound like a real person: no hype, no clickbait, no exclamation marks, no emojis, no hyphens or dashes.
Use no digits or numbers anywhere, not even in the title or hashtags: write the idea in words.
Health topics: only general, well established knowledge from the article. No doses, studies, statistics, cures or promises.`;
  const schema = {
    type: "object",
    properties: {
      linkedin: { type: "string" },
      facebook: { type: "string" },
      instagram: { type: "string" },
      x: { type: "string" },
      video: {
        type: "object",
        properties: { hook: { type: "string" }, script: { type: "string" }, caption: { type: "string" } },
        required: ["hook", "script", "caption"],
      },
    },
    required: ["linkedin", "facebook", "instagram", "x", "video"],
  };
  const keep = [p.brand, p.site].filter((x): x is string => Boolean(x && x.trim()));
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await askJson<ShareKit>(ai, prompt, schema);
    const parts = {
      linkedin: out.linkedin,
      facebook: out.facebook,
      instagram: out.instagram,
      x: out.x,
      hook: out.video?.hook,
      script: out.video?.script,
      caption: out.video?.caption,
    };
    // A link written slightly differently (www, a trailing slash) is put back to the exact one before checking.
    const u = new URL(p.url);
    const variant = new RegExp(`https?://(www\\.)?${u.hostname.replace(/^www\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${u.pathname.replace(/\/$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?`, "g");
    const checked = Object.fromEntries(
      Object.entries(parts).map(([k, v]) => [k, safeEmailText(String(v ?? "").replace(variant, p.url), keep, [p.url])])
    ) as Record<
      keyof typeof parts,
      ReturnType<typeof safeEmailText>
    >;
    // Too much dropped anywhere means the piece no longer says what it should: write it again.
    if (Object.values(checked).some((c) => !c.text || c.dropped > c.total / 3)) continue;
    const kit: ShareKit = {
      linkedin: checked.linkedin.text,
      facebook: checked.facebook.text,
      instagram: checked.instagram.text,
      x: checked.x.text,
      video: { hook: checked.hook.text, script: checked.script.text, caption: checked.caption.text },
    };
    // Every post but Instagram must still send people to the article.
    for (const k of ["linkedin", "facebook", "x"] as const) if (!kit[k].includes(p.url)) kit[k] = `${kit[k]}\n${p.url}`;
    if (await orOwner(reviewShareKit(ai, p, kit), true)) return kit;
  }
  throw new Error("Couldn't write safe social posts for this article yet. The next run will try again.");
}

/** A second AI checks the kit: true to the article, nothing invented, nothing that would embarrass the owner. */
async function reviewShareKit(ai: AiProvider, p: { title: string; text: string }, kit: ShareKit): Promise<boolean> {
  const out = await askJson<{ ok: boolean }>(
    reviewerOf(ai),
    `You check social posts before a business owner publishes them. They promote the article "${p.title}".
Article text (start):
"""
${p.text.slice(0, 4000)}
"""
Posts and video script:
"""
${JSON.stringify(kit, null, 1)}
"""
ok: false if anything claims more than the article says, invents a fact, number or result, makes a health promise, reads as spam or clickbait, or would embarrass the owner. When unsure, false.`,
    { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }
  );
  return out.ok === true;
}

/**
 * The article checks for an email: a sentence with a number, a health claim, an unsourced claim or an AI tell is
 * dropped. Web addresses and the names in `keep` (the brand and site addresses, which may contain digits) are set aside
 * first, so they don't count as numbers or break sentences. Returns the text and how many sentences were dropped.
 */
export function safeEmailText(raw: string, keep: string[], allowedUrls: string[] = []): { text: string; dropped: number; total: number } {
  const saved: { text: string; url: boolean }[] = [];
  const hide = (url: boolean) => (m: string) => `\u0000${saved.push({ text: m, url }) - 1}\u0000`;
  let masked = raw
    .replace(/[\u2010-\u2015]/g, ",")
    .replace(/\s+-\s+/g, ", ")
    .replace(/https?:\/\/[^\s)]+/g, hide(true));
  // Only these exact names, as whole words: a brand like "Cure" must not hide that word inside a claim.
  for (const name of keep.sort((x, y) => y.length - x.length)) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    masked = masked.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "giu"), hide(false));
  }
  // A bare address ("healthtips.com") is set aside like a link, so one that wasn't given can be caught.
  masked = masked.replace(/(?<![\p{L}\p{N}@.\/-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?![\p{L}\p{N}-])/giu, hide(true));
  const allowed = new Set(allowedUrls.filter(Boolean).map((u) => u.replace(/[.,;:!?]+$/, "")));
  const hostOf = (u: string) => u.toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/^www\./, "");
  const allowedHosts = new Set([...allowed].map(hostOf));
  const bare = (t: string) => !/^https?:\/\//i.test(t);
  let dropped = 0;
  let total = 0;
  const text = masked
    .split(/\n/)
    .map((line) =>
      // A sentence ends at . ! or ? followed by a space (so "2.oz" or a domain doesn't split one).
      line
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => {
          if (!sentence.trim()) return true;
          total++;
          const marks = [...sentence.matchAll(/\u0000(\d+)\u0000/g)].map((m) => saved[Number(m[1])]);
          // For the number test everything set aside is removed; for the claim checks names come back and
          // web addresses read as "link" (a word in one of the site's own addresses must not block the email).
          const plain = sentence.replace(/\u0000\d+\u0000/g, "");
          const real = sentence.replace(/\u0000(\d+)\u0000/g, (_, i) => (saved[Number(i)]?.url ? "link" : (saved[Number(i)]?.text ?? "")));
          // Only the addresses given to the writer may appear: a made up one drops its sentence.
          const strayUrl = marks.some(
            (m) =>
              m?.url &&
              (bare(m.text) ? !allowedHosts.has(hostOf(m.text)) : allowed.size > 0 && !allowed.has(m.text.replace(/[.,;:!?]+$/, "")))
          );
          // A line made only of names (the sign off) is always kept, even for a brand like "Cure"; not a line of addresses.
          const onlyNames = marks.length > 0 && marks.every((m) => m && !m.url) && !/[\p{L}\p{N}]/u.test(plain);
          const ok = onlyNames || (!strayUrl && !/\d/.test(plain) && !isRisky(real) && !isUnsourced(real) && !hasAiTell(real));
          if (!ok) dropped++;
          return ok;
        })
        .join(" ")
        .trimEnd()
    )
    .join("\n")
    .replace(/\u0000(\d+)\u0000/g, (_, i) => saved[Number(i)]?.text ?? "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, dropped, total };
}

/* ---------- Strategist (strategist.ts): a weekly plan, and a second AI that challenges it ---------- */

export interface StrategyMove {
  /**
   * "target": aim at this search (Rank for this). "cluster": build articles around a topic. "fix": something to repair.
   * "hold": stop doing something. "asset": a resource other sites would want to link to. "rescue": a page Google left out,
   * for the Index rescue. "outreach": a backlink site for the Outreach Drafter to write to first.
   */
  kind: "target" | "cluster" | "fix" | "hold" | "asset" | "rescue" | "outreach";
  /** For "rescue": the page's address; for "outreach": the site's domain. Copied from the facts. */
  page?: string | null;
  /** The exact search, copied from the facts, for "target" and "cluster". */
  keyword: string | null;
  action: string;
  why: string;
  /** The exact fact the move rests on, copied from the facts; a move whose evidence isn't in the data is dropped. */
  evidence: string;
}

export interface StrategyPlan {
  assessment: string;
  moves: StrategyMove[];
}

const MOVE_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["target", "cluster", "fix", "hold", "asset", "rescue", "outreach"] },
    keyword: { type: ["string", "null"] },
    page: { type: ["string", "null"], description: "For rescue: the page address; for outreach: the site's domain; copied from the facts. Else null." },
    action: { type: "string" },
    why: { type: "string" },
    evidence: { type: "string", description: "The fact this move rests on, copied word for word from the facts." },
  },
  required: ["kind", "keyword", "action", "why", "evidence", "page"],
};

export async function planStrategy(ai: AiProvider, facts: string): Promise<StrategyPlan> {
  return askJson<StrategyPlan>(
    { ...ai, site: undefined },
    `You are the SEO strategist for this website. The goal: reach 20,000 visitors a month from Google search and turn them into revenue. Judge success by sales from Google as much as by visitors: prefer moves on pages and searches that sell. Other agents do the work every day (improving pages, writing articles, tracking ranks, finding backlinks); your job is to point them at what will move the numbers most, and to say plainly what isn't working.

Facts from this week (real data, nothing else is known):
${facts}

Think like a seasoned SEO: refreshing pages already at positions 4 to 20 is the fastest win, faster than new pages; Easy searches (difficulty under 35) come before Hard ones while the site is weak; topical depth (several articles around one subject, linked together) beats scattered single articles; anything that keeps failing should be stopped or fixed, not repeated; backlinks come easier to a page worth linking to, so you may suggest one "asset" move: a resource other sites would cite (a clear guide, checklist or comparison), built only from what the site can honestly say, never invented data or surveys.

You direct these agents, and each move goes to one of them: "target" (the autopilot aims at a search: rewrites the page for it, or writes a new article when none exists), "cluster" (articles around one topic, then a pillar page), "fix" (the autopilot reworks the page that already shows on Google for a search), "rescue" (the Index rescue adds a substantial section to a page Google left out; put the page address from the facts in "page"), "outreach" (the Outreach Drafter writes the email to this backlink site first; put its domain from the facts in "page"), "hold" (stop something), "asset" (an idea for the owner).

Return JSON: "assessment" (3 short plain sentences: where the site stands against the goal, the biggest opportunity, the biggest problem) and "moves" (at most 5, best first). Each move: kind, keyword (an exact search copied from the facts for target or cluster, else null), action (one sentence an agent can act on), why (one sentence citing the numbers), evidence (the fact the move rests on, copied word for word from the facts above: a move whose evidence isn't found in the facts is thrown out). Measured results of this site's own changes outrank any rule of thumb: do more of the kinds of change that moved up, and stop the kinds that moved down. Never invent searches, numbers or results. No hyphens or dashes in the text.`,
    { type: "object", properties: { assessment: { type: "string" }, moves: { type: "array", items: MOVE_SCHEMA } }, required: ["assessment", "moves"] }
  );
}

/** A second AI (another provider when there is one) challenges each move: kept only when the facts back it. */
export async function challengeStrategy(
  ai: AiProvider,
  facts: string,
  plan: { moves: { kind: string; keyword: string | null; action: string; why: string; evidence?: string }[] },
  role = "strategist's weekly plan"
): Promise<{ keep: boolean[]; notes: string[] }> {
  const out = await askJson<{ verdicts: { keep: boolean; note: string }[] }>(
    reviewerOf(ai, false),
    `You are a skeptical senior SEO reviewing another ${role} for a website aiming at 20,000 Google visitors a month. Judge only by the data: is each move backed by the facts (its evidence must say what the move claims), is it the best use of a week, could it hurt the site, is the search real and on topic? Keep a move only if you would bet on it.

Facts:
${facts}

Plan:
${plan.moves.map((m, i) => `${i + 1}. [${m.kind}] ${m.action} (${m.keyword ?? "no search"}${(m as { page?: string | null }).page ? `, ${(m as { page?: string | null }).page}` : ""}): ${m.why} Evidence: ${m.evidence ?? "(none)"}`).join("\n")}

Return JSON "verdicts": one per move, in order, each with "keep" (true or false) and "note" (one plain sentence: why it holds up, or what is wrong with it). No hyphens or dashes.`,
    {
      type: "object",
      properties: { verdicts: { type: "array", items: { type: "object", properties: { keep: { type: "boolean" }, note: { type: "string" } }, required: ["keep", "note"] } } },
      required: ["verdicts"],
    }
  );
  return { keep: plan.moves.map((_, i) => out.verdicts[i]?.keep ?? false), notes: plan.moves.map((_, i) => out.verdicts[i]?.note ?? "") };
}

/**
 * A second AI (another provider when there is one) decides whether an article that Google hasn't shown
 * should really be taken down. It keeps it whenever there's a good reason; only a clear "remove" counts.
 */
export async function reviewTakedown(
  ai: AiProvider,
  a: { title: string; url: string; text: string; into: string | null; siteSells: string }
): Promise<{ remove: boolean; why: string }> {
  const out = await askJson<{ remove: boolean; why: string }>(
    reviewerOf(ai, false),
    `You are a careful editor for a website that publishes ${a.siteSells}. Another agent wants to take this article down because Google has shown it to nobody in 90 days, even after it was rewritten.

Article: "${a.title}" (${a.url})
${a.into ? `Its visitors would be sent to: ${a.into}` : "There is no closely related article to send visitors to."}
Text (start):
"""
${a.text.slice(0, 3000)}
"""

Keep it (remove false) if there is any good reason: it's the only page on its topic, it's seasonal or timely, it serves readers or customers in ways search views don't show (support, how to use a product, policies, brand story), it's linked from important places, or it is genuinely useful and just needs time. Remove it (remove true) only if it is thin, outdated, a near duplicate of another page, or adds nothing for readers.
Return JSON: "remove" (true or false) and "why" (one plain sentence, no hyphens or dashes).`,
    { type: "object", properties: { remove: { type: "boolean" }, why: { type: "string" } }, required: ["remove", "why"] }
  );
  return { remove: out.remove === true, why: out.why ?? "" };
}

/* ---------- Authority Coach (authority-coach.ts): a weekly plan to raise the site's authority ---------- */

export interface AuthorityMove {
  /** "outreach": contact these sites. "asset": make a page others will want to link to. "fix": repair something. "stop": quit something that isn't working. */
  kind: "outreach" | "asset" | "fix" | "stop";
  /** A site, page or topic copied from the facts, when the move is about one. */
  keyword: string | null;
  action: string;
  why: string;
  /** The exact fact the move rests on, copied from the facts. */
  evidence: string;
}

export async function planAuthority(ai: AiProvider, facts: string): Promise<{ assessment: string; moves: AuthorityMove[] }> {
  return askJson<{ assessment: string; moves: AuthorityMove[] }>(
    { ...ai, site: undefined },
    `You are the link building lead for this website. Domain authority only rises when other real websites link to it, so your job is to get the site earned links, the honest way that works for successful sites: pages people want to cite, helpful outreach (broken link replacements, resource pages, podcasts, expert roundups, mentions without a link), and the sites that already link to competitors. Never paid links, link exchanges, private blog networks or anything that breaks Google's rules: a penalty would undo everything.

Facts from this week (real data from the other agents, nothing else is known):
${facts}

Return JSON: "assessment" (3 short plain sentences: where the site's authority stands, the best opportunity, the biggest gap) and "moves" (at most 5, best first). Each move: kind (outreach, asset, fix or stop), keyword (a site, page or topic copied from the facts, else null), action (one sentence the owner or an agent can act on this week), why (one sentence citing the numbers), evidence (the fact the move rests on, copied word for word from the facts above: a move whose evidence isn't found in the facts is thrown out). Never invent sites, numbers or results. No hyphens or dashes in the text.`,
    {
      type: "object",
      properties: {
        assessment: { type: "string" },
        moves: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["outreach", "asset", "fix", "stop"] },
              keyword: { type: ["string", "null"] },
              action: { type: "string" },
              why: { type: "string" },
              evidence: { type: "string" },
            },
            required: ["kind", "keyword", "action", "why", "evidence"],
          },
        },
      },
      required: ["assessment", "moves"],
    }
  );
}

/**
 * True when a move's evidence really is in the data: copied from the facts word for word (ignoring case, spacing and
 * punctuation, but keeping each number and its sign). No paraphrase passes, so a flipped number or "up" for "down" fails.
 */
export function backedByFacts(evidence: string | null | undefined, facts: string): boolean {
  const norm = (t: string) =>
    ` ${t
      .toLowerCase()
      .replace(/[^\p{L}\p{N}.+-]+/gu, " ")
      .replace(/(?<!\d)\.|\.(?!\d)/g, " ") // a dot only counts inside a number
      .replace(/[+-](?!\d)/g, " ") // a sign only counts in front of a number
      .replace(/\s+/g, " ")
      .trim()} `;
  const e = norm(evidence ?? "");
  // A real fact, not a fragment like "searches tracked": a number, or at least four words.
  if (e.trim().length < 8 || (!/\d/.test(e) && e.trim().split(" ").length < 4)) return false;
  return facts.split("\n").some((line) => norm(line).includes(e));
}

/* ---------- Second opinions: every agent's work is checked by another AI before it counts ---------- */

/**
 * With only one AI service, the owner is the second check: work that waits for the owner's approval before it goes
 * live (page changes, articles saved as drafts, emails and posts the owner sends) is written without the second AI,
 * and nothing of it reaches the site until the owner says yes. Everything else still needs a second AI.
 */
const ownerReview = new AsyncLocalStorage<boolean>();
class OwnerChecks extends Error {
  constructor() {
    super("The owner checks this before it goes live.");
  }
}
/**
 * The services that wrote with this provider chain. Copies of a provider ({ ...ai, site }) share its backups list, so
 * that list ties a run's writer and checker together; aiProvider makes a fresh one for each run or request.
 */
const wrote = new WeakMap<object, Set<string>>();
const chainOf = (ai: AiProvider): object => ai.backups ?? ai;
export function noteWriter(ai: AiProvider, kind: string) {
  const set = wrote.get(chainOf(ai)) ?? new Set<string>();
  set.add(kind);
  wrote.set(chainOf(ai), set);
}
const restingNow = (kind: string) => (resting?.until[kind] ?? 0) > Date.now();

/**
 * Who may check work from this chain: another service than the one that writes it. The writer is the first service not
 * resting (with Groq at its limit, Claude writes), and any service that already wrote in this chain is out too.
 */
export function checkersFor(ai: AiProvider): AiProvider[] {
  const chain = [ai, ...(ai.backups ?? [])];
  const writer = chain.find((o) => !restingNow(o.kind))?.kind ?? ai.kind;
  const done = wrote.get(chainOf(ai));
  return (ai.backups ?? []).filter((o) => o.kind !== ai.kind && o.kind !== writer && !done?.has(o.kind) && !restingNow(o.kind));
}
export const hasSecondAi = (ai: AiProvider | null | undefined): boolean => Boolean(ai && checkersFor(ai).length);
/**
 * Runs work whose result the owner approves before it goes live; with another service free to check it, that service
 * checks it as usual. Which services are resting is read fresh first, so a writer at its limit is known.
 */
export const ownerApproves = async <T>(ai: AiProvider | null | undefined, work: () => Promise<T>): Promise<T> => {
  if (ai) await restingUntil().catch(() => undefined);
  return hasSecondAi(ai) ? work() : ownerReview.run(true, work);
};
/** Reads which services are resting, so hasSecondAi is current (it is synchronous and reads what was last loaded). */
export const loadRests = (): Promise<unknown> => restingUntil().catch(() => undefined);
/** The second AI's verdict, or `pass` when the owner is the check. */
const orOwner = <T>(p: Promise<T>, pass: T): Promise<T> => p.catch((e) => (e instanceof OwnerChecks ? pass : Promise.reject(e)));

export const NO_SECOND_AI =
  "A second AI from another service has to check this work, and none is free: only one AI service is set up, or the other one wrote it while the first rests at its limit. With a key for both Claude and Groq in Platform keys it goes ahead on its own; until then, changes wait for your approval.";

/**
 * The reviewer: another AI service, with the other services as backups. The writer's own service never checks its
 * own work, so with no other service this throws and the work waits (the error is seen, never hidden).
 */
export function reviewerOf(ai: AiProvider, keepSite = true): AiProvider {
  // Never the service that wrote it (the first one not resting, or any that wrote in this chain).
  const others = checkersFor(ai);
  // Work the owner approves before anything goes live: the owner is the second check.
  if (!others.length && ownerReview.getStore()) throw new OwnerChecks();
  if (!others.length) {
    const single = !(ai.backups ?? []).some((o) => o.kind !== ai.kind);
    // On the status board, so the Inspector tells the platform owner that work is waiting for a second AI.
    void report(
      "ai-review",
      false,
      single
        ? "Only one AI service is set up. A second one, from another provider, is needed to check the work before anything changes on a site."
        : "The other AI service wrote this work while the first one rests at its limit, and a service never checks its own work. It waits for the next run, which asks the owner to approve."
    );
    throw new Error(NO_SECOND_AI);
  }
  // Marked working only when the checker really answers (askJson), so an outage is never hidden.
  return { ...others[0], site: keepSite ? ai.site : undefined, backups: others.slice(1), role: "review" };
}

/**
 * A second AI checks a page change before it is made: is each part right for the search, better than what is there,
 * and free of invented facts? It can offer a stronger title or description, which then pass the same guards.
 */
async function reviewImprovement(
  ai: AiProvider,
  page: StoreResource,
  query: string,
  /** The real data the writer had: Search Console, page one, search volumes, this site's measured results. */
  briefs: string[],
  change: { metaTitle: string; metaDescription: string; contentSectionHtml: string }
): Promise<{ keepTitle: boolean; keepDescription: boolean; keepSection: boolean; betterTitle: string; betterDescription: string }> {
  const prompt = `You are a senior SEO checking another writer's change to a page before it goes live. Your job is to stop mistakes and make it rank faster.

Search the page is aimed at: ${query}
Data (real numbers; judge by these, not by opinion):
${briefs.filter(Boolean).join("\n\n").slice(0, 6000) || "(none)"}

Address: ${page.url}
Current SEO title: ${page.metaTitle ?? "(not set)"}
Current meta description: ${page.metaDescription ?? "(not set)"}
Page text (the only source of facts):
"""
${plainText(page.body).slice(0, 8000)}
"""

Proposed SEO title: ${change.metaTitle || "(unchanged)"}
Proposed meta description: ${change.metaDescription || "(unchanged)"}
Proposed new section: ${change.contentSectionHtml ? `\n"""\n${change.contentSectionHtml}\n"""` : "(none)"}

For each proposed part, keep it only if the data supports it: it matches what people searching that want (Search Console and page one above), is at least as good as the current one, reads naturally (no keyword stuffing), and states nothing the page text doesn't support. When unsure, do not keep it.
If you can write a clearly stronger SEO title (under 60 characters) or meta description (under 155 characters) for this search, using only what the page supports, give it in betterTitle or betterDescription; otherwise return an empty string. No hyphens or dashes.`;
  const out = await askJson<{ keepTitle: boolean; keepDescription: boolean; keepSection: boolean; betterTitle: string; betterDescription: string }>(
    reviewerOf(ai),
    prompt,
    {
      type: "object",
      properties: {
        keepTitle: { type: "boolean" },
        keepDescription: { type: "boolean" },
        keepSection: { type: "boolean" },
        betterTitle: { type: "string" },
        betterDescription: { type: "string" },
      },
      required: ["keepTitle", "keepDescription", "keepSection", "betterTitle", "betterDescription"],
    }
  );
  return {
    keepTitle: out.keepTitle === true,
    keepDescription: out.keepDescription === true,
    keepSection: out.keepSection === true,
    betterTitle: (out.betterTitle ?? "").trim(),
    betterDescription: (out.betterDescription ?? "").trim(),
  };
}

/** A second AI checks a new article before it is published: right for the search and the site, nothing invented, nothing missing. */
async function reviewArticle(
  ai: AiProvider,
  keyword: string,
  pageOne: string[],
  article: { title: string; metaTitle: string; metaDescription: string; html: string }
): Promise<{ publish: boolean; reason: string; drop: number[]; betterTitle: string; betterMetaDescription: string }> {
  const blocks = blocksOf(article.html, true);
  const prompt = `You are a senior SEO editor checking another writer's new article before it is published on this website. Your job is to stop mistakes and help it reach Google page one for "${keyword}".

What ranks on page one now: ${pageOne.join(" | ") || "(not available)"}

Title: ${article.title}
SEO title: ${article.metaTitle}
Meta description: ${article.metaDescription}
Article, numbered by block:
${blocks.map((b, i) => `[${i}] ${b}`).join("\n")}

1. publish: true only if the article fits this website, answers what people searching "${keyword}" want at least as well as page one, and opens with a direct answer. Give the reason in one plain sentence.
2. drop: the numbers of blocks to remove (removing a heading removes its whole section) because they state something that is not well established general knowledge, give health, dose or safety advice, are off topic, or are filler.
3. betterTitle and betterMetaDescription: a clearly stronger title (under 60 characters) or description (under 155 characters) for this search, or an empty string. No hyphens or dashes.`;
  const out = await askJson<{ publish: boolean; reason: string; drop: number[]; betterTitle: string; betterMetaDescription: string }>(
    reviewerOf(ai),
    prompt,
    {
      type: "object",
      properties: {
        publish: { type: "boolean" },
        reason: { type: "string" },
        drop: { type: "array", items: { type: "integer" } },
        betterTitle: { type: "string" },
        betterMetaDescription: { type: "string" },
      },
      required: ["publish", "reason", "drop", "betterTitle", "betterMetaDescription"],
    }
  );
  return {
    publish: out.publish === true,
    reason: (out.reason ?? "").trim(),
    drop: (out.drop ?? []).map(Number).filter(Number.isInteger),
    betterTitle: (out.betterTitle ?? "").trim(),
    betterMetaDescription: (out.betterMetaDescription ?? "").trim(),
  };
}

/** A second AI checks an internal link: does it fit the article and help its readers? */
async function reviewLink(ai: AiProvider, source: { title: string; body: string }, target: { query: string; title: string }, html: string): Promise<boolean> {
  const out = await askJson<{ keep: boolean }>(
    reviewerOf(ai),
    `Another writer wants to add this closing paragraph to the article "${source.title}", linking to the page "${target.title}" (about "${target.query}"):
"""
${html}
"""
Article text (start):
"""
${plainText(source.body).slice(0, 3000)}
"""
Keep it only if the link is on the same subject, helps this article's readers, and reads naturally. When unsure, do not keep it.`,
    { type: "object", properties: { keep: { type: "boolean" } }, required: ["keep"] }
  );
  return out.keep === true;
}

/** A second AI checks an outreach email before the owner sees it: honest, personal, nothing invented, likely to get a reply. */
async function reviewOutreach(
  ai: AiProvider,
  p: { siteName: string; pageTitle: string; ourSite: string },
  /** What the writer was told about them: the facts the email may state. */
  given: string,
  email: { subject: string; body: string }
): Promise<{ ok: boolean; subject: string; body: string; why: string }> {
  const out = await askJson<{ ok: boolean; subject: string; body: string; why?: string }>(
    reviewerOf(ai),
    `You check outreach emails before a website owner sends them. This one is from the owner of ${p.ourSite} to the person who runs ${p.siteName}, about their page "${p.pageTitle}".
What is known about them and the reason for writing (these facts are true and may be stated): ${given}
Subject: ${email.subject}
Body:
"""
${email.body}
"""
ok: false if it claims anything beyond the known facts above (credentials, results, numbers), sounds like a template or spam, pushes too hard, or would embarrass the owner.
If you can make it more likely to get a kind reply without adding any new facts, return the improved subject and body; otherwise return them unchanged. Keep its shape: the greeting, short paragraphs with blank lines, the thank you and the sign off. Under 160 words, plain text, no hyphens or dashes, no exclamation marks. Also return "why": one plain sentence on what is wrong when ok is false (empty when ok).`,
    {
      type: "object",
      properties: { ok: { type: "boolean" }, subject: { type: "string" }, body: { type: "string" }, why: { type: "string" } },
      required: ["ok", "subject", "body", "why"],
    }
  );
  return { ok: out.ok === true, subject: (out.subject ?? "").trim(), body: (out.body ?? "").trim(), why: String(out.why ?? "").trim() };
}

/**
 * A second AI checks backlink sites before they reach the owner's list: real, relevant sites in this niche that could
 * link honestly. Link farms, paid link or "sponsored post" sellers, spam directories and off topic sites are dropped.
 */
export async function reviewProspects(
  ai: AiProvider,
  ourSite: string,
  prospects: { domain: string; title: string; snippet: string; kind: string; topic: string }[]
): Promise<{ keep: boolean[] }> {
  if (!prospects.length) return { keep: [] };
  let reviewer: AiProvider;
  try {
    reviewer = reviewerOf(ai);
  } catch (e) {
    if (e instanceof OwnerChecks) return { keep: prospects.map(() => true) };
    throw e;
  }
  const out = await askJson<{ keep: number[] }>(
    reviewer,
    `Another agent found these sites as backlink prospects for ${ourSite}. Check each one before the owner spends time on it.
${prospects.map((p, i) => `[${i}] ${p.domain} (${p.kind}, topic "${p.topic}"): "${p.title}". ${p.snippet.slice(0, 200)}`).join("\n")}

Return in "keep" the numbers of the sites worth contacting: a real site or publication related to ${ourSite}'s topics that could link to it honestly. Leave out link farms, sites selling paid or sponsored links, spam directories, scraped or auto generated pages, and sites on unrelated subjects. When unsure, leave it out.`,
    {
      type: "object",
      properties: { keep: { type: "array", items: { type: "integer" } } },
      required: ["keep"],
    }, true
  );
  const keep = new Set((out.keep ?? []).map(Number));
  return { keep: prospects.map((_, i) => keep.has(i)) };
}

/* ---------- Business profile: what the site says about itself, checked by a second AI ---------- */

const ABOUT_SCHEMA = {
  type: "object",
  properties: {
    audience: { type: "string" },
    offer: { type: "string" },
    difference: { type: "string" },
    tone: { type: "string" },
    location: { type: "string" },
  },
  required: ["audience", "offer", "difference", "tone", "location"],
};

/**
 * Reads the business from its own pages: who it serves, what it offers, what makes it different, how it talks and
 * where. Only what the pages say: a field the pages don't state stays empty. A second AI then checks each field
 * against the same text and every field it can't find there is dropped.
 */
/**
 * Which kinds of site this is, from its own pages only: up to four ids from
 * the given list, best first. A second AI checks the best pick against the
 * text; a pick it can't confirm is dropped, so a guess is never offered first.
 */
export async function readSiteTypes(
  ai: AiProvider,
  pagesText: string,
  options: readonly { id: string; label: string; group: string }[],
): Promise<{ types: string[]; rejected: string | null }> {
  const ids = options.map((o) => o.id);
  const list = options.map((o) => `${o.id}: ${o.label} (${o.group})`).join("\n");
  const out = await askJson<{ types: string[] }>(
    { ...ai, site: undefined },
    `Here is the text of a website's own pages (home page, about page).

"""
${pagesText.slice(0, 12000)}
"""

Which of these kinds of site is it? Judge only from what the text shows the site offers and to whom. Never guess.

${list}

Return JSON "types": up to four ids from the list, the best fit first, only ones the text clearly supports. Use "other_business" only when nothing else fits. An empty list is fine when the text doesn't make it clear.`,
    { type: "object", properties: { types: { type: "array", items: { type: "string", enum: ids } } }, required: ["types"] }, true,
  );
  const picked = (out.types ?? []).filter((t, i, a) => ids.includes(t) && a.indexOf(t) === i).slice(0, 4);
  if (!picked.length) return { types: [], rejected: null };
  const best = options.find((o) => o.id === picked[0])!;
  // The owner picks from these in setup, so with one AI service the owner is the second check.
  const check = await orOwner((async () => askJson<{ supported: boolean }>(
    reviewerOf(ai, false),
    `Website text:

"""
${pagesText.slice(0, 12000)}
"""

Statement: this website is a "${best.label}" site (${best.group}).
Return JSON "supported": true only if the text clearly shows this, false if it is a guess or the text points elsewhere.`,
    { type: "object", properties: { supported: { type: "boolean" } }, required: ["supported"] }, true,
  ))(), { supported: true });
  return check.supported === true ? { types: picked, rejected: null } : { types: picked.slice(1), rejected: picked[0] };
}

/**
 * The App checker's customer view review. A second AI reads what one site's owner sees, as a demanding first time
 * customer and a tester, and lists what looks broken, empty without a reason, contradictory or confusing. The first AI
 * then checks each point against the same data and drops anything the data doesn't show, so nothing guessed counts.
 */
/** What the customer view check must not report as broken: these numbers measure different things on purpose. */
const VIEW_FACTS = [
  "report.visitors is the Strategist's estimate of Google visitors a month at its last plan; report.totals.visits is every channel's visits this week from Google Analytics. They measure different things and differ.",
  "report.totals.revenue is revenue Google Analytics tracked, which is 0 when the store doesn't send sales to Google Analytics; report.shopify is the store's own orders. Shopify sales with Analytics revenue at 0 is that setup, not a broken total.",
  "Backlink outreach emails are sent by the owner, never by the app, so 0 emailed with sites found is normal. report.backlinks.fromLinks is visits from sites already linking, not the list of sites found.",
  "Moves the Strategist or the Authority Coach drop after their critic's check were rightly dropped as unsupported.",
].map((f) => `- ${f}`).join("\n");

export async function reviewCustomerView(ai: AiProvider, view: string, usualSections: string[]): Promise<{ text: string; fix: string }[]> {
  const schema = {
    type: "object",
    properties: { issues: { type: "array", items: { type: "object", properties: { text: { type: "string" }, fix: { type: "string" }, evidence: { type: "string" } }, required: ["text", "fix", "evidence"] } } },
    required: ["issues"],
  };
  const reviewer = reviewerOf(ai, false);
  const found = await askJson<{ issues: { text: string; fix: string; evidence: string }[] }>(
    reviewer,
    `You test a website growth app (DashPatrol) by looking at one customer's account exactly as the customer sees it. Look past any one feature: anything a paying customer would find broken, empty without a reason, contradictory, confusing, out of date or not worth paying for counts.

What this customer sees (JSON, their own data only):
${view}

Sections that other sites on the app usually have filled by this age: ${usualSections.join(", ") || "(unknown)"}

How the app is meant to work (never a problem by itself):
${VIEW_FACTS}

List each real problem: text (one short plain sentence a person understands), fix (what should change in the app or which agent should act), evidence (the exact field and value in the JSON that shows it). Fields named in "shortenedByChecker" were cut by the checker to fit, not by the app: never report them. Only problems the JSON proves; a site that is simply new or small is not a problem when the page says so. Leave out anything already listed in ruleFindings. At most 5. No hyphens or dashes. Return an empty list when nothing is wrong.`,
    schema
  );
  const issues = (found.issues ?? []).filter((i) => i.text && i.evidence).slice(0, 5);
  if (!issues.length) return [];
  // The first AI confirms each point against the data before it counts; never the reviewer's own provider, so the check stays independent.
  const checked = await askJson<{ keep: boolean[] }>(
    { ...ai, site: undefined, backups: (ai.backups ?? []).filter((b) => b.kind !== reviewer.kind) },
    `Another AI reviewed a customer's view of an app and reported the problems below. For each, answer true only if the JSON clearly shows it is real, false if it is guessed, wrong, only the app working as described below, about a field named in "shortenedByChecker" (cut by the checker, not the app), or just a new or small site that the page already explains.

How the app is meant to work:
${VIEW_FACTS}

JSON:
${view}

Problems:
${issues.map((i, n) => `${n + 1}. ${i.text} (evidence: ${i.evidence})`).join("\n")}

Return keep: one true or false per problem, in order.`,
    { type: "object", properties: { keep: { type: "array", items: { type: "boolean" } } }, required: ["keep"] }
  );
  return issues.filter((_, n) => checked.keep?.[n] === true).map((i) => ({ text: polish(i.text), fix: polish(i.fix) }));
}

export async function readBusiness(ai: AiProvider, pagesText: string): Promise<Record<string, string>> {
  const out = await askJson<Record<string, string>>(
    { ...ai, site: undefined },
    `Here is the text of a website's own pages (home page, about page).

"""
${pagesText.slice(0, 12000)}
"""

Describe the business only from what this text says. Return JSON with:
"audience": who its customers or readers are (one sentence),
"offer": what it sells or offers (one or two sentences),
"difference": what makes it different from others, in its own claims (one sentence),
"tone": how its writing sounds (a few words, like "warm and plain" or "clinical and precise"),
"location": where it serves (a city, a country, or "online"), only if stated.
Leave a field as an empty string when the text doesn't say it. Never guess or invent. No hyphens or dashes.`,
    ABOUT_SCHEMA, true,
  );
  const fields = Object.fromEntries(Object.keys(ABOUT_SCHEMA.properties).map((k) => [k, polish(String(out[k] ?? "").trim())])) as Record<string, string>;
  const filled = Object.entries(fields).filter(([k, v]) => v && k !== "tone");
  if (!filled.length) return fields;
  // The owner sees and edits the profile in Settings, so with one AI service the owner is the second check.
  const check = await orOwner((async () => askJson<{ supported: boolean[] }>(
    reviewerOf(ai, false),
    `Check each statement against the website text below. A statement is supported only if the text says it (the same meaning, not a guess).

"""
${pagesText.slice(0, 12000)}
"""

Statements:
${filled.map(([k, v], i) => `${i + 1}. (${k}) ${v}`).join("\n")}

Return JSON "supported": one true or false per statement, in order.`,
    { type: "object", properties: { supported: { type: "array", items: { type: "boolean" } } }, required: ["supported"] }, true,
  ))(), { supported: filled.map(() => true) });
  filled.forEach(([k], i) => {
    if (check.supported?.[i] !== true) fields[k] = "";
  });
  // No claim survives the guards: health claims and unsourced promises are dropped even if the site makes them.
  for (const k of Object.keys(fields)) if (isRisky(fields[k]) || isUnsourced(fields[k])) fields[k] = "";
  return fields;
}
