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
  "POST /api/client-errors": api.clientErrors,
  "GET /api/auth/google/start": api.authStart,
  "GET /api/auth/google/callback": api.authCallback,
  "GET /api/auth/google/link": api.googleLinkStart,
  "POST /api/auth/google/disconnect": api.disconnect,
  "POST /api/auth/logout": api.logout,
  "GET /api/onboarding": api.onboarding,
  "POST /api/onboarding/profile": api.saveOnboardingProfile,
  "GET /api/profile/business": api.businessProfile,
  "POST /api/profile/business": api.businessProfile,
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
  "GET /api/autopilot/weekly-report": api.weeklyReportPreview,
  "GET /api/autopilot/share": api.shareKits,
  "POST /api/autopilot/share": api.shareKits,
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
 * A plain loading screen in the app's own colors while it starts (so a refresh doesn't flash a different page), and
 * for anyone without JavaScript, like Google's app reviewers: what DashPatrol is, what it does with Google data, and
 * links to the privacy policy and terms. React replaces it.
 */
const HOME_TEXT = `<div style="min-height:100vh;margin:0;background:#F7F3EC;display:flex;align-items:center;justify-content:center;font:600 15px Inter,system-ui,sans-serif;color:#6B675F" aria-busy="true">Loading DashPatrol&hellip;</div>
<noscript><main style="min-height:100vh;margin:0;background:linear-gradient(160deg,#0A3520,#0F5A32);color:#fff;font:16px/1.6 Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:32px 16px;box-sizing:border-box">
<div style="max-width:620px;text-align:center">
<p style="margin:0 0 18px;font:800 26px 'Plus Jakarta Sans',Inter,sans-serif;display:inline-flex;align-items:center;gap:10px"><span style="display:inline-flex;width:34px;height:34px;border-radius:9px;background:#3DCB5A;color:#0B3B22;align-items:center;justify-content:center">D</span>DashPatrol</p>
<h1 style="margin:0;font:800 clamp(30px,5vw,44px)/1.1 'Plus Jakarta Sans',Inter,sans-serif">Grow your business on <span style="color:#C6F432">autopilot.</span></h1>
<p style="color:rgba(255,255,255,.85)">DashPatrol helps your website rank on Google and turn that traffic into sales. It reads your Search Console (read only) and Analytics (read only) to choose which pages to improve and to measure every change. Only when you click Set it up for me does it verify your site, add it and its sitemap to Search Console and create an Analytics property. Your data is used only for your own site, never sold, shared or used for ads.</p>
<p style="font-size:14px"><a href="/privacy" style="color:#C6F432">Privacy policy</a> &middot; <a href="/terms" style="color:#C6F432">Terms of use</a></p>
</div>
</main></noscript>`;

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
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Plus+Jakarta+Sans:wght@700;800&family=Inter:wght@400;500;600&display=swap">
<link rel="icon" href="${assets}/site/favicon.svg" type="image/svg+xml">
<link rel="icon" href="${assets}/site/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="${assets}/site/apple-touch-icon.png">
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

/** The marketing website's files, by the address a visitor asks for; anything else is left to the app. */
const SITE_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
};
const siteCache = new Map<string, { at: number; body: ArrayBuffer; type: string }>();
const siteMissing = new Map<string, number>();

function siteFile(path: string): string | null {
  if (path === "/") return "index.html";
  const clean = path.replace(/^\/+/, "");
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(clean) || clean.includes("..")) return null;
  if (/^(assets|fonts)\/[a-z0-9._-]+$/i.test(clean)) return clean;
  if (/^(favicon\.ico|favicon\.svg|apple-touch-icon\.png|robots\.txt|sitemap\.xml)$/i.test(clean)) return clean;
  if (/^[a-z0-9-]+\.html$/i.test(clean)) return clean;
  if (/^[a-z0-9-]+$/i.test(clean)) return `${clean}.html`;
  return null;
}

async function sitePage(path: string): Promise<Response | null> {
  const file = siteFile(path);
  const base = (process.env.ASSET_BASE_URL ?? "").replace(/\/$/, "");
  if (!file || !base) return null;
  const key = `${base}/site/${file}`;
  let hit = siteCache.get(key);
  if (siteMissing.has(key) && Date.now() - siteMissing.get(key)! < 10 * 60_000) return null;
  if (!hit || Date.now() - hit.at > 10 * 60_000) {
    const res = await fetch(key, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (res?.status === 404) {
      // Not a website page (an app address, say): remembered so the next visit doesn't wait on the CDN again.
      siteMissing.set(key, Date.now());
      return null;
    }
    if (res?.ok) {
      hit = { at: Date.now(), body: await res.arrayBuffer(), type: SITE_TYPES[file.split(".").pop()!.toLowerCase()] ?? "application/octet-stream" };
      siteCache.set(key, hit);
    } else if (!hit) {
      return null;
    }
    // A CDN hiccup with a copy in hand: the slightly older copy is served rather than nothing.
  }
  const page = hit.type.startsWith("text/html");
  return new Response(hit.body, {
    headers: {
      "Content-Type": hit.type,
      "Cache-Control": page ? "no-cache" : "public, max-age=600",
      "X-Content-Type-Options": "nosniff",
      ...(page ? { "Content-Security-Policy": "frame-ancestors 'none'" } : {}),
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
      // The website itself (neon/insights/public/site, served from the same CDN copy as the app's assets).
      // The old policy addresses (registered with Google) open the website's own policy pages.
      if (path === "/privacy" || path === "/terms") {
        const to = path === "/privacy" ? "/privacy-policy.html" : "/terms-of-service.html";
        if (await sitePage(to)) return new Response(null, { status: 301, headers: { Location: to } });
      }
      const site = path === "/privacy" || path === "/terms" ? null : await sitePage(path);
      if (site) return site;
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
