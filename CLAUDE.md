# DashPatrol: the SEO operating system

DashPatrol (the `/analytics` app, run as the Neon Function `insights`) is a framework that ranks **any** website on Google and turns that traffic into money for the site owner. It is not a report. The agents understand the site, its data and its competition, act on it, measure what worked, and repeat, for every site that connects.

## The goal for every site

About 20,000 visitors a month from Google, and revenue from them. Every feature should move a site toward that, or make the agents better at moving it.

## How the agents work together

- **Understand:** read the site (Shopify, WordPress, Webflow, Wix, or any site through the snippet), Search Console, Analytics, Keyword Planner, Google page one and competitors.
- **Plan:** the Strategist (`autopilot/strategist.ts`) plans each week from real numbers; a second AI from another provider challenges every move, and only moves backed by the data are acted on.
- **Act:** the autopilot improves pages, writes new articles (checked by a second AI so they read as human), adds internal links, and finds backlink prospects. Easy searches first, harder ones as site strength grows.
- **Measure:** daily rank checks; every change is measured and kept or undone.
- **Watch each other:** the Inspector (`autopilot/inspector.ts`) checks every part each hour, repairs what an agent can, and tells the owner in plain words what only a person can fix. Services report to the status board (`autopilot/status.ts`) so nothing fails quietly.
- **Learn:** the Learning loop (`autopilot/apps/feedback.ts`) feeds results back: rescue drops, follow sales, build on won links.

## Rules for building it

- Generic for any site and any niche. Nothing hard coded to one store; site specifics come from its data and profile.
- Act, don't just show. If the app can do it, it does it; the owner only does what truly needs a person (keys, sending outreach email).
- Agents check and challenge each other. A failure must be visible to the Inspector, never swallowed.
- Never invent searches, numbers or facts. Guardrails stay on (junk keywords, unsourced claims, AI tells).
- No paid links or link schemes; outreach is sent by the owner.
- Simple view first for owners, Advanced for data people. Plain, short wording, no hyphens or dashes in user facing text.
- Sabbath: nothing runs from Friday sundown to Saturday sundown, except church projects.

## Releasing

`npm run build:neon`, commit and push, then point the `release` row in `insights_settings` at the new commit (url, sha256 of `neon/insights/release/server.mjs`, assets). The function picks it up within a minute.
