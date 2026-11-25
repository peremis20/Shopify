import { readProspects } from "./backlinks";
import { clientListKnown, otherClient } from "./clients";
import type { Connection } from "../connection";
import { ensureSchema, sql } from "../db";
import { readAccountAutopilot, readPlatformSettings } from "./settings";
import { readStatus, type Part } from "./status";
import { trackRanks } from "./tracking";
import { isSabbath } from "./sabbath";
import { hasScope } from "../google-auth";
import { siteWatchProblems } from "./site-watch";
import { rankingTurbulence } from "./google-updates";
import { trafficCheck } from "./guards";
import { usageThisMonth } from "./usage";
import { readAudit } from "./site-audit";
import { appCheck } from "./app-check";

/** An AI account with no money left: retrying never helps, so the owner is told exactly where to add credit. */
const OUT_OF_CREDIT = /credit balance|purchase credits|insufficient[_ ](credit|funds|balance)|payment required|(^|status |\()402\b/i;
const outOfCredit = (d: string) => {
  // Errors from several AI services are joined, so the provider is read only from the words around the credit error.
  const at = d.search(OUT_OF_CREDIT);
  const near = d.slice(Math.max(0, at - 200), at + 200);
  return /anthropic|claude/i.test(near) && !/groq/i.test(near)
    ? "The Claude account is out of credit. Add credit at console.anthropic.com under Plans and Billing; it starts working again within the hour by itself."
    : /groq/i.test(near) && !/anthropic|claude/i.test(near)
      ? "The Groq account is out of credit. Add credit at console.groq.com; it starts working again within the hour by itself."
      : "An AI account is out of credit. Add credit with that AI provider (Claude or Groq); it starts working again within the hour by itself.";
};

/**
 * The Inspector: the agent that checks on the others. Every hour it looks for
 * anything broken, stuck or quietly failing, repairs what an agent can repair
 * on its own (it tells that agent to run again, or the others to work around
 * a broken service), and reports in plain words what only a person can fix.
 */

export interface Problem {
  id: string;
  /** What's wrong, in plain words. */
  text: string;
  /** What to do, or what the agents already did about it. */
  fix: string;
  /** "owner": needs a person. "repaired": an agent fixed it. "watching": agents are working around it. */
  who: "owner" | "repaired" | "watching";
  /** Platform keys and services: only the platform owner can act on these. */
  platform?: boolean;
}

const HOUR = 3_600_000;

export const PART_FIX: Record<Part, { name: string; fix: (detail: string) => string; workaround: string }> = {
  openpagerank: {
    name: "Open PageRank (site strength)",
    fix: (d) =>
      /keywordseverywhere|DomCop|moved/i.test(d)
        ? "The saved key is an old one. Create a free key at openpagerank.keywordseverywhere.com and paste it in Platform keys."
        : "Check the Open PageRank key in Platform keys.",
    workaround: "Until then, difficulty scores judge page 1 by the list of big publishers instead.",
  },
  "keywords-everywhere": {
    name: "Keywords Everywhere (rival searches and links)",
    fix: (d) =>
      /credit limit/i.test(d)
        ? "This month's Keywords Everywhere credit limit is used. Raise it in Platform keys, or it starts again next month."
        : /no credits|402/i.test(d)
          ? "The Keywords Everywhere account is out of credits. Add credits in your Keywords Everywhere account."
          : "Check the Keywords Everywhere API key in Platform keys.",
    workaround: "Until then, rivals are studied from Google results and Keyword Planner only.",
  },
  serper: {
    name: "Google results lookups (serper.dev)",
    fix: (d) => (/credit|quota|limit|402|429/i.test(d) ? "The serper.dev credits ran out. Top up or upgrade at serper.dev." : "Check the serper.dev key in Platform keys."),
    workaround: "Rank checks, difficulty scores and backlink searches pause until it works again; cached results are used meanwhile.",
  },
  ai: {
    name: "The writing AI",
    fix: (d) =>
      OUT_OF_CREDIT.test(d)
        ? outOfCredit(d)
        : !/accept the key|401|403|billing|quota|payment/i.test(d) && /busy|demand|empty|fetch failed/i.test(d)
          ? "The AI services were busy or gave empty answers, so DashPatrol tries again 3 hours later by itself. Keys for both Claude and Groq in Platform keys give it a backup."
          : "Every AI key failed. Check the keys and their billing in Platform keys.",
    workaround: "No new changes or articles are written until one works.",
  },
  email: {
    name: "Owner emails (resend.com)",
    fix: (d) =>
      /not set up/i.test(d)
        ? /add a from address/i.test(d) && !/resend key/i.test(d)
          ? "The Resend key is saved. Add a from address (like reports@yourdomain.com) in Platform keys, so weekly reports and alerts reach your inbox."
          : /resend key/i.test(d) && !/from address/i.test(d)
            ? "The from address is saved. Add a Resend key in Platform keys, so weekly reports and alerts reach your inbox."
            : "Add a Resend key and a from address in Platform keys, so weekly reports and alerts reach your inbox."
        : /domain|verify|403/i.test(d)
          ? "Verify the sending domain in Resend, or change the email sender in Platform keys."
          : "Check the email key in Platform keys.",
    workaround: "Reports and alerts still show on the dashboard.",
  },
  "ai-review": {
    name: "The second AI that checks the work",
    fix: (d) =>
      /only one ai service/i.test(d) || !d
        ? "Add a key from a second AI provider in Platform keys, so every change can be checked by a different AI."
        : OUT_OF_CREDIT.test(d)
          ? outOfCredit(d)
          : "The checking AI was busy or gave empty answers, so DashPatrol tries again by itself.",
    workaround: "Page changes and new articles wait until it is added; plans are shown but not acted on.",
  },
  "share-kit": {
    name: "Social posts for new articles",
    fix: () => "The writing or checking AI turned down the posts twice for the newest article, so it moves on to the next one. Nothing to do unless it keeps happening.",
    workaround: "Articles still publish; their posts can be written by hand.",
  },
  threads: {
    name: "Posting to Threads",
    fix: (d) =>
      /app|client|secret|redirect/i.test(d ?? "")
        ? "Check the Threads app ID and secret in Platform keys, and that the app's redirect address is set in Meta's developer settings."
        : /reading replies|permission/i.test(d ?? "")
          ? "Threads didn't allow reading replies. Check that the Threads app in Meta's developer settings has threads_read_replies and threads_manage_replies, then connect Threads again."
          : /social agent/i.test(d ?? "")
            ? "The social agent's daily run failed. It tries again tomorrow by itself; drafts already made stay for the owner."
            : "Threads turned down the last post. It tries the next article by itself; nothing was posted twice.",
    workaround: "The posts stay under Share this week to post by hand.",
  },
  facebook: {
    name: "Posting to a Facebook Page",
    fix: (d) =>
      /app|client|secret|redirect|permission|\(#200\)|\(#10\)/i.test(d ?? "")
        ? "Check the Facebook app ID and secret in Platform keys, that the app's redirect address is set in Meta's developer settings, and that the app has pages_manage_posts."
        : "Facebook turned down the last post. It tries the next article by itself; nothing was posted twice.",
    workaround: "The posts stay under Share this week to post by hand.",
  },
  instagram: {
    name: "Posting to Instagram",
    fix: (d) =>
      /app|client|secret|redirect|permission|\(#200\)|\(#10\)/i.test(d ?? "")
        ? "Check the Facebook app in Meta's developer settings has instagram_basic and instagram_content_publish, and that the Instagram account is a business or creator account linked to the Page."
        : /image|media|aspect|format/i.test(d ?? "")
          ? "Instagram didn't accept the article's image. It moves on to the next article by itself."
          : "Instagram turned down the last post. It tries the next article by itself; nothing was posted twice.",
    workaround: "The posts stay under Share this week to post by hand.",
  },
  communities: {
    name: "Communities to join (suggestions for the owner)",
    fix: () => "Writing this week's community answers failed. It tries again next week by itself; last week's list stays.",
    workaround: "Nothing is posted in any community by DashPatrol; the owner posts the answers themselves.",
  },
  creators: {
    name: "The creator finder (Instagram creators for the owner)",
    fix: (d) =>
      /connected again/i.test(d ?? "")
        ? "The owner's Facebook connection expired or was removed. The owner connects Facebook again under Share this week."
        : /skipped/i.test(d ?? "")
          ? "Nothing is broken: creator search waits for this site (paused, not connected, or no searches yet) and tries again next week."
          : /permission|isn't allowed/i.test(d ?? "")
        ? "The Meta app needs instagram_manage_insights (and, for Creator Marketplace search, the creator marketplace permission). Add them in Meta's developer settings, then the owner clicks Turn on creator search on the Creators card (posting stays as it is)."
        : /other customers/i.test(d ?? "")
          ? "The customer list couldn't be read, so nothing was saved. It tries again next week by itself."
          : "A creator source failed this week. It tries again next week by itself; the list from before stays.",
    workaround: "Nothing is ever sent to a creator by DashPatrol; the owner can still add usernames and draft messages.",
  },
  "shopify-sales": {
    name: "Sales from Shopify",
    fix: () => "It tries again by itself. If it keeps failing, reconnect the store under Content.",
    workaround: "Sales are counted from Google Analytics meanwhile.",
  },
  "site-audit": {
    name: "The Site Auditor (every page, every week)",
    fix: () => "It tries again next hour by itself.",
    workaround: "The pages already checked stay on the list until the next pass.",
  },
  press: {
    name: "The Journalists agent (reporters on the site's topics, and paid placements)",
    fix: (d) =>
      /Hunter refused/i.test(d ?? "")
        ? "Check the Hunter.io key in Platform keys. Journalists are still found; only Hunter's email lookups wait."
        : /Hunter's monthly search quota/i.test(d ?? "")
          ? "Hunter's monthly quota is used up. Its email lookups wait until it renews, or upgrade the Hunter plan."
          : /search key|serper/i.test(d ?? "")
        ? "Add a Serper search key in Platform keys, so journalists and paid placements can be searched."
        : /no second AI/i.test(d ?? "")
          ? "Add a key for a second AI from a different provider in Platform keys, so pitches can be checked before the owner sees them."
          : /turned it down/i.test(d ?? "")
            ? "Nothing to fix: the checking AI turned down one pitch, so that journalist was skipped. Journalists are still found and listed, and it tries again next week by itself."
          : /AI key/i.test(d ?? "")
            ? "Add an AI key in Platform keys, so pitches can be written."
            : /limit/i.test(d ?? "")
              ? "The site used its monthly limit for searches or AI. Raise it in Platform keys or wait for next month; the list from before stays."
              : /customer list/i.test(d ?? "")
                ? "The customer list couldn't be read, so nothing was saved. It tries again within a day by itself."
                : "It tries again next week by itself; the list from before stays.",
    workaround: "Nothing is ever sent to a journalist by DashPatrol; the owner sends every pitch, and the list from before stays.",
  },
  "media-requests": {
    name: "Media requests (journalists asking for sources)",
    fix: (d) =>
      /search key|serper/i.test(d ?? "")
        ? "Add a Serper search key in Platform keys, so media requests can be searched."
        : /limit/i.test(d ?? "")
          ? "The site used its monthly search limit. Raise it in Platform keys or wait for next month."
          : /customer list/i.test(d ?? "")
            ? "The customer list couldn't be read, so nothing was saved. It tries again within a day by itself."
            : "It tries again by itself; the requests from before stay.",
    workaround: "The Outreach tab lists the sites where the owner can sign up to get requests directly.",
  },
  "store-audit": {
    name: "The Store audit (key pages checked for what stops a sale)",
    fix: (d) =>
      /AI key/i.test(d ?? "")
        ? "Add an AI key in Platform keys. The measured speed and app numbers still show meanwhile."
        : /second AI/i.test(d ?? "")
          ? "Add a key for a second AI from a different provider in Platform keys, so the conversion review can be checked. It tries again within a day."
          : /monthly AI limit/i.test(d ?? "")
            ? "The site used its AI limit for the month. Raise the limit in Platform keys or wait for next month; last week's fixes stay."
            : /out of time/i.test(d ?? "")
              ? "The conversion review ran out of time. It tries again within a day by itself; last week's fixes stay."
              : /key pages could(?:n't| not) be read/i.test(d ?? "")
                ? "The store's key pages couldn't be read this week. Check that the site is online and not blocking visitors; it tries again next week by itself."
                : /list of sites due/i.test(d ?? "")
                  ? "The database didn't answer when the hourly run looked for sites due. It tries again next hour by itself."
                  : "It tries again by itself. The owner can also click Run now on the Store audit card once a day.",
    workaround: "Last week's store audit stays on the dashboard until the next one.",
  },
  conversion: {
    name: "The Conversion agent (why visitors don't buy, and what to change)",
    fix: (d) =>
      /AI key/i.test(d ?? "")
        ? "Add an AI key in Platform keys, so the conversion moves can be planned."
        : /second AI/i.test(d ?? "")
          ? "Add a key for a second AI from a different provider in Platform keys, so the conversion moves can be checked."
          : /monthly AI limit/i.test(d ?? "")
            ? "The site used its AI limit for the month. Raise the limit in Platform keys or wait for next month; last week's moves stay."
            : /orders can't be read|reconnect Shopify/i.test(d ?? "")
              ? "Reconnect Shopify from Connections and allow orders, so paid orders count in the conversion rate. Only the owner can do this."
            : /Analytics/i.test(d ?? "")
              ? "Google Analytics couldn't be read. It tries again next week; if it keeps failing, reconnect Google."
              : /recorded or taken off/i.test(d ?? "")
                ? "A product page section was added but not recorded. Check the product's description in Shopify and remove the DashPatrol section if it shouldn't be there."
                : "It tries again by itself within a day; last week's moves stay.",
    workaround: "Last week's conversion moves stay on the dashboard until the next check.",
  },
  speed: {
    name: "The Speed agent (Google's phone speed test on key pages)",
    fix: (d) =>
      /PageSpeed key/i.test(d ?? "")
        ? "Add a PageSpeed key in Platform keys, so phone speed can be measured."
        : "It tries again by itself next week; last week's speed fixes stay.",
    workaround: "Last week's speed results stay on the dashboard.",
  },
  crm: {
    name: "The CRM's follow ups, written emails and morning email",
    fix: (d) =>
      /Settings/i.test(d ?? "")
        ? "Open CRM, click Settings, and write what your first email offers. Then the emails are written by themselves."
        : /AI key/i.test(d ?? "")
          ? "Add an AI key in Platform keys, so emails can be written."
          : "It tries again by itself within the hour. Your contacts and history are not affected.",
    workaround: "Follow up tasks and the morning email wait until the next run; everything you add by hand works as usual.",
  },
  "site-watch": {
    name: "Site watch (the site answers, is open to Google and is measured)",
    fix: () => "It tries again by itself within the hour.",
    workaround: "The other agents keep working; only these checks wait.",
  },
  "prospect-finder": {
    name: "The Prospect finder (new businesses for your CRM)",
    fix: (d) =>
      /search results key/i.test(d ?? "")
        ? "Add a search results key (serper.dev) in Platform keys."
        : /limit|trial/i.test(d ?? "")
          ? "This month's search limit for the site is used up. It carries on by itself when the limit allows."
        : "It tries again by itself within the hour. Contacts already found are not affected.",
    workaround: "Contacts you add or import by hand work as usual meanwhile.",
  },
  leads: {
    name: "The Leads keeper (form requests saved in Shopify Customers)",
    fix: (d) =>
      /customer access/i.test(d ?? "")
        ? "Allow DashPatrol to work with customers in Shopify: approve the app's updated permissions when Shopify asks, or reconnect Shopify from Connections. Only the owner can do this."
        : "It tries again by itself within the hour.",
    workaround: "Every request is kept on the Leads card in DashPatrol meanwhile.",
  },
  images: {
    name: "The Image agent (lighter copies of heavy images)",
    fix: (d) =>
      /reserved/i.test(d ?? "")
        ? "An image change was started but not cleared. Check the image in Shopify Files; the app tries again next week."
        : "It tries again by itself next week.",
    workaround: "Images stay as they are until the next check.",
  },
  "index-rescue": {
    name: "The Index rescue (pages Google left out)",
    fix: () => "It tries again next week by itself.",
    workaround: "The page stays on the Keywords page health list until Google indexes it.",
  },
  "outreach-drafter": {
    name: "The Outreach Drafter (backlink emails written ahead)",
    fix: (d) =>
      /AI key/i.test(d)
        ? "Add an AI key in Platform keys."
        : /turned down every email|Couldn't write a safe email/i.test(d)
          ? "Not a missing key or an outage: the checks turned down the emails written for these sites, so those sites wait a week. The drafter writes for other sites on its next run by itself; write the email on a site by hand meanwhile."
          : "It tries again by itself. Write the email on a site by hand meanwhile.",
    workaround: "Each site on the Backlinks list still has Write the email.",
  },
  "idea-finder": {
    name: "The Idea finder (new searches from Google)",
    fix: (d) => (/keyword planner/i.test(d) ? "Reconnect Google Ads under Keyword ideas, so new searches can be measured." : "It tries again in 6 hours by itself. Nothing to do unless it keeps happening."),
    workaround: "The Strategist plans from the searches already known.",
  },
  "keyword-planner": {
    name: "Google Keyword Planner",
    fix: () => "Reconnect Google Ads under Keyword ideas.",
    workaround: "Keyword ideas pause; the current keyword list keeps being used.",
  },
};

export async function inspect(accountId: string, conn: Connection | null, opts: { repair?: boolean; ourDomain?: string } = {}): Promise<Problem[]> {
  await ensureSchema();
  const problems: Problem[] = [];

  // 1. Services every agent relies on.
  const status = await readStatus();
  // A failure caused by the AI services is already fixed when both the writer and the checker have worked since
  // (a key added or a busy spell over): it isn't shown, and the next run proves it.
  const aiFixedSince = (at: string | null | undefined) =>
    Boolean(at) && [status.ai, status["ai-review"]].every((x) => x?.ok && x.lastOk && Date.parse(x.lastOk) > Date.parse(at!));
  // Named AI services only; a site's own monthly AI limit is not something a working service fixes.
  const AI_CAUSE_RE = /GitHub Models|Groq|Gemini|Mistral|Cerebras|Claude|second AI from another/i;
  const AI_CAUSE = { test: (t: string) => AI_CAUSE_RE.test(t) && !/limit/i.test(t) };
  for (const [part, st] of Object.entries(status) as [Part, NonNullable<(typeof status)[Part]>][]) {
    if (!st || st.ok) continue;
    if (part !== "ai" && part !== "ai-review" && AI_CAUSE.test(st.detail ?? "") && aiFixedSince(st.at)) continue;
    // A busy AI service that answered within the last 3 hours is a blip the backups and retries handle, not a fault
    // to show the owner. A refused key or billing problem always shows.
    const busy = /busy|demand|empty|timeout|aborted|fetch failed|overloaded|\b(429|503)\b/i.test(st.detail ?? "") && !/accept the key|401|403|billing|quota|payment/i.test(st.detail ?? "");
    if ((part === "ai" || part === "ai-review") && busy && st.lastOk && Date.now() - Date.parse(st.lastOk) < 3 * HOUR) continue;
    // Only one AI service: the owner approves the work instead, a chosen setup rather than something broken.
    if (part === "ai-review" && /only one ai service/i.test(st.detail ?? "")) {
      problems.push({
        id: "service:ai-review",
        text: "Changes wait for your approval, because no second AI checks the work yet.",
        fix: "Approve each one under Content. Adding a Claude key in Platform keys lets a second AI check the work instead.",
        who: "watching",
        platform: true,
      });
      continue;
    }
    const p = PART_FIX[part];
    problems.push({
      id: `service:${part}`,
      // Short and plain: what's broken and the one thing to do. The service's own wording stays in the logs.
      text: `${p.name} isn't working${st.lastOk ? ` (last worked ${new Date(st.lastOk).toLocaleDateString()})` : ""}.`,
      fix: p.fix(st.detail ?? ""),
      who: "owner",
      platform: true,
    });
  }

  const [auto, platform] = await Promise.all([readAccountAutopilot(accountId), readPlatformSettings()]);

  // 2. Daily rank checks gone stale: tell the rank tracker to run now.
  if (conn && platform.serperKey && opts.ourDomain) {
    const [row] = await sql`SELECT max(checked_on) AS last FROM insights_rank_daily WHERE account_id = ${accountId}`;
    const last = row?.last ? Date.parse(String(row.last)) : null;
    if (last !== null && Date.now() - last > 2 * 24 * HOUR) {
      const checked = opts.repair ? await trackRanks(accountId, conn, platform.serperKey, opts.ourDomain).catch(() => 0) : 0;
      problems.push({
        id: "ranks:stale",
        text: `Rankings hadn't been checked since ${new Date(last).toLocaleDateString()}.`,
        fix: checked ? `The rank tracker was told to run again and checked ${checked} searches.` : "The rank tracker will be asked to run again on the next hourly check.",
        who: checked ? "repaired" : "watching",
        platform: true,
      });
    }
  }

  // 3. The autopilot itself: switched on but not running, or running without doing anything.
  if (auto.enabled && !isSabbath()) {
    const [acct] = await sql`SELECT last_run_at, run_tried_at, run_note FROM insights_account_autopilot WHERE account_id = ${accountId}`;
    const lastRun = acct?.last_run_at ? Date.parse(String(acct.last_run_at)) : null;
    // Switched on but never able to start (a missing connection stops it before it counts as a run).
    if (!lastRun && acct?.run_tried_at && acct.run_note && !/isn't available yet/i.test(acct.run_note)) {
      problems.push({
        id: "autopilot:not-started",
        text: `The autopilot is on but hasn't been able to start: ${acct.run_note}`,
        fix: "Finish that step in Settings; the autopilot tries again within 2 hours.",
        who: "owner",
      });
    }
    // A run left "running" for over an hour was cut off (time limit or crash) and never reported back.
    const [stuck] = await sql`SELECT count(*) AS n FROM insights_autopilot_runs
      WHERE account_id = ${accountId} AND status = 'running' AND trigger <> 'preview' AND started_at < now() - interval '1 hour' AND started_at > now() - interval '3 days'
        AND NOT EXISTS (SELECT 1 FROM insights_autopilot_runs f WHERE f.account_id = ${accountId} AND f.status <> 'running' AND f.trigger <> 'preview' AND f.started_at > insights_autopilot_runs.started_at)`;
    if (Number(stuck?.n ?? 0) > 0) {
      problems.push({
        id: "autopilot:cut-off",
        text: `${stuck.n} recent autopilot ${Number(stuck.n) === 1 ? "run was" : "runs were"} cut off before finishing.`,
        fix: "It is retried on the next daily run. If it keeps happening, the run is taking too long and needs a look.",
        who: "watching",
        platform: true,
      });
    }
    // A run waits out the Sabbath, so allow for that day as well as the usual one.
    // Stalled because of something on the owner's side (a store or Google connection that broke): they can fix it.
    if (lastRun && Date.now() - lastRun > 50 * HOUR && acct?.run_note && /^Connect (Google|your website) first\.?$|\breconnect\b|\bdisconnected\b/i.test(String(acct.run_note).trim())) {
      problems.push({
        id: "autopilot:blocked",
        text: `The autopilot can't run: ${acct.run_note}`,
        fix: "Reconnect it in Settings; the autopilot tries again within 2 hours.",
        who: "owner",
      });
    }
    if (lastRun && Date.now() - lastRun > 50 * HOUR) {
      problems.push({
        id: "autopilot:stalled",
        text: `The autopilot hasn't run in ${Math.round((Date.now() - lastRun) / HOUR)} hours.`,
        fix: "It is queued for the next hourly check. If this stays, the website or store connection likely needs reconnecting in Settings.",
        who: "watching",
        platform: true,
      });
    }
    const runs = await sql`
      SELECT r.summary, r.status, r.finished_at, (SELECT count(*) FROM insights_autopilot_changes c WHERE c.run_id = r.id AND c.status IN ('applied','suggested','kept')) AS made
      FROM insights_autopilot_runs r WHERE r.account_id = ${accountId} AND r.finished_at IS NOT NULL AND r.trigger <> 'preview'
      ORDER BY r.started_at DESC LIMIT 4`;
    // Pages changed this week, as the last run counted them: once the owner raises the weekly limit above it, the
    // next run has room, so the warning goes away now instead of after four more runs.
    const usedThisWeek = Number(/(\d+) pages changed this week/i.exec(String(runs[0]?.summary ?? ""))?.[1] ?? NaN);
    const roomNow = Number.isFinite(usedThisWeek) && auto.maxPagesPerWeek > usedThisWeek;
    // The weekly limit is the owner's chosen pace and urgent fixes go past it, so hitting it isn't a problem to report.
    const paced = /weekly limit/i.test(String(runs[0]?.summary ?? "")) && !/no urgent fix could be made/i.test(String(runs[0]?.summary ?? ""));
    if (runs.length >= 4 && runs.every((r) => Number(r.made) === 0) && !roomNow && !paced) {
      const why = runs[0]?.summary ?? "";
      problems.push({
        id: "autopilot:idle",
        text: "The last 4 autopilot runs changed nothing.",
        fix: /weekly limit/i.test(why)
          ? "It keeps hitting the weekly page limit. Raise pages per week under Content if you want it to do more."
          : /no new opportunities|nothing urgent/i.test(why)
            ? "It ran out of pages to improve. Click Rank for this on a few Easy searches under Keywords to give it new targets."
            : `Last run said: ${why.slice(0, 200) || "no reason given"}.`,
        who: "owner",
      });
    }
    const failed = runs.find((r) => /fail|error/i.test(String(r.status)));
    // Free AI services that were only busy or at their limit for a while: the next run tries again, so one such run
    // isn't news. Three failed runs in a row are, whatever the reason.
    const allFailed = runs.length >= 3 && runs.slice(0, 3).every((r) => /fail|error/i.test(String(r.status)));
    if (failed && runs[0] === failed && !(onlyBusyAi(String(failed.summary ?? "")) && !allFailed) && !(AI_CAUSE.test(String(failed.summary ?? "")) && aiFixedSince(String(failed.finished_at)))) {
      problems.push({ id: "autopilot:failed", text: "The last autopilot run failed.", fix: String(failed.summary ?? "The next run will try again.").slice(0, 300), who: "watching", platform: true });
    }
  }

  // 3a. The Site Auditor's findings only a person can fix (the rest go to the autopilot): the site's own problems,
  // shown to its owner with the pages they're on.
  const audit = await readAudit(accountId).catch(() => []);
  const manual = audit.flatMap((p) => p.issues.filter((i) => !i.auto && i.confirmed && i.level !== "low").map((i) => ({ path: (() => { try { return new URL(p.url).pathname; } catch { return p.url; } })(), i })));
  if (manual.length) {
    const pages = new Set(manual.map((m) => m.path)).size;
    problems.push({
      id: "audit:manual",
      text: `The site check found ${manual.length} ${manual.length === 1 ? "problem" : "problems"} on ${pages} ${pages === 1 ? "page" : "pages"} that need a person: ${manual
        .slice(0, 3)
        .map((m) => `${m.path}: ${m.i.text}`)
        .join(" ")}${manual.length > 3 ? ` And ${manual.length - 3} more.` : ""}`,
      fix: "Fix these in your site's editor. Everything a content change can fix, the autopilot fixes by itself.",
      who: "owner",
    });
  }

  // 3b. The week's plan: a move that passed the critic but that no agent took on (no "done" note) a day after planning
  // is a gap between planning and acting. It is shown so it gets built or handled, never left silent.
  const [plan] = await sql`SELECT value FROM insights_settings WHERE key = ${`strategy:${accountId}`}`.catch(() => [] as { value: string | null }[]);
  if (plan?.value) {
    try {
      const r = JSON.parse(plan.value) as { at: string; checked?: boolean; moves: { kind: string; kept: boolean; done: string | null; action: string }[] };
      const idle = r.checked !== false && Date.now() - Date.parse(r.at) > 24 * HOUR ? r.moves.filter((m) => m.kept && !m.done && m.kind !== "hold") : [];
      if (idle.length) {
        problems.push({
          id: "plan:idle",
          text: `${idle.length} ${idle.length === 1 ? "move" : "moves"} in this week's plan ${idle.length === 1 ? "has" : "have"} no agent acting on ${idle.length === 1 ? "it" : "them"}: ${idle.map((m) => `"${m.action.slice(0, 80)}"`).join("; ")}.`,
          fix: "The platform owner is told, so an agent can be taught to do this kind of move.",
          who: "watching",
          platform: true,
        });
      }
    } catch {
      /* an unreadable plan is the Strategist's own problem, reported there */
    }
  }

  // 4. Rankings swinging for reasons that aren't the agents' work: changes wait to be judged, the owner is told why.
  const turbulence = await rankingTurbulence().catch(() => null);
  if (turbulence) problems.push({ id: "google:update", text: turbulence, fix: "Nothing to do: the agents keep working, and the untouched control pages show what the changes did.", who: "watching", platform: true });
  const traffic = conn?.gscSiteUrl ? await trafficCheck(conn).catch(() => null) : null;
  if (traffic?.sharp) {
    problems.push({
      id: "traffic:drop",
      text: `Google clicks fell ${Math.round(traffic.drop * 100)}% last week (${traffic.recentWeek} against a usual ${traffic.usualWeek}).`,
      fix: "New changes, take downs and verdicts are on hold. Check Search Console for a site problem; the agents resume once clicks recover.",
      who: "owner",
    });
  }

  // Spending: warn at 80% of the month's limit, and say plainly what pauses at 100%.
  const used = await usageThisMonth(accountId).catch(() => null);
  if (used) {
    for (const kind of ["ai", "search"] as const) {
      const share = used[kind] / used.limits[kind];
      const name = kind === "ai" ? "AI" : "Google results";
      if (share >= 1) problems.push({ id: `limit:${kind}`, text: `This site used its ${name} limit for the month (${used.limits[kind]}).`, fix: "What needs it pauses until next month, or the platform owner raises the limit.", who: "owner", platform: true });
      else if (share >= 0.8) problems.push({ id: `limit:${kind}`, text: `This site has used ${Math.round(share * 100)}% of its ${name} limit for the month.`, fix: "Work carries on; at the limit, what needs it pauses until next month.", who: "watching", platform: true });
    }
  }

  // 5. Google may be asked to recrawl changed pages only with permission to manage Search Console.
  if (conn?.gscSiteUrl) {
    const allowed = await hasScope({ kind: "oauth", refreshToken: conn.refreshToken }, "https://www.googleapis.com/auth/webmasters").catch(() => null);
    if (allowed === false) {
      problems.push({
        id: "google:recrawl",
        text: "The app can't ask Google to look at your changed pages sooner.",
        fix: `Open DashPatrol's Home screen and press the "Open Google to allow" button. Google's permission screen opens; choose ${conn.email ?? "the Google account you connected"} and click Allow. It is a one time step, and each change then reaches Google faster.`,
        who: "owner",
      });
    }
  }

  // 6. Each site's data stays its own: no other customer in its backlink list, no site's own ranking in the shared caches.
  if (opts.ourDomain && (await clientListKnown())) {
    const isOther = await otherClient(opts.ourDomain);
    const list = await readProspects(accountId).catch(() => null);
    const crossed = (list?.prospects ?? []).filter((p) => isOther(p.domain));
    const [leak] = await sql`SELECT count(*) AS n FROM insights_report_cache WHERE cache_key LIKE 'kd:%' AND data->>'ours' IS NOT NULL`;
    const leaks = Number(leak?.n ?? 0);
    if (crossed.length || leaks) {
      if (opts.repair) {
        if (crossed.length && list) {
          await sql`UPDATE insights_settings SET value = ${JSON.stringify({ ...list, prospects: list.prospects.filter((p) => !isOther(p.domain)) })}
            WHERE key = ${`backlinks:${accountId}`}`.catch(() => undefined);
        }
        if (leaks) await sql`UPDATE insights_report_cache SET data = jsonb_set(data, '{ours}', 'null'::jsonb) WHERE cache_key LIKE 'kd:%' AND data->>'ours' IS NOT NULL`.catch(() => undefined);
      }
      problems.push({
        id: "data:isolation",
        text: `Found data that belongs to another site (${[crossed.length && `${crossed.length} customer sites in the backlink list`, leaks && `${leaks} saved rankings in a shared cache`].filter(Boolean).join(", ")}).`,
        fix: opts.repair ? "Removed it, so this site only uses its own data." : "It will be removed on the next hourly check.",
        who: opts.repair ? "repaired" : "watching",
        platform: true,
      });
    }
  }

  // 7. Beyond every agent's own job: the App checker looks at the account the way its owner sees it.
  // The hourly tick runs it; the Inspector page and the Strategist read what it last found, so nothing is erased.
  problems.push(...(await appCheck(accountId, conn, { readOnly: !opts.repair })));
  // 8. The site itself: it answers, is open to Google, has a sitemap and is measured (Site watch, run each hour).
  problems.push(...(await siteWatchProblems(accountId).catch(() => [])));

  await sql`
    INSERT INTO insights_settings (key, value) VALUES (${`inspect:${accountId}`}, ${JSON.stringify({ at: new Date().toISOString(), problems })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`.catch(() => undefined);
  return problems;
}

const BUSY_AI = /rate limit|resting until|busy right now|high demand|overloaded|try again later|\b429\b/i;
const AI_NAME = /GitHub Models|Groq|Gemini|Mistral|Cerebras|Claude|github|gemini|mistral|groq|cerebras/i;

/**
 * A run that failed only because free AI services were busy or at their limit for a while (the next run tries again),
 * not because of a key, access or anything a person must fix. GitHub Models' empty reply is left out: its token is a
 * known, separate item for the owner.
 */
export function onlyBusyAi(summary: string): boolean {
  const rest = summary.replace(/GitHub Models answered "OK" with no reply[^.]*\./gi, "");
  return BUSY_AI.test(rest) && AI_NAME.test(rest) && !/key|access|renew|denied|invalid|unauthori[sz]ed|billing/i.test(rest);
}
