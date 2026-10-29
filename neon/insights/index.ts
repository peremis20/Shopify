import * as api from "@/lib/analytics/handlers";

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
  "GET /api/auth/google/start": api.authStart,
  "GET /api/auth/google/callback": api.authCallback,
  "POST /api/auth/google/disconnect": api.disconnect,
  "POST /api/auth/logout": api.logout,
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
  "GET /api/shopify/install": api.shopifyInstall,
  "GET /api/shopify/callback": api.shopifyCallback,
  "POST /api/shopify/disconnect": api.shopifyDisconnect,
  "POST /api/shopify/webhooks": api.shopifyWebhook,
};

function page(): Response {
  const assets = (process.env.ASSET_BASE_URL ?? "").replace(/\/$/, "");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Insights Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Inter:wght@400;500;600&display=swap">
<link rel="stylesheet" href="${assets}/app.css">
<style>:root{--font-serif:"Fraunces",Georgia,serif;--font-dash:"Inter",system-ui,sans-serif}body{margin:0;background:#F7F3EC;color:#2B2A27}</style>
</head>
<body>
<div id="root"></div>
<script src="${assets}/app.js"></script>
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";

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
        const message = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    if (req.method === "GET" && (path === "/" || path === "/analytics")) return page();
    return new Response("Not found", { status: 404 });
  },
};
