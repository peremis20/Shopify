import { easeRank } from "./difficulty";
import { ensureSchema, sql } from "../db";
import { readProfile } from "../profile";
import { analyzeCompetition } from "./serp";
import type { AiProvider, PlatformSettings } from "./settings";
import { createArticle, setArticlePublished, setSeoField } from "./shopify";
import type { SiteAccess } from "./site-source";
import { readTargets, saveTarget, supportingTargets } from "./targets";
import { readWp, wpCreatePost, wpSetPublished } from "./wordpress";
import { writeNewArticle, type NewArticle } from "./writer";

/**
 * New articles for searches no page on the site covers yet (picked with
 * "Rank for this"). At most the owner's weekly number (1 by default, spread
 * at least a day apart), since a burst of new pages on a health site looks
 * like mass produced content to Google. The article is planned from
 * Google page one, written and checked like every other change, then:
 * - Shopify: posted to the store's blog
 * - WordPress (Insights Connector 1.2+): posted as a new post
 * - any other site: put on the fix list, ready to paste in
 * It's published right away when the owner allows new content, otherwise
 * saved as a draft. Once it's live the search points at it, so the autopilot
 * keeps improving it and links to it from the site's other articles.
 */

const LAST = (accountId: string) => `newarticle_last:${accountId}`;
const DAY = 86_400_000;

export interface PostedArticle {
  keyword: string;
  article: NewArticle;
  /** Where it lives; null when it's on the fix list. */
  url: string | null;
  resourceType: "article" | "site";
  resourceId: string;
  live: boolean;
  note: string;
  /** Something that went wrong after the article was made (it still exists and is recorded), said plainly for the run summary. */
  problem?: string;
}

/** True when an article was tried in the last day, or the week's number is reached. */
async function notDue(accountId: string, perWeek: number): Promise<boolean> {
  await ensureSchema();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${LAST(accountId)}`;
  if (row?.value && Date.now() - Number(row.value) < DAY) return true;
  const [{ n }] = await sql`
    SELECT count(*) AS n FROM insights_autopilot_changes
    WHERE account_id = ${accountId} AND field = 'new_article' AND status IN ('applied', 'kept', 'suggested') AND created_at > now() - interval '7 days'`;
  return Number(n) >= perWeek;
}

async function markWritten(accountId: string): Promise<void> {
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${LAST(accountId)}, ${String(Date.now())})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** The topic an article belongs to: its cluster from the site's own keyword data, else its own search. */
export const topicOf = (t: { cluster?: string; keyword: string }) => (t.cluster ?? t.keyword).trim().toLowerCase();

const TURNS = (accountId: string) => `newarticle_turns:${accountId}`;
async function readTurns(accountId: string): Promise<Record<string, number>> {
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = ${TURNS(accountId)}`;
  try {
    return row?.value ? (JSON.parse(row.value) as Record<string, number>) : {};
  } catch {
    return {};
  }
}
async function saveTurn(accountId: string, turns: Record<string, number>, topic: string): Promise<void> {
  const next = { ...turns, [topic]: Date.now() };
  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${TURNS(accountId)}, ${JSON.stringify(next)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/**
 * The next article, taking topics in turn: the topic last written longest ago (never written first), and within it
 * the best search in the order given. Generic: topics come from each site's own keyword clusters.
 */
export function pickByTurn<T extends { cluster?: string; keyword: string }>(due: T[], turns: Record<string, number>): T | undefined {
  let best: T | undefined;
  let bestAt = Infinity;
  for (const t of due) {
    const at = turns[topicOf(t)] ?? 0;
    if (at < bestAt) {
      best = t;
      bestAt = at;
    }
  }
  return best;
}

/** Trusted health sources: government, universities, and major medical centers and journals.
 * Every business type today is health or wellness; if a non health type is added, gate this list on the profile's type. */
const TRUSTED =
  /(^|\.)(nih\.gov|cdc\.gov|fda\.gov|medlineplus\.gov|[a-z0-9-]+\.gov|[a-z0-9-]+\.edu|who\.int|mayoclinic\.org|clevelandclinic\.org|hopkinsmedicine\.org|health\.harvard\.edu|nhs\.uk|bmj\.com|thelancet\.com|jamanetwork\.com|nejm\.org|examine\.com)$/i;

/** Shopify's standard newsletter signup (the same form themes use), placed at the end of a new article. */
function signupBlock(brand: string): string {
  const name = brand.replace(/[<>&"]/g, "");
  return `
<div class="dashpatrol-signup" style="margin-top:2em;padding:1.25em;border:1px solid #e5e0d8;border-radius:12px">
<h2>Get new guides from ${name} by email</h2>
<p>New articles like this one, now and then. No spam, and you can unsubscribe anytime.</p>
<form method="post" action="/contact#contact_form" accept-charset="UTF-8">
<input type="hidden" name="form_type" value="customer">
<input type="hidden" name="utf8" value="✓">
<input type="hidden" name="contact[tags]" value="newsletter,blog">
<input type="email" name="contact[email]" placeholder="Your email" required aria-label="Your email" style="padding:.6em;min-width:220px">
<button type="submit" style="padding:.6em 1.2em">Subscribe</button>
</form>
</div>`;
}

/** Writes and posts the next new article, if one is due. Returns null when there's nothing to do today. */
export async function nextNewArticle(opts: {
  accountId: string;
  site: SiteAccess;
  ai: AiProvider;
  platform: PlatformSettings;
  ourDomain: string;
  publish: boolean;
  perWeek: number;
}): Promise<PostedArticle | null> {
  const { accountId, site } = opts;
  if (!opts.platform.serperKey || (await notDue(accountId, opts.perWeek))) return null;
  // Searches the owner chose that no page covers, the ones with room on page one first.
  const all = await readTargets(accountId);
  // Topic clusters: a cluster's articles come first once one is started, and its pillar only when all of them are live.
  const members = (c: string) => all.filter((t) => t.cluster === c && !t.pillar);
  const started = (c: string | undefined) => Boolean(c) && members(c!).some((t) => t.article?.live || t.page);
  // The pillar waits until every member has been written (live, draft or on the fix list), so it can't stall forever.
  const ready = (t: (typeof all)[number]) => !t.pillar || (members(t.cluster ?? "").length > 0 && members(t.cluster ?? "").every((m) => m.article || m.page));
  const due = all
    // A pillar is written even when its broad search is crowded: its job is to tie the cluster together.
    .filter((t) => !t.page && !t.article && (t.winnable !== false || t.pillar) && (t.role !== "support" || t.pillar) && ready(t))
    .sort(
      (a, b) =>
        Number(started(b.cluster)) - Number(started(a.cluster)) ||
        Number(b.winnable ?? false) - Number(a.winnable ?? false) ||
        easeRank(a.difficulty) - easeRank(b.difficulty) ||
        b.monthlySearches - a.monthlySearches
    );
  // Each of the site's topics gets its turn: the topic written longest ago (or never) goes next.
  const turns = await readTurns(accountId);
  const target = pickByTurn(due, turns);
  if (!target) return null;
  // One try a day even if the writer gives up, so a hard search doesn't use up every run.
  await markWritten(accountId);
  await saveTurn(accountId, turns, topicOf(target)).catch((e) => console.error(`article topic turn not saved: ${(e as Error).message}`));

  const comp = await analyzeCompetition(opts.platform.serperKey, accountId, target.keyword, opts.ourDomain);
  const own = await site.articles().catch(() => []);
  const written = await writeNewArticle(opts.ai, {
    keyword: target.keyword,
    competitors: comp.competitors.map((c) => ({ domain: c.domain, title: c.title, headings: c.headings })),
    questions: comp.serp.questions,
    related: comp.serp.related,
    ownTitles: own.map((a) => a.title),
    supporting: supportingTargets(all, target.keyword),
  });
  if (written && "rejected" in written) {
    await saveTarget(accountId, { ...target, article: { url: null, live: false, note: `Held back by the reviewing AI: ${written.rejected}` } });
    return null;
  }
  const article = written;
  if (!article) {
    await saveTarget(accountId, { ...target, article: { url: null, live: false, note: "The writer couldn't make a good enough article for this search." } });
    return null;
  }
  // Further reading: trusted sources (government, university, medical) that really rank on Google page one for this search (real, checkable links).
  // Not called "Sources": the writer didn't read them, so they aren't where the article's facts came from.
  const seenDomains = new Set<string>();
  const sources = comp.serp.organic
    .filter((r) => TRUSTED.test(r.domain) && r.title && !seenDomains.has(r.domain) && Boolean(seenDomains.add(r.domain)))
    .slice(0, 4);
  if (sources.length) {
    const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    article.html += `\n<h2>Learn more from trusted sources</h2>\n<ul>${sources.map((r) => `<li><a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.title)}</a> (${esc(r.domain)})</li>`).join("")}</ul>`;
  }
  // A pillar page links to every article in its cluster, so readers and Google see the whole topic.
  if (target.pillar && target.cluster) {
    // Only members that are live on the site: a link to a draft would be broken for readers and Google.
    const links = members(target.cluster)
      .map((m) => ({ url: m.page ?? (m.article?.live ? m.article.url : null), label: m.keyword.replace(/^./, (c) => c.toUpperCase()) }))
      .filter((l): l is { url: string; label: string } => Boolean(l.url));
    if (links.length) {
      const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      article.html += `\n<h2>More guides on ${esc(target.cluster)}</h2>\n<ul>${links.map((l) => `<li><a href="${esc(l.url)}">${esc(l.label)}</a></li>`).join("")}</ul>`;
    }
  }

  const profile = await readProfile(accountId);
  const origin = `https://${profile.siteDomain ?? opts.ourDomain}`;
  const author = profile.brandName ?? (await site.name().catch(() => "")) ?? "";
  let posted: PostedArticle;

  if (site.mode === "shopify" && site.store) {
    // Google visitors may not come back on their own: invite them to the store's newsletter
    // (Shopify's own customer signup, so subscribers land in the store's customer list).
    article.html += signupBlock(author || "us");
    const made = await createArticle(site.store, {
      title: article.title,
      html: article.html,
      handle: article.slug,
      summary: article.summary,
      author: author || "Editorial team",
      publish: opts.publish,
    });
    // The SEO title and description are set after the article is recorded (below), so a failure there
    // never leaves a live article the app doesn't know about (and writes again tomorrow).
    posted = { keyword: target.keyword, article, url: `${origin}${made.path}`, resourceType: "article", resourceId: made.id, live: opts.publish, note: "" };
  } else {
    const wp = site.mode === "wordpress" ? await readWp(accountId).catch(() => null) : null;
    const made = wp
      ? await wpCreatePost(wp, {
          title: article.title,
          html: article.html,
          slug: article.slug,
          summary: article.summary,
          seoTitle: article.metaTitle,
          seoDescription: article.metaDescription,
          publish: opts.publish,
        }).catch((e) => {
          // Only a plugin older than 1.2 (no create route) goes to the fix list; any other error is reported.
          if (/no route was found/i.test((e as Error).message)) return null;
          throw e;
        })
      : null;
    posted = made
      ? { keyword: target.keyword, article, url: made.url, resourceType: "article", resourceId: made.id, live: opts.publish, note: "" }
      : {
          keyword: target.keyword,
          article,
          url: null,
          resourceType: "site",
          resourceId: `new:${article.slug}`,
          live: false,
          note: wp
            ? "Update the Insights Connector plugin to 1.2 and new articles are posted for you. Until then, paste this one in as a new post."
            : "Add this as a new blog post on your site, with the SEO title and description shown.",
        };
  }

  await saveTarget(accountId, {
    ...target,
    // Live: the autopilot now works on this page for the search.
    page: posted.live ? posted.url : null,
    article: { url: posted.url, live: posted.live, note: posted.live ? "Published" : posted.url ? "Saved as a draft" : "On the fix list" },
  });
  if (site.mode === "shopify" && site.store && posted.resourceType === "article") {
    try {
      await setSeoField(site.store, posted.resourceId, "title_tag", article.metaTitle);
      if (article.metaDescription) await setSeoField(site.store, posted.resourceId, "description_tag", article.metaDescription);
    } catch (e) {
      posted.problem = `The article is on the store, but its SEO title and description couldn't be saved (${(e as Error).message}). Add them in Shopify.`;
      posted.note = posted.problem;
    }
  }
  return posted;
}

/** Takes a new article down (undo): back to draft where the app posted it. */
export async function unpublishArticle(accountId: string, site: SiteAccess | null, resourceId: string): Promise<void> {
  if (site?.mode === "shopify" && site.store) return setArticlePublished(site.store, resourceId, false);
  const wp = await readWp(accountId).catch(() => null);
  if (wp) return wpSetPublished(wp, resourceId, false);
  throw new Error("Reconnect your website first.");
}
