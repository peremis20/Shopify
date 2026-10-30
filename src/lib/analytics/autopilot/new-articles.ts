import { ensureSchema, sql } from "../db";
import { readProfile } from "../profile";
import { analyzeCompetition } from "./serp";
import type { AiProvider, PlatformSettings } from "./settings";
import { createArticle, setArticlePublished, setSeoField } from "./shopify";
import type { SiteAccess } from "./site-source";
import { readTargets, saveTarget } from "./targets";
import { readWp, wpCreatePost, wpSetPublished } from "./wordpress";
import { writeNewArticle, type NewArticle } from "./writer";

/**
 * New articles for searches no page on the site covers yet (picked with
 * "Rank for this"). At most the owner's weekly number (3 by default, spread
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
  const due = (await readTargets(accountId))
    .filter((t) => !t.page && !t.article && t.winnable !== false)
    .sort((a, b) => Number(b.winnable ?? false) - Number(a.winnable ?? false) || b.monthlySearches - a.monthlySearches);
  const target = due[0];
  if (!target) return null;
  // One try a day even if the writer gives up, so a hard search doesn't use up every run.
  await markWritten(accountId);

  const comp = await analyzeCompetition(opts.platform.serperKey, accountId, target.keyword, opts.ourDomain);
  const own = await site.articles().catch(() => []);
  const article = await writeNewArticle(opts.ai, {
    keyword: target.keyword,
    competitors: comp.competitors.map((c) => ({ domain: c.domain, title: c.title, headings: c.headings })),
    questions: comp.serp.questions,
    related: comp.serp.related,
    ownTitles: own.map((a) => a.title),
  });
  if (!article) {
    await saveTarget(accountId, { ...target, article: { url: null, live: false, note: "The writer couldn't make a good enough article for this search." } });
    return null;
  }

  const profile = await readProfile(accountId);
  const origin = `https://${profile.siteDomain ?? opts.ourDomain}`;
  const author = profile.brandName ?? (await site.name().catch(() => "")) ?? "";
  let posted: PostedArticle;

  if (site.mode === "shopify" && site.store) {
    const made = await createArticle(site.store, {
      title: article.title,
      html: article.html,
      handle: article.slug,
      summary: article.summary,
      author: author || "Editorial team",
      publish: opts.publish,
    });
    await setSeoField(site.store, made.id, "title_tag", article.metaTitle);
    if (article.metaDescription) await setSeoField(site.store, made.id, "description_tag", article.metaDescription);
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
        }).catch(() => null) // plugin older than 1.2: fix list instead
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
  return posted;
}

/** Takes a new article down (undo): back to draft where the app posted it. */
export async function unpublishArticle(accountId: string, site: SiteAccess | null, resourceId: string): Promise<void> {
  if (site?.mode === "shopify" && site.store) return setArticlePublished(site.store, resourceId, false);
  const wp = await readWp(accountId).catch(() => null);
  if (wp) return wpSetPublished(wp, resourceId, false);
  throw new Error("Reconnect your website first.");
}
