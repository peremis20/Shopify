/**
 * Guardrail for keyword ideas. Keyword Planner returns plenty of searches no
 * health or wellness site should aim at: stuttered phrases ("health health
 * insurance", "symptoms of of stroke"), local searches a website can't win
 * ("doctor near me"), and off topic ones that only share a word with a page
 * ("life church" next to an article about a life change). Everything the
 * autopilot picks, tracks or suggests goes through this first. The owner's
 * own choices (Rank for this, saved keywords) are never filtered.
 */

/** Local and "find a place" searches: won by map listings and directories, not articles. */
const LOCAL =
  /\b(near me|nearby|near by|close to me|around me|open now|open today|hours|phone number|address|directions|locations?|in my area)\b/;

/** Navigational and account searches: people looking for a login, an app or a company's own site. */
const NAVIGATIONAL = /\b(login|log in|sign in|sign up|app download|customer service|contact number|\.com|\.org|\.net|www)\b/;

/** Topics a health and wellness site has nothing to offer on. */
const OFF_TOPIC =
  /\b(casino|lottery|betting|porn|xxx|onlyfans|lyrics|movie|movies|netflix|episode|cast|game|games|minecraft|roblox|fortnite|weather|jobs?|careers?|hiring|salary|salaries|resume|for sale|craigslist|zillow|apartments?|rent|car insurance|auto insurance|home insurance|life insurance|mortgage|loan|loans|stock|stocks|crypto|bitcoin|tattoo|horoscope|zodiac)\b/;

/** Religious searches: off topic, except on a faith and health publication. */
const FAITH = /\b(church|churches|bible|pastor|sermon|mosque|temple|sabbath|prayer|faith|christian|god)\b/;

/** The same word twice in a row, or a word repeated anywhere in a short search ("health insurance health insurance"). */
function stutters(words: string[]): boolean {
  if (words.some((w, i) => i > 0 && w === words[i - 1])) return true;
  const content = words.filter((w) => w.length > 3);
  return new Set(content).size < content.length;
}

/** Why a keyword idea should be dropped, or null when it's fine. */
export function junkReason(keyword: string, opts: { faith?: boolean } = {}): string | null {
  const k = keyword.trim().toLowerCase().replace(/\s+/g, " ");
  const words = k.split(" ");
  if (!k || k.length < 4) return "too short";
  if (words.length > 8) return "too long";
  if (stutters(words)) return "repeated words";
  if (/[^a-z0-9\s'&+-]/.test(k)) return "odd characters";
  if (LOCAL.test(k)) return "local search";
  if (NAVIGATIONAL.test(k)) return "looking for a site or login";
  if (OFF_TOPIC.test(k)) return "off topic";
  if (!opts.faith && FAITH.test(k)) return "off topic (faith)";
  // A place of worship or a congregation is a local search even for a faith publication.
  if (opts.faith && /\b(church|churches|mosque|temple)\b/.test(k) && !/\b(health|healing|wellness|fast|fasting|diet|food)\b/.test(k)) return "looking for a place";
  return null;
}

export const isJunkKeyword = (keyword: string, opts: { faith?: boolean } = {}) => junkReason(keyword, opts) !== null;
