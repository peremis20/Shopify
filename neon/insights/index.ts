import * as api from "@/lib/analytics/handlers";
import { sql } from "@/lib/analytics/db";
import { homeHtml, privacyHtml, termsHtml } from "./legal";

/**
 * The public address can be set in the database (insights_settings app_url), so moving to a new
 * domain needs no redeploy and never touches the secrets. Checked once a minute.
 */
/** The address the visitor typed, and whether it is the long Neon one (only that one is moved). */
const hostOf = (req: Request, url: URL) => (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host).toLowerCase();
const onLongAddress = (req: Request, url: URL) => hostOf(req, url).endsWith(".neon.tech");
let publicUrlAt = 0;
async function loadPublicUrl(): Promise<void> {
  if (Date.now() - publicUrlAt < 60_000) return;
  publicUrlAt = Date.now();
  const [row] = await sql`SELECT value FROM insights_settings WHERE key = 'app_url'`.catch(() => []);
  const v = row?.value?.trim().replace(/\/+$/, "");
  if (v && /^https:\/\/[a-z0-9.-]+$/i.test(v)) process.env.APP_URL = v;
}

/**
 * The Insights dashboard as a Neon Function. Serves the page and the same
 * API the Next.js app has. Customers sign in with Google; there is no
 * shared password. The page's script and styles are built by
 * `npm run build:neon` and loaded from ASSET_BASE_URL (a CDN copy of
 * neon/insights/public pinned to a commit).
 */

type Handler = (req: Request) => Promise<Response>;

const routes: Record<string, Handler> = {
  "GET /api/session": api.session,
  "GET /api/heartbeat": api.heartbeat,
  "GET /api/auth/google/start": api.authStart,
  "GET /api/auth/google/callback": api.authCallback,
  "GET /api/auth/google/link": api.googleLinkStart,
  "POST /api/auth/google/disconnect": api.disconnect,
  "POST /api/auth/logout": api.logout,
  "GET /api/onboarding": api.onboarding,
  "POST /api/onboarding/profile": api.saveOnboardingProfile,
  "POST /api/onboarding/match": api.rematchProperties,
  "POST /api/onboarding/site": api.connectWebsite,
  "POST /api/onboarding/setup-google": api.setupGoogleTools,
  "GET /api/analytics/overview": api.overview,
  "GET /api/analytics/properties": api.properties,
  "POST /api/analytics/settings": api.saveSettings,
  "POST /api/analytics/google-client": api.saveGoogleClient,
  "GET /api/keywords/status": api.keywordSetup,
  "POST /api/keywords/settings": api.saveKeywordSettings,
  "POST /api/keywords/ideas": api.keywordIdeasHandler,
  "POST /api/keywords/volumes": api.keywordVolumesHandler,
  "GET /api/seo/opportunities": api.opportunities,
  "GET /api/seo/lists": api.keywordLists,
  "POST /api/seo/target": api.rankForThis,
  "GET /api/seo/targets": api.rankTargets,
  "GET /api/seo/authority": api.siteAuthority,
  "POST /api/seo/difficulty": api.keywordDifficultyApi,
  "GET /api/inspector": api.inspectorReport,
  "GET /api/seo/authority-plan": api.authorityPlanReport,
  "GET /api/autopilot/scorecard": api.agentScorecard,
  "GET /api/content/review": api.expertReview,
  "POST /api/content/review": api.expertReview,
  "GET /api/strategy": api.strategyReport,
  "POST /api/strategy": api.strategyReport,
  "GET /api/seo/backlinks": api.backlinkProspects,
  "POST /api/seo/backlinks": api.backlinkProspects,
  "POST /api/seo/backlinks/email": api.backlinkEmail,
  "POST /api/seo/lists/update": api.updateKeywordLists,
  "GET /api/seo/rankings": api.rankings,
  "GET /api/autopilot": api.autopilotStatus,
  "POST /api/autopilot/settings": api.saveAutopilot,
  "POST /api/autopilot/platform": api.savePlatform,
  "POST /api/autopilot/run": api.runAutopilotNow,
  "POST /api/autopilot/preview": api.previewAutopilot,
  "GET /api/autopilot/watch": api.autopilotWatch,
  "POST /api/autopilot/check": api.autopilotCheckNow,
  "POST /api/autopilot/revert": api.revertAutopilot,
  "POST /api/autopilot/fix": api.markFix,
  "GET /api/wordpress/connect": api.wordpressConnect,
  "GET /api/wordpress/plugin": api.wordpressPlugin,
  "POST /api/wordpress/disconnect": api.wordpressDisconnect,
  "POST /api/webflow/connect": api.webflowConnect,
  "POST /api/wix/connect": api.wixConnect,
  "POST /api/site/disconnect": api.siteDisconnect,
  "GET /s.js": api.snippetScript,
  "GET /api/snippet/data": api.snippetDataHandler,
  "GET /api/snippet": api.snippetStatus,
  "POST /api/snippet/check": api.snippetCheck,
  "GET /api/shopify/install": api.shopifyInstall,
  "GET /api/shopify/callback": api.shopifyCallback,
  "POST /api/shopify/disconnect": api.shopifyDisconnect,
  "POST /api/shopify/webhooks": api.shopifyWebhook,
};

/**
 * Plain HTML shown before the app loads (and to anyone without JavaScript, like Google's app reviewers): what
 * DashPatrol is, what it does with Google data, and links to the privacy policy and terms. React replaces it.
 */
const HOME_TEXT = `<main style="max-width:720px;margin:0 auto;padding:48px 16px;font:16px/1.6 system-ui,sans-serif">
<h1>DashPatrol</h1>
<p>DashPatrol helps your website rank on Google and turn that traffic into sales. Sign in with Google, connect your site (Shopify, WordPress, Webflow, Wix or any site through a small snippet), and DashPatrol plans each week from your real numbers, improves your pages, writes articles you allow, and measures every change so it keeps what works and undoes what doesn't.</p>
<h2>How DashPatrol uses your Google data</h2>
<ul>
<li>Google Search Console (read only): the searches your pages show up for, with clicks and positions, so it knows which pages to improve and can track results.</li>
<li>Google Analytics (read only): visits and sales from search, to measure whether each change helped.</li>
<li>Only when you click Set it up for me: it verifies your site, adds it and its sitemap to Search Console, and creates an Analytics property for it.</li>
<li>Your data is used only to run DashPatrol for your own site. It is never sold, never shared with other customers and never used for ads.</li>
</ul>
<p><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of use</a></p>
</main>`;

/**
 * The dashboard page. Opened by Shopify inside its admin (a `shop` parameter),
 * it loads App Bridge first and allows only Shopify admin to frame it.
 */
async function page(req: Request): Promise<Response> {
  const assets = (process.env.ASSET_BASE_URL ?? "").replace(/\/$/, "");
  const shop = new URL(req.url).searchParams.get("shop") ?? "";
  const embedded = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? await api.embeddedAppKey() : null;
  const bridge = embedded
    ? `<meta name="shopify-api-key" content="${embedded}">\n<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>\n`
    : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${embedded ? '<meta name="robots" content="noindex">\n' : ""}<meta name="description" content="DashPatrol helps your website rank on Google: it reads your Search Console and Analytics, improves your pages, writes articles you allow and measures what worked.">
${bridge}<title>${api.APP_NAME}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Inter:wght@400;500;600&display=swap">
<link rel="stylesheet" href="${assets}/app.css">
<style>:root{--font-serif:"Fraunces",Georgia,serif;--font-dash:"Inter",system-ui,sans-serif}body{margin:0;background:#F7F3EC;color:#2B2A27}</style>
</head>
<body>
<div id="root">${embedded ? "" : HOME_TEXT}</div>
<script src="${assets}/app.js"></script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": embedded ? `frame-ancestors https://${shop} https://admin.shopify.com` : "frame-ancestors 'none'",
    },
  });
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    await loadPublicUrl();
    // Pages opened on another address (the old long one) move to the public address.
    const pub = (process.env.APP_URL ?? "").replace(/\/+$/, "");
    const isPage = path === "/" || path === "/analytics" || path === "/privacy" || path === "/terms";
    if (req.method === "GET" && isPage && pub && onLongAddress(req, url) && pub !== `https://${hostOf(req, url)}`) {
      return new Response(null, { status: 301, headers: { Location: `${pub}${url.pathname}${url.search}` } });
    }

    // The bare domain (dashpatrol.io for app.dashpatrol.io) is the public home page: it shows what DashPatrol is,
    // the policy and terms, and sends everything else to the app.
    const pubHost = pub.replace(/^https:\/\//, "").toLowerCase();
    if (pubHost.startsWith("app.") && hostOf(req, url) === pubHost.slice(4)) {
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Not found", { status: 404 });
      const html = path === "/" ? () => homeHtml(pub) : path === "/privacy" ? privacyHtml : path === "/terms" ? termsHtml : null;
      if (html) return new Response(html(), { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "frame-ancestors 'none'" } });
      return new Response(null, { status: 301, headers: { Location: `${pub}${url.pathname}${url.search}` } });
    }

    // Neon's scheduler calls this without the password. Neon strips client-set
    // X-Neon-* headers, so this header proves the call came from a trigger.
    if (req.method === "POST" && path === "/api/autopilot/tick" && req.headers.get("x-neon-trigger-invocation-id")) {
      return api.autopilotTick();
    }

    const handler = routes[`${req.method} ${path}`];
    if (handler) {
      try {
        return await handler(req);
      } catch (err) {
        // Full details go to the logs; the browser gets a plain sentence.
        const message = api.publicError(err, `${req.method} ${path}`);
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    if (req.method === "GET" && (path === "/" || path === "/analytics")) return page(req);
    if (req.method === "GET" && (path === "/privacy" || path === "/terms")) {
      return new Response(path === "/privacy" ? privacyHtml() : termsHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404 });
  },
};
