/**
 * The public landing page at the bare domain (dashpatrol.io). It sells the outcome (time saved, money kept, growth on
 * autopilot) and only claims what the app really does: no invented numbers, testimonials or ranking promises.
 * Google's app reviewers read it too, so the Google data section and the policy links stay on the page.
 */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

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

const benefits: [string, string, string][] = [
  [I.clock, "Get your hours back", "No more guessing which keywords to chase, rewriting product pages at midnight or learning another SEO tool. DashPatrol does the research, the writing and the checking for you, every week."],
  [I.coin, "Keep more of your money", "No agency retainer, no freelancer to manage, no pile of subscriptions. One app does the weekly SEO work for you, and it is free while we are in early access."],
  [I.bolt, "Growth on autopilot", "Connect your site once. From then on DashPatrol plans, improves pages, publishes the articles you allow, adds internal links and checks your rankings through the week, with little of your time."],
  [I.chart, "Real growth, measured", "Every change is tracked against your real Search Console and Analytics numbers. What helps is kept. What doesn't is undone. Your traffic grows on facts, not hunches."],
  [I.gem, "Value you can see", "Plain weekly reports show what was done, what moved and what it brought in: visits, searches and sales from Google, in words anyone can read."],
  [I.shield, "Safe by design", "A second AI double checks every article and every plan before it counts. Every change the app makes to your pages can be undone in one click, and your data is only ever used for your own site."],
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
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap">
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
nav{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
nav .wrap{display:flex;align-items:center;justify-content:space-between;height:64px}
.logo{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:22px;text-decoration:none;display:flex;align-items:center;gap:8px}
.logo i{display:inline-block;width:26px;height:26px;border-radius:8px;background:var(--brand);position:relative}
.logo i::after{content:"";position:absolute;inset:7px;border:2.5px solid var(--accent);border-radius:50%}
nav .links{display:flex;gap:24px;align-items:center;font-size:15px}
nav .links a{text-decoration:none;color:var(--muted)}
nav .links a:hover{color:var(--ink)}
nav .btn{padding:10px 18px;font-size:15px}
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
footer{padding:36px 0 48px;color:var(--muted);font-size:14px;border-top:1px solid var(--line)}
footer .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
@media (max-width:900px){.grid{grid-template-columns:1fr 1fr}.steps{grid-template-columns:1fr 1fr}.split{grid-template-columns:1fr;gap:32px}}
@media (max-width:640px){.wrap{padding:0 16px}.grid,.steps{grid-template-columns:1fr}nav .links a:not(.btn){display:none}.hero{padding:56px 0 40px}section{padding:56px 0}.final{padding:48px 20px}}
</style>
</head>
<body>
<nav><div class="wrap">
<a class="logo" href="/"><i></i>DashPatrol</a>
<div class="links"><a href="#benefits">Benefits</a><a href="#how">How it works</a><a href="#faq">Questions</a>${cta("Start free")}</div>
</div></nav>

<header class="hero"><div class="wrap">
<span class="eyebrow">Your SEO team, in one app</span>
<h1 style="margin-top:14px">Grow your business on autopilot.</h1>
<p class="lead">DashPatrol brings you customers from Google while you run your business. It finds what people search for, improves your pages, writes your articles and measures every result, so you save hours every week without paying an agency.</p>
<div class="ctas">${cta("Start growing free &rarr;")}<a class="btn ghost" href="#how">See how it works</a></div>
<p class="note">Free during early access. Sign in with Google. No card needed.</p>
<div class="pills">
<span class="pill"><span class="yes">${I.check}</span>Shopify</span>
<span class="pill"><span class="yes">${I.check}</span>WordPress</span>
<span class="pill"><span class="yes">${I.check}</span>Webflow</span>
<span class="pill"><span class="yes">${I.check}</span>Wix</span>
<span class="pill"><span class="yes">${I.check}</span>Any website</span>
</div>
</div></header>

<section id="benefits"><div class="wrap">
<div class="center"><span class="eyebrow">What you get</span><h2 style="margin-top:10px">More customers. Less work. Lower cost.</h2>
<p>Customers from Google cost nothing per click, but earning them takes hours every week. DashPatrol takes most of the job off your plate.</p></div>
<div class="grid">${benefits.map(([ic, t, d]) => `<div class="card"><div class="ic">${ic}</div><h3>${t}</h3><p>${d}</p></div>`).join("")}</div>
</div></section>

<section class="band" id="how"><div class="wrap">
<div class="center"><span class="eyebrow">How it works</span><h2 style="margin-top:10px">Set it up once. It keeps working.</h2>
<p>A few clicks to start. After that, DashPatrol runs every week on its own.</p></div>
<div class="steps">${steps.map(([t, d]) => `<div class="step"><h3>${t}</h3><p>${d}</p></div>`).join("")}</div>
<div style="text-align:center;margin-top:40px">${cta("Start free now", "btn")}</div>
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

<section style="padding-top:0"><div class="wrap">
<div class="center"><span class="eyebrow">The smarter choice</span><h2 style="margin-top:10px">How DashPatrol compares</h2></div>
<div class="tablewrap"><table>
<thead><tr><th></th><th>Doing it yourself</th><th>SEO agency</th><th class="us">DashPatrol</th></tr></thead>
<tbody>${compare.map(([l, a, b, c]) => `<tr><td>${esc(l)}</td><td>${cell(a)}</td><td>${cell(b)}</td><td class="us">${cell(c)}</td></tr>`).join("")}</tbody>
</table></div>
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
<div class="final">
<h2>Your next customers are searching right now.</h2>
<p>Let DashPatrol make sure they find you. Start free today and put your growth on autopilot.</p>
${cta("Start growing free &rarr;")}
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

<footer><div class="wrap">
<span>&copy; ${new Date().getUTCFullYear()} DashPatrol</span>
<span><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of use</a> · Contact: ${contactHtml}</span>
</div></footer>
</body>
</html>`;
}
