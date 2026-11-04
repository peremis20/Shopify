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

- No narrow agents. Anything that is good for the site or the app, an agent should fix, improve or make work, and anything broken it should repair, as creatively as it likes, as long as the app keeps working.
- Never assume and never invent. Every piece of work is double checked by another agent before it counts: content by a second AI, plans by the Strategist's critic, the system by the Inspector, and code changes by an independent review before release.

- Each site is worked on with its own data only. Per site data is keyed by account; shared caches hold only public facts (Google page one, Keyword Planner volumes, Open PageRank) and never a site's own results. Other customers' sites are never studied as competitors, used as writing material, or suggested as backlinks (`autopilot/clients.ts`).
- Generic for any site and any niche. Nothing hard coded to one store; site specifics come from its data and profile.
- Act, don't just show. If the app can do it, it does it; the owner only does what truly needs a person (keys, sending outreach email).
- Agents check and challenge each other. A failure must be visible to the Inspector, never swallowed.
- Never invent searches, numbers or facts. Guardrails stay on (junk keywords, unsourced claims, AI tells).
- No paid links or link schemes; outreach is sent by the owner.
- Simple view first for owners, Advanced for data people. Plain, short wording, no hyphens or dashes in user facing text.
- Sabbath: nothing runs from Friday sundown to Saturday sundown, except church projects.

## Product direction (from the owner)

One repeatable loop, not every marketing channel at once:

Analyze the website → find traffic opportunities → create content and improvements → get approval and publish → measure visitors, leads and sales → improve the next campaign.

- **Same system, different strategy per business.** "Any website" means a reusable system, not the same strategy for everyone. Each customer gives their audience, offer, location, goals and account permissions (the site profile); plans come from that plus their own data.
- **Five capabilities:**
  - *Website analysis:* read the pages; find the business, products, audience and missing information.
  - *Opportunity discovery:* existing search queries, underperforming pages, useful topics.
  - *Content creation:* page improvements, articles, social posts and short video scripts.
  - *Distribution:* send approved content to connected publishing channels, linking back to the relevant pages.
  - *Measurement:* which channels and pages bring visitors, leads and purchases.
- **Data sources are complementary, not interchangeable.** Search Console gives queries, impressions, clicks, CTR, position and URL inspection; Analytics (Data API) gives what visitors do after arriving and conversions. Both need the customer's authorized access; a URL alone never unlocks private data.
- **Small stack.** One AI for writing plus a second from another provider for checking, scheduled jobs (the hourly tick), Search Console API, Analytics Data API, one publishing integration done well before the next, and the database for sites, tasks, content, approvals and results. MCP is optional plumbing, not the strategy.
- **First product: the weekly traffic assistant.** Each week, for a connected site: pick three promising existing pages (example rule: impressions but few clicks, then match the query, title and content to what the searcher needs), draft their improvements and one supporting article, repurpose the article into social posts and a short video script, ask the owner to approve, then track the clicks, visits and conversions that follow. Ads, influencer outreach and full video production come after this works and is measured.
- **Limits around the automation:**
  - Approval before publishing, sending outreach or spending money. Publishing on its own is allowed only where the owner turned it on in Autopilot settings, and every change stays undoable.
  - Spending caps and a pause button.
  - Source checks for factual claims, strictest on health content.
  - No fabricated reviews, fake traffic or mass unsolicited messages.
  - Report qualified leads and sales, not just visitor counts.
  - Compare results against a recorded baseline (and control groups). A rise after a change is evidence, not proof the AI caused it; say so in reports.

## Releasing

`npm run build:neon` (it runs `npm test` first; a failing test stops the release), commit and push, then point the `release` row in `insights_settings` at the new commit (url, sha256 of `neon/insights/release/server.mjs`, assets). The function picks it up within a minute.
