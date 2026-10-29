/**
 * Claim guard for health and wellness sites. Finds wording the FTC and FDA
 * treat as risky for supplements and wellness products: disease claims
 * (cures, treats, prevents a disease), "FDA approved", "clinically proven",
 * guaranteed results, telling people to replace medication, and specific
 * weight loss promises. Rule based, so it runs on every change the autopilot
 * writes and on the whole store once a week, without AI costs.
 *
 * This flags wording for a person to review. It is not legal advice.
 */

export type ClaimLevel = "high" | "medium";

export interface ClaimFlag {
  level: ClaimLevel;
  /** The words that triggered the flag. */
  phrase: string;
  /** The sentence around it. */
  excerpt: string;
  why: string;
  fix: string;
}

const DISEASES = [
  "cancers?", "tumou?rs?", "diabetes", "diabetic", "alzheimer'?s", "dementia", "parkinson'?s", "arthritis", "osteoporosis",
  "depression", "anxiety disorders?", "panic disorders?", "adhd", "autism", "insomnia", "hypertension", "high blood pressure",
  "heart disease", "heart attacks?", "strokes?", "covid(?:-19)?", "the flu", "influenza", "colds?", "infections?", "viruses",
  "bacterial", "diseases?", "disorders?", "illness(?:es)?", "obesity", "fatty liver", "cirrhosis", "hepatitis", "ibs",
  "crohn'?s", "colitis", "ulcers?", "asthma", "macular degeneration", "cataracts?", "glaucoma", "neuropathy", "migraines?",
  "high cholesterol", "candida", "lupus", "psoriasis", "eczema", "acne", "gout", "fibromyalgia", "kidney stones?",
].join("|");

const CURE_VERBS = "cures?|curing|treats?|treating|prevents?|preventing|heals?|healing|reverses?|reversing|eliminates?|eliminating|fights?|fighting|kills?|killing|stops?|remed(?:y|ies)";
/** The disease after the verb, for the "remedy for a disease" rule. */
const CURE_NOUNS = "cure|remedy|relief|fighter|killer";

/**
 * Sentences that talk about claims rather than make them: warnings ("do not
 * use in place of medical care"), myth busting ("anyone promising a cure is
 * overselling"), or advice to see a doctor. Claims in these are skipped.
 */
const NOT_A_CLAIM = /\b(?:not|no|never|nor|cannot|can't|won't|doesn't|don't|isn't|aren't|without|claims?|allowed|promis\w*|overselling|overstated|myth|replacement for|in place of|instead of medical|alongside|talk to|consult|ask your|doctor|provider|physician|expecting)\b/i;

interface Rule {
  re: RegExp;
  level: ClaimLevel;
  why: string;
  fix: string;
  /** Skip in sentences that warn, debunk or refer to a doctor instead of claiming. */
  negatable?: boolean;
}

const RULES: Rule[] = [
  {
    re: new RegExp(`\\b(?:${CURE_VERBS})\\b(?:[^\\w.!?]+\\w+){0,5}?[^\\w.!?]+(?:${DISEASES})\\b`, "gi"),
    level: "high",
    why: "Says the product cures, treats or prevents a disease. Only drugs may make disease claims; for supplements this is the claim the FDA and FTC act on most.",
    fix: 'Describe a normal body function instead, for example "supports healthy blood sugar levels already within the normal range", and keep the FDA disclaimer on the page.',
    negatable: true,
  },
  {
    re: new RegExp(`\\b(?:${DISEASES})[^\\w.!?]+(?:\\w+[^\\w.!?]+){0,2}?(?:${CURE_NOUNS})\\b`, "gi"),
    level: "high",
    why: "Presents the product as a remedy for a disease.",
    fix: "Talk about the everyday wellness benefit the product supports, not the disease.",
    negatable: true,
  },
  {
    re: /\b(?:fda[- ]approved|approved by the fda|fda[- ]certified|fda[- ]cleared)\b(?!\s+(?:label|drugs?|medications?|prescriptions?|for\b))/gi,
    level: "high",
    why: 'The FDA does not approve dietary supplements, so "FDA approved" is false for them.',
    fix: 'Use what is true, for example "made in an FDA registered facility" or "made in a GMP certified facility", if that applies.',
  },
  {
    re: /\b(?:replaces?|instead of|substitute for|stop taking|no need for|alternative to)\s+(?:your\s+)?(?:medications?|medicines?|prescriptions?|drugs?|insulin|statins?|antidepressants?)\b/gi,
    level: "high",
    why: "Suggests replacing or stopping medication, which can harm people and is a drug claim.",
    fix: 'Remove it. If anything, say "talk to your doctor before starting any supplement, especially if you take medication".',
    negatable: true,
  },
  {
    re: /\b(?:no side effects|zero side effects|100% safe|completely safe|totally safe|risk[- ]free for everyone|safe for everyone)\b/gi,
    level: "high",
    why: "An absolute safety promise nobody can back up.",
    fix: 'Say what is true, for example "made with ingredients most adults tolerate well; check with your doctor if you are pregnant, nursing or take medication".',
  },
  {
    re: /\b(?:miracle\s+(?:pills?|cures?|supplements?|formulas?|products?|ingredients?|herbs?|results?)|magic pills?|wonder drugs?|cure[- ]alls?)\b/gi,
    level: "high",
    why: "Hype words the FTC treats as a sign of deceptive health marketing.",
    fix: "Drop the word and describe what the product actually contains and supports.",
    negatable: true,
  },
  {
    re: /\b(?:guaranteed to|guaranteed results|results guaranteed|works for everyone|100% effective)\b/gi,
    level: "high",
    why: "Promises a health result. A money back guarantee is fine; a guaranteed result is not.",
    fix: 'Keep the money back guarantee and drop the result promise, for example "90 day money back guarantee".',
  },
  {
    re: /\b(?:lose|drop|melt|shed)\s+(?:up to\s+)?\d+\s*(?:pounds|lbs?|kilos?|kg|inches)\b/gi,
    level: "high",
    why: "A specific weight loss figure needs strong proof that typical customers get it. The FTC brings cases over these regularly.",
    fix: 'Use general wording, for example "supports your weight management goals alongside diet and exercise".',
  },
  {
    re: /\b(?:clinically proven|scientifically proven|medically proven|proven to|clinically shown to|doctors? recommended|recommended by doctors|doctor approved)\b/gi,
    level: "medium",
    why: "Needs competent and reliable studies on this exact product or dose. Without them the FTC treats it as deceptive.",
    fix: 'Only keep it if you have the study on this formula. Otherwise say "made with ingredients that have been studied for..." and link the research.',
    negatable: true,
  },
  {
    re: /\b(?:lowers?|lowering|reduces?|reducing|regulates?|normalizes?|balances?)\s+(?:your\s+)?(?:blood sugar|blood glucose|cholesterol|blood pressure|a1c|inflammation)\b/gi,
    level: "medium",
    why: "Changing blood sugar, cholesterol, blood pressure or inflammation reads as treating a condition.",
    fix: 'Use structure and function wording, for example "supports healthy cholesterol levels already within the normal range".',
    negatable: true,
  },
  {
    re: /\b(?:burns?|melts?|blasts?)\s+(?:belly\s+|body\s+|stubborn\s+)?fat\b|\bfat burner\b/gi,
    level: "medium",
    why: "Fat burning claims need strong proof and draw FTC attention.",
    fix: 'Say "supports metabolism as part of a healthy diet and exercise".',
    negatable: true,
  },
  {
    re: /\b(?:flushes?|removes?|draws? out|eliminates?|purges?)\s+(?:all\s+)?(?:the\s+)?(?:toxins|heavy metals|parasites)\b/gi,
    level: "medium",
    why: "Detox claims that promise to remove toxins, metals or parasites are rarely provable.",
    fix: 'Describe the ingredient and the normal function it supports, for example "supports your liver\'s natural detox processes".',
    negatable: true,
  },
];

/** The FDA disclaimer itself mentions "treat, cure, or prevent any disease"; it must not be flagged. */
const DISCLAIMER = /these statements have not been evaluated by the food and drug administration[^.]*\.?(?:\s*this product is not intended to diagnose, treat, cure,? or prevent any disease\.?)?|not intended to diagnose, treat, cure,? or prevent any disease\.?/gi;

export const hasDisclaimer = (text: string) => /not been evaluated by the food and drug administration/i.test(text);

const plain = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** The one sentence holding a position (headings run into sentences in plain text, so it is capped). */
function sentenceOf(text: string, at: number): string {
  const from = Math.max(...[". ", "? ", "! "].map((d) => text.lastIndexOf(d, at)), -2) + 2;
  const ends = [". ", "? ", "! "].map((d) => text.indexOf(d, at)).filter((i) => i !== -1);
  return text.slice(Math.max(from, at - 200), Math.min(ends.length ? Math.min(...ends) : text.length, at + 200));
}

function sentenceAround(text: string, start: number, end: number): string {
  const from = Math.max(text.lastIndexOf(". ", start) + 2, start - 160, 0);
  const stop = text.indexOf(". ", end);
  const to = Math.min(stop === -1 ? text.length : stop + 1, end + 160);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).trim()}${to < text.length ? "…" : ""}`;
}

/** Risky claims in some HTML or text, most serious first, one flag per phrase. */
export function scanClaims(htmlOrText: string): ClaimFlag[] {
  const text = plain(htmlOrText).replace(DISCLAIMER, " ");
  const flags: ClaimFlag[] = [];
  const seen = new Set<string>();
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const start = m.index ?? 0;
      const excerpt = sentenceAround(text, start, start + m[0].length);
      if (rule.negatable && NOT_A_CLAIM.test(sentenceOf(text, start))) continue;
      const phrase = m[0].trim();
      const key = phrase.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      flags.push({ level: rule.level, phrase, excerpt, why: rule.why, fix: rule.fix });
    }
  }
  return flags.sort((a, b) => (a.level === b.level ? 0 : a.level === "high" ? -1 : 1));
}

/** True when the text has any claim the autopilot must never publish. */
export const isRisky = (htmlOrText: string) => scanClaims(htmlOrText).length > 0;
