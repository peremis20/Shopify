/**
 * The privacy policy and terms, served at /privacy and /terms. Plain words, describing only what the app really
 * does. The contact address comes from SUPPORT_EMAIL; without it the pages point to the sign in email instead.
 */
const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{--ink:#2B2A27;--muted:#6B665C;--bg:#F7F3EC;--line:#E4DDCF}
@media (prefers-color-scheme: dark){:root{--ink:#EDE8DE;--muted:#B5AEA2;--bg:#1C1B19;--line:#3A3833}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 6px}
p,li{color:var(--ink)}small{color:var(--muted)}a{color:inherit}
</style>
</head>
<body><main>${body}</main></body>
</html>`;

const contact = () => {
  const email = (process.env.SUPPORT_EMAIL ?? "").trim();
  return email ? `<a href="mailto:${email}">${email}</a>` : "the person who invited you to the test";
};

export const privacyHtml = () =>
  page(
    "DashPatrol privacy policy",
    `<h1>Privacy policy</h1><small>Last updated November 1, 2026. DashPatrol is in a small test.</small>
<h2>What DashPatrol does</h2>
<p>DashPatrol helps your website rank on Google. It reads your site and its Google data, improves pages, writes articles you allow, and measures what worked.</p>
<h2>What we read</h2>
<ul>
<li>Your Google account email and name, to sign you in.</li>
<li>Google Search Console and Google Analytics data for the sites you connect, read only. If you click Allow, DashPatrol may also resubmit sitemaps already listed in your Search Console so Google looks at changed pages sooner. It never changes anything else there.</li>
<li>Your website's pages, and on Shopify or WordPress the content you let the app change.</li>
</ul>
<h2>How we use it</h2>
<ul>
<li>Only to run DashPatrol for you: planning, improving pages, writing articles, tracking rankings and reporting results.</li>
<li>Page text and search data are sent to AI providers (Anthropic, Groq, GitHub Models or Google Gemini) to write and check changes, to serper.dev to look up Google results, to Open PageRank for public site strength scores, and to Resend to email you.</li>
<li>Each site is worked on with its own data only. Your data is never shared with other customers, never sold, and never used for ads.</li>
<li>DashPatrol's use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.</li>
</ul>
<h2>Where it is kept</h2>
<p>In a database hosted by Neon. Google sign in tokens are stored encrypted.</p>
<h2>Your choices</h2>
<ul>
<li>Disconnect Google, your store or your site at any time in Settings; DashPatrol then stops reading it.</li>
<li>Undo any change the app made from the Content page.</li>
<li>Turn emails off in Autopilot settings.</li>
<li>To have your data deleted, contact ${contact()}.</li>
</ul>
<h2>Contact</h2><p>Questions: ${contact()}.</p>`
  );

export const termsHtml = () =>
  page(
    "DashPatrol terms",
    `<h1>Terms of use</h1><small>Last updated November 1, 2026. DashPatrol is in a small, free test.</small>
<h2>The test</h2>
<p>DashPatrol is offered free during this test, as it is, and may change or stop. Features can have mistakes.</p>
<h2>Your site</h2>
<ul>
<li>You confirm you may connect the sites and accounts you add, and allow DashPatrol to change their content within the settings you choose.</li>
<li>You stay responsible for what is published on your site. Review changes on the Content page; any change can be undone there.</li>
<li>On health and other sensitive topics, have a qualified expert review articles. A "Reviewed by" line is only added when you confirm that review happened.</li>
</ul>
<h2>No guarantees</h2>
<p>Google decides rankings. DashPatrol can't promise any position, traffic or sales.</p>
<h2>Fair use</h2>
<p>No paid links, link schemes or spam. Outreach emails are drafts; you decide whether to send them.</p>
<h2>Contact</h2><p>Questions: ${contact()}.</p>`
  );
