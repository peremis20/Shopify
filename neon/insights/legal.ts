import { CHROME_CSS, homeOf, landingHtml, siteFooter, siteNav } from "./landing";
/**
 * The privacy policy and terms, served at /privacy and /terms. Plain words, describing only what the app really
 * does. The contact address comes from SUPPORT_EMAIL, or else the first platform owner in ADMIN_EMAILS.
 */
const page = (title: string, body: string) => {
  const app = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  const home = homeOf(app);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@700;800&family=Inter:wght@400;500;600;700&display=swap">
<style>
:root{--ink:#0E2A1A;--muted:#5C6660;--bg:#F5FAF6;--card:#FFFFFF;--line:#DDE9E0;--accent:#17703A}
@media (prefers-color-scheme: dark){:root{--ink:#E8F2EA;--muted:#A7B8AC;--bg:#0F1712;--card:#16211A;--line:#24352A;--accent:#5BB884}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.7 Inter,system-ui,sans-serif}
.hero{background:linear-gradient(160deg,#0A3520,#0F5A32);color:#fff;padding:56px 0 64px}
.hero .in{max-width:820px;margin:0 auto;padding:0 20px}
.hero h1{font-family:"Plus Jakarta Sans",Inter,sans-serif;font-weight:800;font-size:clamp(32px,5vw,48px);margin:0;letter-spacing:-.02em}
.hero small{color:#C6F432;font-weight:600}
main{max-width:820px;margin:-32px auto 64px;padding:32px 28px;background:var(--card);border:1px solid var(--line);border-radius:22px;position:relative}
main h2{font-family:"Plus Jakarta Sans",Inter,sans-serif;font-weight:800;font-size:20px;margin:28px 0 6px}
main h2:first-child{margin-top:0}
main p,main li{color:var(--ink)}main a{color:var(--accent)}
@media (max-width:860px){main{margin:-32px 16px 48px;padding:24px 18px}}
${CHROME_CSS}
</style>
</head>
<body>
${siteNav(app || "/", home)}
${body}
${siteFooter(app || "/", home, contact())}
</body>
</html>`;
};

const contact = () => {
  // A plain address only, so a typo can't break the page.
  const ok = (e: string) => /^[^\s@<>"',]+@[^\s@<>"',]+\.[a-z]{2,}$/i.test(e);
  const email = [process.env.SUPPORT_EMAIL ?? "", ...(process.env.ADMIN_EMAILS ?? "").split(",")].map((e) => e.trim()).find(ok);
  return email ? `<a href="mailto:${email}">${email}</a>` : "DashPatrol support through the app";
};

export const privacyHtml = () =>
  page(
    "DashPatrol privacy policy",
    `<section class="hero"><div class="in"><h1>Privacy policy</h1><small>Last updated November 2, 2026.</small></div></section>
<main>
<h2>What DashPatrol does</h2>
<p>DashPatrol helps your website rank on Google. It reads your site and its Google data, improves pages, writes articles you allow, and measures what worked. This policy covers the DashPatrol app at app.dashpatrol.io.</p>
<h2>What we read</h2>
<ul>
<li>Your Google account email, to sign you in.</li>
<li>Google Search Console and Google Analytics data for the sites you connect.</li>
<li>Your website's pages. On Shopify, WordPress, Webflow and Wix the app changes the content you allow; with the snippet, it shows its changes on your pages; on other sites it gives you a fix list.</li>
</ul>
<h2>What we change in your Google accounts</h2>
<ul>
<li>Normally nothing: Search Console and Analytics are read only.</li>
<li>If you use Set it up for me, DashPatrol verifies your site, adds it and its sitemap to Search Console, and creates a Google Analytics property for it.</li>
<li>If you click Allow, it may resubmit sitemaps already listed in your Search Console so Google looks at changed pages sooner.</li>
</ul>
<h2>How we use it</h2>
<ul>
<li>Only to run DashPatrol for you: planning, improving pages, writing articles, tracking rankings and reporting results.</li>
<li>Page text and search data are sent to AI providers (Anthropic, Groq, GitHub Models or Google Gemini) to write and check changes.</li>
<li>Searches are sent to serper.dev to look up Google results, and to Google Ads Keyword Planner (through DashPatrol's own Ads account) for search volumes.</li>
<li>Page addresses are sent to Google PageSpeed Insights for site health checks, and domains to Open PageRank for public site strength scores.</li>
<li>Your email address and reports are sent to Resend to email you.</li>
<li>Changes are written to your site through its own platform (Shopify, WordPress, Webflow or Wix), with the access you gave.</li>
<li>Each site is worked on with its own data only. Your data is never shared with other customers, never sold, and never used for ads.</li>
<li>DashPatrol's use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.</li>
</ul>
<h2>Where it is kept</h2>
<p>In a database hosted by Neon. Sign in tokens and site access keys (Google, Shopify, WordPress, Webflow, Wix) are stored encrypted. Your data is kept until you ask us to delete it; disconnecting stops DashPatrol reading it but doesn't delete what was already stored.</p>
<h2>Your choices</h2>
<ul>
<li>Disconnect Google, your store or your site at any time in Settings; DashPatrol then stops reading it.</li>
<li>Undo any change the app made to your pages from the Content page (fix list items you pasted in are undone by hand).</li>
<li>Turn emails off in Autopilot settings.</li>
<li>To have your data deleted, including stored Google sign in tokens, contact ${contact()}.</li>
<li>You can remove DashPatrol's access to your Google account at any time at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</li>
</ul>
<h2>Contact</h2><p>Questions: ${contact()}.</p></main>`
  );

export const termsHtml = () =>
  page(
    "DashPatrol terms",
    `<section class="hero"><div class="in"><h1>Terms of use</h1><small>Last updated November 2, 2026.</small></div></section>
<main>
<h2>The service</h2>
<p>DashPatrol is free during early access and is offered as it is. It may change, and features can have mistakes. If paid plans start, you will be told before anything is charged.</p>
<h2>Your site</h2>
<ul>
<li>You confirm you may connect the sites and accounts you add, and allow DashPatrol to change their content within the settings you choose.</li>
<li>You stay responsible for what is published on your site. Review changes on the Content page, where any change the app made to your pages can be undone.</li>
<li>On health and other sensitive topics, have a qualified expert review articles. A "Reviewed by" line is only added when you confirm that review happened.</li>
</ul>
<h2>No guarantees</h2>
<p>Google decides rankings. DashPatrol can't promise any position, traffic or sales.</p>
<h2>Fair use</h2>
<p>No paid links, link schemes or spam. Outreach emails are drafts; you decide whether to send them.</p>
<h2>Contact</h2><p>Questions: ${contact()}.</p></main>`
  );

/** The public home page at the bare domain (dashpatrol.io): the landing page, with the Google data use and policy links. */
export const homeHtml = (appUrl: string) => landingHtml(appUrl, contact());
