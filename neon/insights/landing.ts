/**
 * The public landing page at the bare domain (dashpatrol.io). It sells the outcome (time saved, money kept, growth on
 * autopilot) and only claims what the app really does: no invented numbers, testimonials or ranking promises.
 * Google's app reviewers read it too, so the Google data section and the policy links stay on the page.
 */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The public site's address (dashpatrol.io) worked out from the app's (app.dashpatrol.io). Empty when there is none. */
export const homeOf = (appUrl: string) => (/^https:\/\/app\./i.test(appUrl) ? appUrl.replace(/^https:\/\/app\./i, "https://") : "");

/** Header, menu and footer shared by every public page, so the home page, privacy and terms all look and link the same. */
export const CHROME_CSS = `
[id]{scroll-margin-top:76px}
.sitenav{position:sticky;top:0;z-index:20;background:#0B3B22;color:#fff}
.sitenav .wrap{display:flex;align-items:center;justify-content:space-between;height:64px;max-width:1120px;margin:0 auto;padding:0 20px}
.sitenav .logo{font-family:"Plus Jakarta Sans",Inter,system-ui,sans-serif;font-weight:800;font-size:22px;color:#fff;text-decoration:none;display:flex;align-items:center;gap:8px}
.sitenav .logo i{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:#3DCB5A;color:#0B3B22;font-style:normal;font-weight:800;font-size:18px}
.sitenav .links{display:flex;gap:22px;align-items:center;font:500 15px Inter,system-ui,sans-serif}
.sitenav .links a{color:rgba(255,255,255,.85);text-decoration:none}
.sitenav .links a:hover{color:#fff}
.sitenav .cta{display:inline-flex;align-items:center;padding:10px 18px;border-radius:12px;font-weight:700;text-decoration:none}
.sitenav .cta.signin{border:1.5px solid rgba(255,255,255,.7);color:#fff}
.sitenav .cta.start{background:#9BE23C;color:#0B2E18 !important}
.sitenav .menu{display:none;position:relative;background:none;border:none;padding:0;border-radius:0}
.sitenav .menu summary::after{content:none !important}
.sitenav .menu summary{list-style:none;cursor:pointer;width:44px;height:44px;border-radius:12px;border:1.5px solid rgba(255,255,255,.5);display:flex;align-items:center;justify-content:center}
.sitenav .menu summary::-webkit-details-marker{display:none}
.sitenav .menu summary span,.sitenav .menu summary span::before,.sitenav .menu summary span::after{display:block;width:18px;height:2px;background:#fff;border-radius:2px;position:relative}
.sitenav .menu summary span::before,.sitenav .menu summary span::after{content:"";position:absolute;left:0}
.sitenav .menu summary span::before{top:-6px}.sitenav .menu summary span::after{top:6px}
.sitenav .menu[open] summary span{background:transparent}
.sitenav .menu[open] summary span::before{top:0;transform:rotate(45deg)}
.sitenav .menu[open] summary span::after{top:0;transform:rotate(-45deg)}
.sitenav .menu nav{position:absolute;right:0;top:54px;width:240px;background:#0B3B22;border:1px solid rgba(255,255,255,.15);border-radius:16px;padding:10px;display:grid;gap:2px;box-shadow:0 20px 40px rgba(0,0,0,.3)}
.sitenav .menu nav a{color:#fff;text-decoration:none;padding:11px 12px;border-radius:10px;font:500 16px Inter,system-ui,sans-serif}
.sitenav .menu nav a:hover{background:rgba(255,255,255,.08)}
.sitenav .menu nav a.start{background:#9BE23C;color:#0B2E18;text-align:center;font-weight:700;margin-top:6px}
.sitefoot{background:#0A3520;color:rgba(255,255,255,.8);font:15px/1.6 Inter,system-ui,sans-serif;padding:48px 0 28px;margin-top:0}
.sitefoot .wrap{max-width:1120px;margin:0 auto;padding:0 20px}
.sitefoot .cols{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:28px}
.sitefoot .logo{font-family:"Plus Jakarta Sans",Inter,system-ui,sans-serif;font-weight:800;font-size:22px;color:#fff;text-decoration:none;display:inline-flex;align-items:center;gap:8px}
.sitefoot .logo i{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;background:#3DCB5A;color:#0B3B22;font-style:normal;font-weight:800;font-size:16px}
.sitefoot h4{color:#C6F432;font-size:13px;letter-spacing:.08em;text-transform:uppercase;margin:0 0 10px}
.sitefoot p,.sitefoot li{color:inherit}
.sitefoot a{color:rgba(255,255,255,.85);text-decoration:none}
.sitefoot a:hover{color:#fff;text-decoration:underline}
.sitefoot ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.sitefoot .base{border-top:1px solid rgba(255,255,255,.15);margin-top:32px;padding-top:18px;font-size:13.5px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
@media (max-width:900px){.sitenav .links{display:none}.sitenav .menu{display:block}.sitefoot .cols{grid-template-columns:1fr 1fr}}
@media (max-width:520px){.sitefoot .cols{grid-template-columns:1fr}}
`;

export function siteNav(appUrl: string, home: string): string {
  const a = esc(appUrl), h = esc(home);
  const links = !home ? "" : `<a href="${h}/#benefits">Benefits</a><a href="${h}/#see">Features</a><a href="${h}/#how">How It Works</a><a href="${h}/#pricing">Pricing</a><a href="${h}/#faq">FAQ</a>`;
  return `<header class="sitenav"><div class="wrap">
<a class="logo" href="${h}/"><i>D</i>DashPatrol</a>
<div class="links">${links}<a class="cta signin" href="${a}">Sign In</a><a class="cta start" href="${a}">Start Free</a></div>
<details class="menu"><summary aria-label="Menu"><span></span></summary><nav>${links}<a href="${a}">Sign In</a><a class="start" href="${a}">Start Free</a></nav></details>
<script>(function(){var d=document.currentScript.previousElementSibling;d.addEventListener("click",function(e){if(e.target.closest&&e.target.closest("nav a"))d.removeAttribute("open");});document.addEventListener("click",function(e){if(!d.contains(e.target))d.removeAttribute("open");});})();</script>
</div></header>`;
}

export function siteFooter(appUrl: string, home: string, contactHtml: string): string {
  const a = esc(appUrl), h = esc(home);
  return `<footer class="sitefoot"><div class="wrap">
<div class="cols">
<div><a class="logo" href="${h}/"><i>D</i>DashPatrol</a><p style="margin:12px 0 0;max-width:300px">Your SEO team in one app. Grow your business on Google, on autopilot.</p></div>
<div><h4>Product</h4><ul><li><a href="${h}/#benefits">Benefits</a></li><li><a href="${h}/#see">Features</a></li><li><a href="${h}/#how">How It Works</a></li><li><a href="${h}/#calc">Savings</a></li><li><a href="${h}/#pricing">Pricing</a></li><li><a href="${h}/#faq">FAQ</a></li></ul></div>
<div><h4>Get started</h4><ul><li><a href="${a}">Start Free</a></li><li><a href="${a}">Sign In</a></li><li><a href="${h}/#google">How we use Google data</a></li></ul></div>
<div><h4>Company</h4><ul><li><a href="${h}/privacy">Privacy policy</a></li><li><a href="${h}/terms">Terms of use</a></li><li>Contact: ${contactHtml}</li></ul></div>
</div>
<div class="base"><span>&copy; ${new Date().getUTCFullYear()} DashPatrol</span><span>Free during early access</span></div>
</div></footer>`;
}

const icon = (d: string) =>
  `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  clock: icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  coin: icon('<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .9-3 2s1.3 1.7 3 2 3 .9 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6.5v11"/>'),
  bolt: icon('<path d="M13 3 5 13h6l-1 8 8-10h-6l1-8z"/>'),
  chart: icon('<path d="M4 19h16"/><path d="M6 15l4-4 3 3 5-6"/><path d="M15 8h3v3"/>'),
  gem: icon('<path d="M6 4h12l3 5-9 11L3 9z"/><path d="M3 9h18M9 4l3 16M15 4l-3 16"/>'),
  shield: icon('<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
  check: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};


const art = {
  cal: `<svg viewBox="0 0 96 96" aria-hidden="true"><rect x="12" y="18" width="70" height="64" rx="10" fill="#fff" stroke="#1E7A3E" stroke-width="3"/><rect x="12" y="18" width="70" height="18" rx="9" fill="#2FA84F"/><rect x="26" y="10" width="6" height="16" rx="3" fill="#145C2E"/><rect x="62" y="10" width="6" height="16" rx="3" fill="#145C2E"/><path d="M24 50l5 5 9-10M24 68l5 5 9-10M52 50l5 5 9-10" fill="none" stroke="#2FA84F" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><rect x="52" y="64" width="16" height="8" rx="3" fill="#CFEFD6"/></svg>`,
  coins: `<svg viewBox="0 0 96 96" aria-hidden="true"><g fill="#F5B700" stroke="#C98A00" stroke-width="2.5"><ellipse cx="38" cy="72" rx="22" ry="8"/><path d="M16 64v8c0 4.4 9.8 8 22 8s22-3.6 22-8v-8"/><ellipse cx="38" cy="58" rx="22" ry="8"/><path d="M16 50v8c0 4.4 9.8 8 22 8s22-3.6 22-8v-8"/><ellipse cx="38" cy="44" rx="22" ry="8"/><path d="M16 36v8c0 4.4 9.8 8 22 8s22-3.6 22-8v-8"/><ellipse cx="38" cy="30" rx="22" ry="8"/></g><circle cx="68" cy="62" r="20" fill="#FFCA28" stroke="#C98A00" stroke-width="3"/><text x="68" y="70" text-anchor="middle" font-size="22" font-weight="800" fill="#B07400" font-family="Arial">$</text></svg>`,
  rocket: `<svg viewBox="0 0 96 96" aria-hidden="true"><path d="M62 14c10 0 18 2 20 4 2 2 4 10 4 20-6 16-20 30-30 36l-16-16c6-10 20-24 22-44z" fill="#E9F7EC" stroke="#1E7A3E" stroke-width="3"/><circle cx="64" cy="34" r="8" fill="#2FA84F" stroke="#145C2E" stroke-width="3"/><path d="M40 58l-14 2-8 12 18-4zM56 74l-2 14-12 8 4-18z" fill="#2FA84F" stroke="#145C2E" stroke-width="2.5" stroke-linejoin="round"/><path d="M34 66c-6 2-12 8-14 20 12-2 18-8 20-14z" fill="#FFB300" stroke="#E65100" stroke-width="2"/></svg>`,
  bars: `<svg viewBox="0 0 96 96" aria-hidden="true"><rect x="14" y="58" width="14" height="26" rx="3" fill="#2FA84F"/><rect x="34" y="46" width="14" height="38" rx="3" fill="#25913F"/><rect x="54" y="34" width="14" height="50" rx="3" fill="#1E7A3E"/><rect x="74" y="22" width="14" height="62" rx="3" fill="#145C2E"/><path d="M12 44l22-14 14 8 28-24" fill="none" stroke="#2FA84F" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M66 12h12v12" fill="none" stroke="#2FA84F" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  report: `<svg viewBox="0 0 96 96" aria-hidden="true"><rect x="22" y="10" width="58" height="76" rx="8" fill="#F1F6FF" stroke="#9DB4D8" stroke-width="2.5"/><rect x="12" y="20" width="58" height="70" rx="8" fill="#fff" stroke="#9DB4D8" stroke-width="2.5"/><circle cx="34" cy="44" r="12" fill="#4C8DF6"/><path d="M34 32a12 12 0 0 1 12 12H34z" fill="#2FA84F"/><path d="M34 44l-8.5 8.5A12 12 0 0 1 22 44z" fill="#F5B700"/><rect x="50" y="36" width="14" height="4" rx="2" fill="#9DB4D8"/><rect x="50" y="46" width="10" height="4" rx="2" fill="#9DB4D8"/><rect x="22" y="64" width="40" height="4" rx="2" fill="#9DB4D8"/><rect x="22" y="74" width="30" height="4" rx="2" fill="#9DB4D8"/></svg>`,
  shield: `<svg viewBox="0 0 96 96" aria-hidden="true"><path d="M48 8l32 12v24c0 20-14 36-32 42C30 80 16 64 16 44V20z" fill="#2FA84F" stroke="#145C2E" stroke-width="3"/><path d="M48 18l22 8v18c0 14-9 26-22 31-13-5-22-17-22-31V26z" fill="#57C46F"/><path d="M36 46l9 9 16-18" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const benefits: [string, string, string, string][] = [
  [I.clock, art.cal, "Get Your Hours Back", "No more guessing which keywords to chase, rewriting product pages at midnight or learning another SEO tool. DashPatrol does the research, the writing and the checking for you, every week."],
  [I.coin, art.coins, "Keep More of Your Money", "No agency retainer, no freelancer to manage, no pile of subscriptions. One app does the weekly SEO work for you, and it is free while we are in early access."],
  [I.bolt, art.rocket, "Growth on Autopilot", "Connect your site once. From then on DashPatrol plans, improves pages, publishes the articles you allow, adds internal links and checks your rankings through the week, with little of your time."],
  [I.chart, art.bars, "Real Growth, Measured", "Every change is tracked against your real Search Console and Analytics numbers. What helps is kept. What doesn't is undone. Your traffic grows on facts, not hunches."],
  [I.gem, art.report, "Value You Can See", "Plain weekly reports show what was done, what moved and what it brought in: visits, searches and sales from Google, in words anyone can read."],
  [I.shield, art.shield, "Safe by Design", "A second AI double checks every article and every plan before it counts. Every change the app makes to your pages can be undone in one click, and your data is only ever used for your own site."],
];

const steps: [string, string][] = [
  ["Sign in with Google", "One click. DashPatrol reads your Search Console and Analytics so it starts from your real numbers."],
  ["Connect your site", "Shopify, WordPress, Webflow, Wix, or any website with a small snippet. Missing Search Console or Analytics? Click Set it up for me and it is done."],
  ["DashPatrol gets to work", "Each week it plans from your data, fixes the pages that are close to page one, writes new articles, adds links and looks for backlink chances."],
  ["Watch it grow", "Rankings are checked through the week. Results land in your inbox. You only step in for the few things that truly need a person."],
];

const weekly = [
  "Finds the searches you almost rank for and goes after the easy wins first",
  "Rewrites titles, descriptions and page text so more people click",
  "Writes new articles that read like a person wrote them, checked by a second AI",
  "Adds internal links so Google understands and values your best pages",
  "Spots broken links and pages that stopped working, and repairs what it can",
  "Finds backlink chances and drafts the outreach for you to send",
  "Checks your positions through the week and rescues pages that slip",
  "Follows your sales from search so it builds on what makes you money",
];

const compare: [string, boolean | string, boolean | string, boolean | string][] = [
  ["Works every week without reminders", false, "Varies", true],
  ["Uses your own Search Console and Analytics data", "If you know how", "Varies", true],
  ["Changes your pages for you", "Your time", true, true],
  ["Measures each change and undoes what fails", false, "Varies", true],
  ["Every change it makes undoable in one click", false, "Varies", true],
  ["Plain reports anyone can read", false, "Varies", true],
  ["Monthly retainer", "None, but your evenings", "Yes", "Free in early access"],
];

const faq: [string, string][] = [
  ["Do I need to know SEO?", "No. DashPatrol is made for business owners, not SEO experts. The simple view tells you what happened in plain words. If you love data, the Advanced view shows everything."],
  ["What does it cost?", "DashPatrol is free during early access. If paid plans start, you will be told before anything is charged."],
  ["Will it change my site without asking?", "It only changes what you allow in your settings. Every change the app makes is logged on the Content page and can be undone in one click."],
  ["Can you promise I will rank number one?", "No one honest can. Google decides rankings. What DashPatrol promises is steady, measured work every week, starting with the searches you can win soonest and building from there."],
  ["Which websites does it work with?", "Shopify, WordPress, Webflow and Wix connect directly. Any other website works through a small snippet, or with a fix list you can paste in."],
  ["Is my data safe?", "Your data is used only to run DashPatrol for your own site. It is never sold, never shared with other customers and never used for ads. Access keys are stored encrypted."],
];

const cell = (v: boolean | string) =>
  v === true ? `<span class="yes">${I.check}</span>` : v === false ? `<span class="no">${I.x}</span>` : `<span class="txt">${esc(v)}</span>`;

export function landingHtml(appUrl: string, contactHtml: string): string {
  const app = esc(appUrl);
  const home = homeOf(appUrl);
  const cta = (label: string, cls = "btn") => `<a class="${cls}" href="${app}">${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DashPatrol: grow your business on autopilot</title>
<meta name="description" content="DashPatrol grows your search traffic on autopilot. It plans from your real Google data, improves your pages, writes articles and measures every change, so you save time and money while your business grows.">
<meta property="og:title" content="DashPatrol: grow your business on autopilot">
<meta property="og:description" content="Your SEO team in one app. Save time, save money, and let your site grow from Google while you run your business.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,500;0,700;0,800;1,800&family=Inter:wght@400;500;600;700&display=swap">
<style>
:root{--ink:#1F2A22;--muted:#5C6660;--bg:#F7F3EC;--card:#FFFFFF;--line:#E4DDCF;--brand:#16442B;--brand2:#1F6B43;--accent:#E8B04B;--soft:#EAF2EC;--on:#FFFFFF}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--ink:#ECE8DF;--muted:#AEB5AF;--bg:#141815;--card:#1C221E;--line:#2E3631;--brand:#3E9C68;--brand2:#5BB884;--accent:#E8B04B;--soft:#1F2C24;--on:#0D140F}}
:root[data-theme="dark"]{--ink:#ECE8DF;--muted:#AEB5AF;--bg:#141815;--card:#1C221E;--line:#2E3631;--brand:#3E9C68;--brand2:#5BB884;--accent:#E8B04B;--soft:#1F2C24;--on:#0D140F}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
h1,h2,h3{font-family:Fraunces,Georgia,serif;line-height:1.15;margin:0;font-weight:600;letter-spacing:-.01em}
h1{font-size:clamp(36px,6vw,64px)}
h2{font-size:clamp(28px,4vw,42px)}
h3{font-size:20px}
p{margin:0}
.muted{color:var(--muted)}
.eyebrow{display:inline-block;font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--brand2)}
.btn{display:inline-flex;align-items:center;gap:8px;padding:15px 26px;border-radius:14px;background:var(--brand);color:var(--on);text-decoration:none;font-weight:600;font-size:17px;box-shadow:0 6px 20px rgba(22,68,43,.25);transition:transform .15s,box-shadow .15s}
.btn:hover{transform:translateY(-2px);box-shadow:0 10px 26px rgba(22,68,43,.32)}
.btn.ghost{background:transparent;color:var(--ink);box-shadow:none;border:1.5px solid var(--line)}
.btn.ghost:hover{border-color:var(--brand2)}
.logo{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:22px;text-decoration:none;display:flex;align-items:center;gap:8px}
.logo i{display:inline-block;width:26px;height:26px;border-radius:8px;background:var(--brand);position:relative}
.logo i::after{content:"";position:absolute;inset:7px;border:2.5px solid var(--accent);border-radius:50%}
.hero{padding:80px 0 64px;text-align:center}
.hero p.lead{font-size:clamp(18px,2.2vw,22px);max-width:720px;margin:22px auto 0;color:var(--muted)}
.hero .ctas{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-top:34px}
.hero .note{margin-top:14px;font-size:14px;color:var(--muted)}
.pills{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:40px}
.pill{background:var(--card);border:1px solid var(--line);padding:8px 14px;border-radius:999px;font-size:14px;display:flex;gap:6px;align-items:center}
.pill .yes{color:var(--brand2);display:flex}
section{padding:72px 0}
.center{text-align:center;max-width:720px;margin:0 auto}
.center p{margin-top:14px;color:var(--muted);font-size:18px}
.grid{display:grid;gap:20px;margin-top:44px;grid-template-columns:repeat(3,1fr)}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px}
.card .ic{width:50px;height:50px;border-radius:14px;background:var(--soft);color:var(--brand2);display:flex;align-items:center;justify-content:center;margin-bottom:16px}
.card p{color:var(--muted);margin-top:8px;font-size:16px}
.band{background:#16442B;color:#fff}
.band .eyebrow{color:var(--accent)}
.band .center p{color:rgba(255,255,255,.82)}
.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;margin-top:44px;counter-reset:s}
.step{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-radius:20px;padding:26px}
.step::before{counter-increment:s;content:counter(s);display:flex;width:36px;height:36px;border-radius:50%;background:var(--accent);color:#1F2A22;font-weight:700;align-items:center;justify-content:center;margin-bottom:14px}
.step p{color:rgba(255,255,255,.8);margin-top:8px;font-size:15.5px}
.split{display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:center}
.list{list-style:none;padding:0;margin:0;display:grid;gap:14px}
.list li{display:flex;gap:12px;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;font-size:16px}
.list li .yes{color:var(--brand2);flex:none;margin-top:2px;display:flex}
.quote{font-family:Fraunces,Georgia,serif;font-size:clamp(24px,3vw,32px);line-height:1.3}
.quote em{color:var(--brand2);font-style:normal}
.tablewrap{overflow-x:auto;margin-top:40px;border-radius:20px;border:1px solid var(--line);background:var(--card)}
table{width:100%;border-collapse:collapse;min-width:620px}
th,td{padding:16px 18px;text-align:center;border-bottom:1px solid var(--line);font-size:15.5px}
th:first-child,td:first-child{text-align:left}
tr:last-child td{border-bottom:none}
th{font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600}
th.us,td.us{background:var(--soft)}
th.us{color:var(--brand2)}
.yes{color:var(--brand2)}.no{color:#B4523F}.txt{color:var(--muted);font-size:14px}
td .yes,td .no{display:inline-flex}
.faq{max-width:780px;margin:40px auto 0;display:grid;gap:12px}
details{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 22px}
summary{cursor:pointer;font-weight:600;list-style:none;display:flex;justify-content:space-between;gap:16px}
summary::-webkit-details-marker{display:none}
summary::after{content:"+";color:var(--brand2);font-size:22px;line-height:1}
details[open] summary::after{content:"\\00D7"}
details p{margin-top:10px;color:var(--muted)}
.final{text-align:center;background:linear-gradient(135deg,#16442B,#1F6B43);color:#fff;border-radius:28px;padding:64px 24px}
.final p{color:rgba(255,255,255,.85);max-width:620px;margin:16px auto 30px;font-size:18px}
.final .btn{background:var(--accent);color:#1F2A22}
.google{font-size:15px}
.google ul{margin:12px 0 0;padding-left:20px;color:var(--muted)}
.google li{margin-top:6px}
.hero{text-align:left;padding:64px 0 56px}
.hero .grid2{display:grid;grid-template-columns:1.05fr 1fr;gap:48px;align-items:center}
.hero p.lead{margin:22px 0 0}
.hero .ctas,.hero .pills{justify-content:flex-start}
.mock{background:var(--card);border:1px solid var(--line);border-radius:22px;box-shadow:0 30px 60px rgba(22,68,43,.16);overflow:hidden;position:relative}
.mock .bar{display:flex;align-items:center;gap:6px;padding:12px 14px;border-bottom:1px solid var(--line);font-size:12px;color:var(--muted)}
.mock .bar b{width:10px;height:10px;border-radius:50%;background:var(--line);display:inline-block}
.mock .bar span{margin-left:8px}
.mock .body{padding:18px}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.kpi{background:var(--soft);border-radius:14px;padding:12px}
.kpi small{display:block;font-size:11.5px;color:var(--muted)}
.kpi strong{display:block;font-size:22px;font-family:Fraunces,Georgia,serif;margin-top:2px}
.kpi em{font-style:normal;font-size:12px;color:var(--brand2);font-weight:600}
.chart{margin-top:14px;background:var(--bg);border-radius:14px;padding:12px 12px 4px}
.chart small{font-size:12px;color:var(--muted)}
.chart svg{display:block;width:100%;height:auto}
.draw{stroke-dasharray:1200;stroke-dashoffset:1200;animation:draw 2.6s ease-out .3s forwards}
.fillin{opacity:0;animation:fade 1.2s ease-out 1.6s forwards}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes fade{to{opacity:1}}
.feed{margin-top:14px;display:grid;gap:8px;min-height:132px}
.feed div{display:flex;gap:10px;align-items:center;font-size:13.5px;background:var(--bg);border-radius:12px;padding:9px 12px;animation:slide .5s ease-out both}
.feed i{flex:none;width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:13px;background:var(--soft);color:var(--brand2)}
.feed span{flex:1}
.feed time{font-size:11.5px;color:var(--muted)}
@keyframes slide{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.sample{position:absolute;top:12px;right:14px;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;background:var(--accent);color:#1F2A22;padding:3px 8px;border-radius:999px;font-weight:700}
.float{position:absolute;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px 14px;box-shadow:0 12px 30px rgba(0,0,0,.12);font-size:13px;display:flex;gap:8px;align-items:center;animation:bob 4s ease-in-out infinite}
.float .yes{display:flex}
@keyframes bob{50%{transform:translateY(-8px)}}
.mockwrap{position:relative;padding:18px 0}
.f1{left:-12px;bottom:4px}.f2{right:-18px;top:-6px;animation-delay:1.5s}
.visual{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:44px}
.serp{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:24px}
.serp .tag{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
.serp .tag{font-size:13px}.serp .old .tag{color:#E0674F}.serp .new .tag{color:var(--brand2)}
.result{margin-top:10px;padding:16px;border-radius:14px;background:#FFFFFF;border:1px solid #E3E8E5;box-shadow:0 4px 14px rgba(0,0,0,.06)}
.result cite{display:block;font-style:normal;font-size:13px;color:#4D5156}
.result b{display:block;color:#1A0DAB;font-weight:500;font-size:18px;margin:4px 0}
.result p{font-size:14.5px;line-height:1.5;color:#3C4043}
.serp .new .result{outline:3px solid #3DCB5A;outline-offset:0}
.arrow{text-align:center;color:var(--brand2);font-size:20px;font-weight:700;margin:10px 0}
.ranks{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:24px}
.rank{display:grid;grid-template-columns:1fr 150px 44px;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);font-size:14.5px}
.rank:last-child{border-bottom:none}
.track{height:10px;border-radius:999px;background:var(--bg);overflow:hidden}
.track i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--brand2),var(--accent));width:var(--w);transition:width 1.6s cubic-bezier(.2,.8,.2,1)}
.js #ranks:not(.in) .track i{width:0}
.rank strong{text-align:right;font-family:Fraunces,Georgia,serif;font-size:18px}
.rank small{display:block;color:var(--muted);font-size:12px}
.note2{font-size:12.5px;color:var(--muted);margin-top:14px}
.week{display:grid;grid-template-columns:repeat(7,1fr);gap:12px;margin-top:44px}
.day{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-radius:18px;padding:18px 14px;min-height:150px}
.day h4{margin:0 0 10px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.day p{font-size:14px;color:rgba(255,255,255,.85);margin-top:6px;display:flex;gap:6px}
.day.rest{background:transparent;border-style:dashed}
.calc{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:40px;align-items:stretch}
.calc .in{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px;display:grid;gap:22px}
.calc label{display:block;font-weight:600;font-size:15px}
.calc label output{float:right;color:var(--brand2);font-family:"Plus Jakarta Sans",Inter,sans-serif;font-weight:800;font-size:20px}
.calc input[type=range]{width:100%;margin-top:10px;accent-color:var(--brand2)}
.calc .out{background:linear-gradient(135deg,#16442B,#1F6B43);color:#fff;border-radius:20px;padding:28px;display:grid;gap:18px;align-content:center}
.calc .out div small{display:block;color:rgba(255,255,255,.75);font-size:14px}
.calc .out div strong{display:block;font-family:Fraunces,Georgia,serif;font-size:clamp(34px,5vw,48px);line-height:1.1}
.calc .out p{font-size:13px;color:rgba(255,255,255,.7)}
.reveal{opacity:1}
.js .reveal{opacity:0;transform:translateY(24px);transition:opacity .7s ease,transform .7s ease}
.js .reveal.in{opacity:1;transform:none}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}.feed div{animation:none}.track i{transition:none}.draw{animation:none;stroke-dashoffset:0}.fillin{animation:none;opacity:1}.float{animation:none}.js .reveal{opacity:1;transform:none;transition:none}}
@media (max-width:900px){.hero .grid2,.visual,.calc{grid-template-columns:1fr}.week{grid-template-columns:repeat(4,1fr)}.f1{left:8px}.f2{right:8px}}
@media (max-width:640px){.week{grid-template-columns:1fr 1fr}.kpi strong{font-size:18px}.rank{grid-template-columns:1fr 90px 36px}}
@media (max-width:900px){.grid{grid-template-columns:1fr 1fr}.steps{grid-template-columns:1fr 1fr}.split{grid-template-columns:1fr;gap:32px}}
@media (max-width:640px){.wrap{padding:0 16px}.grid,.steps{grid-template-columns:1fr}.hero{padding:56px 0 40px}section{padding:56px 0}.final{padding:48px 20px}}
/* v3 look */
:root{--brand:#0F5A32;--accent:#C6F432;--soft:#E7F6EA;--bg:#F5FAF6;--line:#DDE9E0;--ink:#0E2A1A}
:root:not([data-theme="dark"]){--brand2:#17703A}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--brand2:#5BB884}}
:root[data-theme="dark"]{--brand2:#5BB884}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#0F1712;--card:#16211A;--line:#24352A;--soft:#1A2E21;--ink:#E8F2EA;--muted:#A7B8AC}}
:root[data-theme="dark"]{--bg:#0F1712;--card:#16211A;--line:#24352A;--soft:#1A2E21;--ink:#E8F2EA;--muted:#A7B8AC}
h1,h2,h3,.logo,.kpi strong,.quote,.calc .out div strong,.rank strong{font-family:"Plus Jakarta Sans",Inter,system-ui,sans-serif;font-weight:800;letter-spacing:-.02em}
.eyebrow{color:var(--brand2);font-weight:800}
.logo{color:#fff}
.logo i{background:#3DCB5A;color:#0B3B22;font-style:normal;font-weight:800;display:inline-flex;align-items:center;justify-content:center;font-size:18px;width:30px;height:30px}
.logo i::after{display:none}
.btn.lime{background:#9BE23C;color:#0B2E18;box-shadow:0 8px 24px rgba(155,226,60,.35)}
.btn.lime:hover{box-shadow:0 12px 30px rgba(155,226,60,.5)}
.btn.signin{background:transparent;border:1.5px solid rgba(255,255,255,.7);color:#fff;box-shadow:none}
.btn.big{padding:17px 30px;font-size:18px}
.btn.outline{background:transparent;border:1.5px solid rgba(255,255,255,.75);color:#fff;box-shadow:none}
.btn.outline.dark{border-color:var(--line);color:var(--ink)}
.play{display:inline-flex;width:22px;height:22px;border:1.5px solid currentColor;border-radius:50%;align-items:center;justify-content:center;font-size:9px}
.hero{background:radial-gradient(1200px 600px at 80% 10%,#16803F 0%,transparent 60%),linear-gradient(160deg,#0A3520 0%,#0E4A2A 55%,#12602F 100%);color:#fff;position:relative;padding:72px 0 140px;overflow:hidden}
.hero p.lead{color:rgba(255,255,255,.9)}
.center{max-width:900px}
.hero h1{font-size:clamp(40px,6vw,72px);line-height:1.04}
.hl{color:#C6F432;font-style:italic;position:relative;display:inline-block}
.hl::after{content:"";position:absolute;left:4%;right:6%;bottom:-6px;height:8px;border-radius:8px;background:#9BE23C;transform:rotate(-2deg)}
.chip{display:inline-block;background:#1E8A45;color:#E9FFD9;font-size:13px;font-weight:700;letter-spacing:.06em;padding:8px 16px;border-radius:999px}
.hero .note{display:flex;gap:18px;flex-wrap:wrap;color:rgba(255,255,255,.8)}
.hero .note span{white-space:nowrap}
.pill{background:#fff;color:#1F2A22;border:none;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.12)}
.pill b{display:inline-flex;width:20px;height:20px;border-radius:6px;color:#fff;font-size:11px;align-items:center;justify-content:center}
.mockwrap{transform:perspective(1400px) rotateY(-6deg) rotateX(3deg)}
.mock{border:none;border-radius:24px;box-shadow:0 40px 80px rgba(0,0,0,.35),0 0 0 8px rgba(155,226,60,.25);color:#1F2A22;background:#fff}
.mock .bar{border-color:#EEF2EF;color:#7A867E}
.mock .bar b:nth-child(1){background:#FF6159}.mock .bar b:nth-child(2){background:#FFBD2E}.mock .bar b:nth-child(3){background:#28C941}
.sample{background:#EEF6F0;color:#17703A;font-weight:600;text-transform:none;letter-spacing:0;font-size:11.5px}
.kpi{background:#fff;border:1px solid #E5EEE7;box-shadow:0 4px 12px rgba(0,0,0,.04)}
.kpi .kic{font-size:16px}
.kpi small{color:#6B7A70}.kpi strong{font-size:24px;color:#0E2A1A}
.kpi em{color:#17703A}
.chart{background:#fff;border:1px solid #E5EEE7;position:relative}
.chart small{color:#334}
.up{position:absolute;top:12px;right:14px;background:#0F5A32;color:#fff;border-radius:12px;padding:6px 12px;font-weight:800;font-size:15px;box-shadow:0 0 0 4px rgba(155,226,60,.35);line-height:1.1}
.up small{display:block;font-size:11px;color:#C6F432;font-weight:600}
.feed div{background:#F6F9F7;color:#1F2A22}
.feed time{color:#7A867E}
.spark{position:absolute;left:-26px;top:-10px;width:44px;height:44px;background:conic-gradient(from 0deg,transparent 0 20deg,#F7D14A 20deg 32deg,transparent 32deg 80deg,#F7D14A 80deg 92deg,transparent 92deg 140deg,#F7D14A 140deg 152deg,transparent 152deg);border-radius:50%;-webkit-mask:radial-gradient(circle,transparent 9px,#000 10px);mask:radial-gradient(circle,transparent 9px,#000 10px)}
.wave{position:absolute;left:0;right:0;bottom:-1px;width:100%;height:120px}
#benefits{padding-top:40px}
.uline{position:relative;display:inline-block}
.uline::after{content:"";position:absolute;left:0;right:0;bottom:-4px;height:6px;border-radius:6px;background:#3DCB5A;transform:rotate(-1.5deg)}
.bcard{display:flex;gap:12px;align-items:center;justify-content:space-between;background:linear-gradient(135deg,var(--card) 55%,var(--soft));transition:transform .2s,box-shadow .2s}
.bcard:hover{transform:translateY(-4px);box-shadow:0 18px 40px rgba(15,90,50,.12)}
.bcard .ic2{color:#1E8A45;margin-bottom:10px}
.bcard .pic{flex:none;width:78px;height:78px;align-self:flex-start;margin-top:6px}
.bcard p{font-size:15px}
.bcard .pic svg{width:100%;height:100%}
.stats{background:linear-gradient(120deg,#0A3520,#0F5A32);color:#fff;position:relative;padding:88px 0 64px}
.stats .wave.top{position:absolute;top:-1px;left:0;width:100%;height:50px;transform:rotate(180deg)}
.statgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:0}
.statgrid>div{display:flex;gap:14px;align-items:center;padding:8px 22px;border-left:1px solid rgba(255,255,255,.18)}
.statgrid>div:first-child{border-left:none}
.sic{font-size:34px;filter:saturate(1.2)}
.statgrid p{color:rgba(255,255,255,.85);font-size:14.5px;line-height:1.35}
.statgrid strong{display:block;font-family:"Plus Jakarta Sans",Inter,sans-serif;font-weight:800;font-size:30px;color:#fff}
#see{padding-top:72px}
.band{background:linear-gradient(160deg,#0A3520,#0F5A32)}
.band .eyebrow{color:#C6F432}
.step::before{background:#9BE23C}
.day h4{color:#C6F432}
.calc .out{background:linear-gradient(135deg,#0A3520,#1E8A45)}
th.us{color:var(--brand2)}
.final2{display:grid;grid-template-columns:.9fr 1.1fr;gap:40px;align-items:center;background:linear-gradient(135deg,var(--card),var(--soft));border:1px solid var(--line);border-radius:28px;padding:40px}
.final2 h2{font-size:clamp(30px,4vw,44px)}
.final2 p{color:var(--muted);font-size:18px;margin:14px 0 26px}
.final2 .btn.big{background:#0F5A32;color:#fff}
.laptop svg{width:100%;height:auto}
.final2 .ctas{display:flex;gap:14px;flex-wrap:wrap}
@media (max-width:900px){.statgrid{grid-template-columns:1fr 1fr;row-gap:22px}.statgrid>div:nth-child(3){border-left:none}.final2{grid-template-columns:1fr}.mockwrap{transform:none}.hero{padding-bottom:110px}}
@media (max-width:640px){.statgrid{grid-template-columns:1fr}.statgrid>div{border-left:none}.bcard .pic{width:72px;height:72px}.hero .note{gap:8px 14px;font-size:13px}.spark{display:none}}
@media (prefers-reduced-motion:reduce){.bcard{transition:none}}
${CHROME_CSS}
</style>
</head>
<body>
${siteNav(appUrl, home)}

<header class="hero"><div class="wrap grid2">
<div>
<span class="chip">YOUR SEO TEAM, IN ONE APP</span>
<h1 style="margin-top:18px">Grow Your Business on <span class="hl">Autopilot.</span></h1>
<p class="lead">DashPatrol brings you customers from Google while you run your business. It finds what people search for, improves your pages, writes your articles and measures every result, so you save hours every week without paying an agency.</p>
<div class="ctas">${cta("Start Growing Free &rarr;","btn lime big")}<a class="btn outline" href="#how"><span class="play">&#9654;</span> See How It Works</a></div>
<p class="note"><span>&#10003; No credit card required</span><span>&#10003; Quick setup</span><span>&#10003; Works with your website</span></p>
<div class="pills">
<span class="pill"><b style="background:#95BF47">S</b>Shopify</span>
<span class="pill"><b style="background:#21759B">W</b>WordPress</span>
<span class="pill"><b style="background:#4353FF">W</b>Webflow</span>
<span class="pill"><b style="background:#111">W</b>Wix</span>
<span class="pill"><b style="background:#2FA84F">&#127760;</b>Any website</span>
</div>
</div>
<div class="mockwrap" role="figure" aria-label="Example of the DashPatrol dashboard with sample numbers">
<div class="mock">
<div class="bar"><b></b><b></b><b></b><span>app.dashpatrol.io</span></div>
<span class="sample">Dashboard preview</span>
<div class="body">
<div class="kpis">
<div class="kpi"><span class="kic">&#128269;</span><small>Visits from Google</small><strong data-count="4820">4,820</strong><em>&#9650; +32% this month</em></div>
<div class="kpi"><span class="kic">&#128270;</span><small>Searches you show up in</small><strong data-count="1260">1,260</strong><em>&#9650; +28% growing</em></div>
<div class="kpi"><span class="kic">&#128200;</span><small>Changes made</small><strong data-count="38">38</strong><em>All undoable</em></div>
</div>
<div class="chart"><small>Visits from Google, last 6 months</small>
<svg viewBox="0 0 420 170" role="img" aria-label="Sample chart: visits rising from January to June">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3DCB5A" stop-opacity=".35"/><stop offset="1" stop-color="#3DCB5A" stop-opacity="0"/></linearGradient></defs>
<g font-size="10" fill="#6B7A70" font-family="Inter,Arial"><text x="0" y="14">6,000</text><text x="0" y="38">5,000</text><text x="0" y="62">4,000</text><text x="0" y="86">3,000</text><text x="0" y="110">2,000</text><text x="0" y="134">1,000</text><text x="70" y="164">Jan</text><text x="132" y="164">Feb</text><text x="194" y="164">Mar</text><text x="256" y="164">Apr</text><text x="318" y="164">May</text><text x="380" y="164">Jun</text></g>
<g stroke="#000" opacity=".06"><path d="M40 10H420M40 34H420M40 58H420M40 82H420M40 106H420M40 130H420"/></g>
<path class="fillin" d="M76 111 L138 101 L200 92 L262 80 L324 66 L400 38 L400 146 L76 146Z" fill="url(#g)"/>
<path class="draw" d="M76 111 L138 101 L200 92 L262 80 L324 66 L400 38" fill="none" stroke="#2FBF4F" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
<g class="fillin" fill="#2FBF4F"><circle cx="76" cy="111" r="4.5"/><circle cx="138" cy="101" r="4.5"/><circle cx="200" cy="92" r="4.5"/><circle cx="262" cy="80" r="4.5"/><circle cx="324" cy="66" r="4.5"/><circle cx="400" cy="38" r="6" fill="#C6F432" stroke="#2FBF4F" stroke-width="2"/></g>
</svg><div class="up fillin">&#8593; +167%<small>more visits</small></div></div>
<div class="feed" id="feed" aria-hidden="true"><div><i>&#128221;</i><span>Drafted a new article, checked by a second AI</span><time>8 min ago</time></div><div><i>&#128279;</i><span>Added 3 internal links to a guide</span><time>2 min ago</time></div><div><i>&#9998;</i><span>Rewrote the title on your best seller</span><time>just now</time></div></div>
</div>
</div>
<span class="spark" aria-hidden="true"></span>
</div>
</div><svg class="wave" viewBox="0 0 1440 120" preserveAspectRatio="none" aria-hidden="true"><path d="M0 70 C240 130 480 10 760 50 S1200 110 1440 30 L1440 120 L0 120Z" fill="#8BE04E" opacity=".55"/><path d="M0 90 C260 140 520 30 800 70 S1220 120 1440 60 L1440 120 L0 120Z" fill="var(--bg)"/></svg></header>

<section id="benefits"><div class="wrap">
<div class="center"><span class="eyebrow">What you get</span><h2 style="margin-top:10px">More Customers. Less Work. <span class="uline">Lower Cost.</span></h2>
<p>Customers from Google cost nothing per click, but earning them takes hours every week. DashPatrol takes most of the job off your plate.</p></div>
<div class="grid">${benefits.map(([ic, pic, t, d]) => `<div class="card bcard"><div><div class="ic2">${ic}</div><h3>${t}</h3><p>${d}</p></div><div class="pic">${pic}</div></div>`).join("")}</div>
</div></section>

<section class="stats"><svg class="wave top" viewBox="0 0 1440 60" preserveAspectRatio="none" aria-hidden="true"><path d="M0 60 C360 0 1080 0 1440 60Z" fill="var(--bg)"/></svg><div class="wrap statgrid">
<div><span class="sic">&#129302;</span><p><strong>2 AIs</strong> check every plan and article</p></div>
<div><span class="sic">&#128279;</span><p><strong>5 ways</strong> to connect: Shopify, WordPress, Webflow, Wix or any site</p></div>
<div><span class="sic">&#9201;</span><p><strong>Daily</strong> health checks that repair what they can</p></div>
<div><span class="sic">&#128737;</span><p><strong>100%</strong> of page changes undoable</p></div>
</div></section>

<section id="see"><div class="wrap">
<div class="center reveal"><span class="eyebrow">See it in action</span><h2 style="margin-top:10px">Small changes. Big difference.</h2>
<p>Here is the kind of work DashPatrol does on its own, shown on an example store.</p></div>
<div class="visual">
<div class="serp reveal">
<div class="old"><span class="tag">Before</span><div class="result"><cite>yourstore.com &rsaquo; products</cite><b>Product 14 | Home</b><p>Welcome to our store. We sell many products. Click here to see more.</p></div></div>
<div class="arrow">&#8595; DashPatrol rewrites it</div>
<div class="new"><span class="tag">After</span><div class="result"><cite>yourstore.com &rsaquo; products</cite><b>Handmade Leather Wallet, Slim and Gift Ready</b><p>Full grain leather, holds 8 cards, free shipping over $50. See colors and sizes.</p></div></div>
<p class="note2">A clearer title and description gets more people to click, from the same spot on Google.</p>
</div>
<div class="ranks reveal" id="ranks">
<span class="eyebrow">Positions on Google</span>
<h3 style="margin:8px 0 6px">Easy wins first, then the bigger searches</h3>
<div class="rank"><div>leather wallet for men<small>was 18</small></div><div class="track"><i style="--w:88%"></i></div><strong>4</strong></div>
<div class="rank"><div>slim card wallet<small>was 26</small></div><div class="track"><i style="--w:80%"></i></div><strong>7</strong></div>
<div class="rank"><div>gift for dad under 50<small>was 41</small></div><div class="track"><i style="--w:66%"></i></div><strong>12</strong></div>
<div class="rank"><div>best minimalist wallet<small>was 57</small></div><div class="track"><i style="--w:50%"></i></div><strong>19</strong></div>
<p class="note2">Example data. Your own positions show in your dashboard, checked through the week.</p>
</div>
</div>
</div></section>

<section class="band" id="how"><div class="wrap">
<div class="center"><span class="eyebrow">How it works</span><h2 style="margin-top:10px">Set it up once. It keeps working.</h2>
<p>A few clicks to start. After that, DashPatrol runs every week on its own.</p></div>
<div class="steps">${steps.map(([t, d]) => `<div class="step"><h3>${t}</h3><p>${d}</p></div>`).join("")}</div>
<div class="week reveal">
<div class="day"><h4>Mon</h4><p>&#10003; Plans the week from your numbers</p><p>&#10003; A second AI checks the plan</p></div>
<div class="day"><h4>Tue</h4><p>&#10003; Rewrites pages close to page one</p></div>
<div class="day"><h4>Wed</h4><p>&#10003; Writes a new article</p><p>&#10003; Adds internal links</p></div>
<div class="day"><h4>Thu</h4><p>&#10003; Finds backlink chances</p><p>&#10003; Fixes broken links</p></div>
<div class="day"><h4>Fri</h4><p>&#10003; Measures what worked</p><p>&#10003; Gets your weekly report ready</p></div>
<div class="day rest"><h4>Sat</h4><p>Day of rest. You earned it too.</p></div>
<div class="day"><h4>Sun</h4><p>&#10003; Keeps watch on your positions</p></div>
</div>
<p style="text-align:center;margin-top:14px;color:rgba(255,255,255,.7);font-size:14px">An example week. The work runs every day except the Sabbath, in the order your site needs most.</p>
<div style="text-align:center;margin-top:40px">${cta("Start Free Now &rarr;", "btn lime big")}</div>
</div></section>

<section><div class="wrap split">
<div>
<span class="eyebrow">Every week, done for you</span>
<h2 style="margin-top:10px">The work an SEO team would do, done for you.</h2>
<p class="muted" style="margin-top:16px;font-size:18px">Most owners know SEO matters. Few have the hours to do it every single week. DashPatrol keeps at it week after week.</p>
<p class="quote" style="margin-top:28px">You run the business. <em>DashPatrol grows it.</em></p>
</div>
<ul class="list">${weekly.map((w) => `<li><span class="yes">${I.check}</span>${w}</li>`).join("")}</ul>
</div></section>

<section id="calc"><div class="wrap">
<div class="center reveal"><span class="eyebrow">Your numbers, your math</span><h2 style="margin-top:10px">What is your time worth?</h2>
<p>Move the sliders to see what handing SEO to DashPatrol gives back to you each year.</p></div>
<div class="calc reveal">
<div class="in">
<label>Hours a week you spend (or would spend) on SEO <output id="oh">5</output><input type="range" id="h" min="1" max="20" value="5"></label>
<label>What an hour of your time is worth <output id="or">$50</output><input type="range" id="r" min="15" max="250" step="5" value="50"></label>
<label>What you pay others for SEO each month <output id="oa">$0</output><input type="range" id="a" min="0" max="5000" step="100" value="0"></label>
</div>
<div class="out">
<div><small>Hours back each year</small><strong id="th">260</strong></div>
<div><small>Value back each year</small><strong id="tv">$13,000</strong></div>
<p>Based only on the numbers you enter. DashPatrol is free during early access.</p>
</div>
</div>
</div></section>

<section style="padding-top:0"><div class="wrap">
<div class="center"><span class="eyebrow">The smarter choice</span><h2 style="margin-top:10px">How DashPatrol compares</h2></div>
<div class="tablewrap"><table>
<thead><tr><th></th><th>Doing it yourself</th><th>SEO agency</th><th class="us">DashPatrol</th></tr></thead>
<tbody>${compare.map(([l, a, b, c]) => `<tr><td>${esc(l)}</td><td>${cell(a)}</td><td>${cell(b)}</td><td class="us">${cell(c)}</td></tr>`).join("")}</tbody>
</table></div>
</div></section>

<section id="pricing" style="padding-top:0"><div class="wrap">
<div class="center reveal"><span class="eyebrow">Pricing</span><h2 style="margin-top:10px">Free during early access</h2>
<p>Every feature, no credit card. If paid plans start later, you will be told before anything is charged.</p></div>
<div class="card reveal" style="max-width:560px;margin:28px auto 0;text-align:center">
<h3>Early access</h3>
<p style="font:800 44px/1 'Plus Jakarta Sans',Inter,sans-serif;margin:10px 0">$0</p>
<p>Weekly plans from your own data, page improvements, new articles checked by a second AI, internal links, backlink finds, rank checks and plain weekly reports.</p>
<div style="display:flex;justify-content:center;margin-top:22px">${cta("Start Growing Free &rarr;","btn big")}</div>
</div>
</div></section>

<section style="padding-top:0"><div class="wrap">
<div class="grid" style="grid-template-columns:1fr 1fr;margin-top:0">
<div class="card"><div class="ic">${I.shield}</div><h3>You stay in control</h3><p>Choose what DashPatrol may change. See every edit on the Content page and undo any of them in one click. Outreach emails are drafts you decide to send. No paid links and no tricks that put your site at risk.</p></div>
<div class="card"><div class="ic">${I.chart}</div><h3>Honest about results</h3><p>Google decides rankings, so no one can promise a spot. DashPatrol promises the work: easy searches first, harder ones as your site gets stronger, each change measured and kept only if it helps.</p></div>
</div>
</div></section>

<section id="faq" style="padding-top:0"><div class="wrap">
<div class="center"><span class="eyebrow">Questions</span><h2 style="margin-top:10px">Good questions, straight answers</h2></div>
<div class="faq">${faq.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join("")}</div>
</div></section>

<section style="padding-top:0"><div class="wrap">
<div class="final2">
<div class="laptop" aria-hidden="true"><svg viewBox="0 0 360 240"><ellipse cx="190" cy="226" rx="160" ry="10" fill="#000" opacity=".08"/><path d="M40 60c-14-30 4-52 20-56-2 20 6 30 2 50M56 70c-4-30 22-46 38-44-8 18-6 34-18 48M30 92c-20-14-22-38-10-50 6 18 18 24 20 40" fill="#2FA84F"/><path d="M22 120h56l-6 100H28z" fill="#F4EDE2" stroke="#D8CBB6" stroke-width="2"/><rect x="100" y="40" width="210" height="140" rx="12" fill="#1F2A22"/><rect x="110" y="50" width="190" height="120" rx="6" fill="#fff"/><rect x="124" y="120" width="18" height="38" rx="3" fill="#57C46F"/><rect x="150" y="104" width="18" height="54" rx="3" fill="#2FA84F"/><rect x="176" y="88" width="18" height="70" rx="3" fill="#1E7A3E"/><rect x="202" y="70" width="18" height="88" rx="3" fill="#145C2E"/><rect x="232" y="62" width="58" height="66" rx="10" fill="#F4F7F5" stroke="#DDE6DF"/><circle cx="261" cy="86" r="14" fill="none" stroke="#2FA84F" stroke-width="5"/><path d="M271 96l8 8" stroke="#2FA84F" stroke-width="5" stroke-linecap="round"/><rect x="242" y="110" width="38" height="5" rx="2.5" fill="#C9D6CC"/><path d="M80 180h260l-20 24H100z" fill="#C9D3CC"/></svg></div>
<div class="ftext">
<h2>Ready to Grow Your Business on Google?</h2>
<p>Let DashPatrol go after the searches you can win, improve your pages and measure every change, week after week.</p>
<div class="ctas">${cta("Start Growing Free &rarr;","btn big")}<a class="btn outline dark" href="#how"><span class="play">&#9654;</span> See How It Works</a></div>
</div>
</div>
</div></section>

<section style="padding-top:0" class="google" id="google"><div class="wrap">
<h2 style="font-size:26px">How DashPatrol uses your Google data</h2>
<ul>
<li>Google Search Console (read only): the searches your pages show up for, with clicks and positions, so it knows which pages to improve and can track results.</li>
<li>Google Analytics (read only): visits and sales from search, to measure whether each change helped.</li>
<li>Only when you click Set it up for me: it verifies your site, adds it and its sitemap to Search Console, and creates an Analytics property for it.</li>
<li>Your data is used only to run DashPatrol for your own site. It is never sold, never shared with other customers and never used for ads.</li>
</ul>
</div></section>

${siteFooter(appUrl, home, contactHtml)}
<script>
(function(){
var feed=document.getElementById("feed"),items=[["&#9998;","Rewrote the title on your best seller","just now"],["&#128279;","Added 3 internal links to a guide","2 min ago"],["&#128221;","Drafted a new article, checked by a second AI","8 min ago"],["&#128200;","Moved up 6 spots for a search","today"],["&#128295;","Fixed a broken link","today"],["&#9993;","Weekly report ready","this week"]],k=3;
function push(){if(!feed)return;var it=items[k++%items.length],d=document.createElement("div");d.innerHTML="<i>"+it[0]+"</i><span>"+it[1]+"</span><time>"+it[2]+"</time>";feed.insertBefore(d,feed.firstChild);while(feed.children.length>3)feed.removeChild(feed.lastChild);}
var still=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
var paused=false;if(feed){feed.addEventListener("mouseenter",function(){paused=true});feed.addEventListener("mouseleave",function(){paused=false});}
if(!still)setInterval(function(){if(!paused)push();},2600);
document.querySelectorAll("[data-count]").forEach(function(el){var n=+el.getAttribute("data-count"),t0=null;if(still)return;el.textContent="0";function f(t){if(!t0)t0=t;var p=Math.min((t-t0)/1800,1),e=1-Math.pow(1-p,3);el.textContent=Math.round(n*e).toLocaleString("en-US");if(p<1)requestAnimationFrame(f);}requestAnimationFrame(f);});
var io="IntersectionObserver" in window?new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add("in");io.unobserve(e.target);}});},{threshold:.15}):null;
if(io){document.documentElement.classList.add("js");document.querySelectorAll(".reveal").forEach(function(el){io.observe(el);});}
var h=document.getElementById("h"),r=document.getElementById("r"),a=document.getElementById("a");
function money(v){return "$"+Math.round(v).toLocaleString("en-US");}
function calc(){var hv=+h.value,rv=+r.value,av=+a.value;document.getElementById("oh").textContent=hv;document.getElementById("or").textContent=money(rv);document.getElementById("oa").textContent=money(av);document.getElementById("th").textContent=(hv*52).toLocaleString("en-US");document.getElementById("tv").textContent=money(hv*52*rv+av*12);}
if(h){[h,r,a].forEach(function(x){x.addEventListener("input",calc);});calc();}
})();
</script>
</body>
</html>`;
}
