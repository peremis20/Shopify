# Handoff (from the previous session, 2026-11-23)

Rules: read CLAUDE.md. Branch claude/stoic-franklin-g39y0y (Shopify and centralhealthmagazine). No PR unless asked. Keys only in Platform keys. Real data only. No hyphens or dashes in user facing text; short plain replies. Sabbath: nothing runs or releases Friday sundown to Saturday sundown.

Release steps: independent review agent, fix, review again; `npm run build:neon` (runs tests); commit and push; UPDATE the `release` row in insights_settings (prepend old value to `release_history`, keep 10); check https://app.dashpatrol.io/api/heartbeat (Apify web fetch, curl is blocked).

Neon: project billowing-pine-62805985, branch br-weathered-mouse-b5ymo8mn. Hourly trigger trigger-65764442-eb74-409e-b643-9e35061bb1a3 must be cron "17 * * * *" (it was found changed to daily on 2026-11-22 and put back).

## Open work
1. Released 2026-11-25 (c5a983c): Site watch review fixes, and the planner fix (out of reach searches hidden, shared plan rules, one retry with the critic's reasons when fewer than 2 moves survive). Next: read the next strategy:% and authority_plan:% rows and check more moves are kept.
2. Customer view findings still open: odd Analytics numbers (111 key events from 7 unassigned sessions; ); empty Shopify pages section; Allow button for Google re-crawl not clear. One plan move made an inflammation claim: guardrail area, left alone.
3. Newsletter: Jimmy can't pay for Klaviyo. Proposed: DashPatrol writes it weekly, second AI checks, owner approves, sent by Shopify Email (owner presses send) or a free Brevo account (app sends). Waiting for his choice.
4. Owner items: publish the speed theme copy, approve write_customers, bonus halving, 15% vs 20% sell sheet, whether the finder should also search functional medicine doctors and naturopaths.

## Nov 25: Unassigned key events (released 1a30f40)
Google Analytics key events on the Unassigned or (not set) channel are no longer counted as leads in the weekly email, the HTML email or the dashboard. They show on a plain note instead (`autopilot/channels.ts`), revenue still counts, and the customer view check (VIEW_FACTS in writer.ts) knows why the totals differ.

## Nov 25: why plan ideas were turned down (released 1be4b44)
`autopilot/plan-notes.ts` groups turned down Strategist and Authority Coach ideas by reason (data checks, the second AI's verdict, no verdict) on the Home plan card, the authority plan card, the weekly report and the email. Ideas cut only by the five move cap read as "waits for next week", not turned down.

## Nov 25: goal card (released 1ee2e33)
`autopilot/goal.ts` shows the next milestone (100, 500, 1,000 ... up to the goal) and says the number counts Google search clicks only, usually lower than all visits. The pace estimate never rounds real clicks to 0. VIEW_FACTS explains it to the customer view check.

## Nov 25: where Shopify orders came from (released, see next commit)
`shopify-sales.ts` orderSource() names each order's source from the source name and referring host only (TikTok, TikTok Shop, Google search, Google ads, ChatGPT, Gemini, Gmail, Direct or unknown, other hosts), top 8 plus Other, shown on the weekly report and in the email. isGoogle is shared with fromGoogle: source Google or Google Shopping, the Google app, or a google.* host. Old cache rows without sources are read again.

## Nov 25: Google recrawl permission (released)
The Inspector's "google:recrawl" fix text names DashPatrol's Home screen, the "Open Google to allow" button and the connected Google email. Home shows a clear button that reports a failed or blocked opening. Follow up idea: the OAuth callback could refuse a different Google account when the purpose is recrawl.

## Nov 25: Idea finder "connect Search Console" with it connected (released)
A site with no topics yet saves `noTopics: true` and is tried again after 6 hours instead of a week; the note says Search Console only when it isn't connected. Follow Us menu in Shopify now links Facebook, Instagram, LinkedIn (YouTube left as "#" until the owner confirms youtube.com/@peremis).

## Nov 25: "autopilot did nothing" with a full fix list (released)
The weekly report's Work done stat now says how many changes wait on the fix list; VIEW_FACTS explains report.week vs report.week.suggested to the customer view check.

## Nov 25: Analytics vs Shopify sales gap (released)
Weekly report, text and HTML email explain a clear gap between Google Analytics and Shopify sales (salesGapNote in channels.ts), comparing Shopify sales over the same whole days as Analytics (analyticsWeekRevenue, shop time zone) and only in the same currency. Leads and sales tile shows Shopify 7 day sales.

## Nov 25: plan text for owners (released)
Saved plans stay word for word; readStrategy, readAuthorityPlan, Plan now and the Inspector show them through cleanPlan/ownerText (writer.ts): no hyphens between words, while addresses, paths, domains, dates and the move's own search and page keep theirs. PLAN_RULES rule 6: title moves for condition searches never say which benefit to promise.

## Nov 26: Newsletter v1 (released)
src/lib/analytics/newsletter.ts + Newsletter page. Sends through the site owner's own Resend key (encrypted), subscribers from Shopify (SUBSCRIBED only) or consented imports, one click unsubscribe (RFC 8058) and postal address footer, test then approve before any send, hourly batched sending with daily cap, Sabbath skip, pause, idempotent resends, lease per site. Peremis: news.peremis.com verified in Resend; owner still to add key, from address and postal address. Not yet: unsubscribe sync back to Shopify, scheduled Shopify import, open or click tracking.

## Nov 27: platform owners in the app (released)
ADMIN_EMAILS stays the root list; owners can add others under Platform keys (insights_settings admin_emails, read via isAdmin with a 60 s cache). Inside Shopify admin only ADMIN_EMAILS owners count. Google sign in now refuses unverified emails. info@peremis.com added as an owner.

## Nov 27: team members (released)
src/lib/analytics/members.ts. Signed session carries the person (accountId.b64(email).exp.sig; old cookies mean the owner). Invites accepted by the invitee; members never connect, disconnect, send, publish, approve or change autopilot (ownerOnly and memberRefusal). Only the owner's own newsletter test counts toward approval. info@peremis.com added as a member of account 1 on the owner's request.

## Nov 27: newsletter metrics and automatic sending (released)
Resend webhook events (sent, delivered, delayed, bounced, complained, opened, clicked) feed per email metrics; links get utm_source=dashpatrol&utm_medium=newsletter and Shopify shows a Newsletter order source (last visit only). Welcome email (only to people marked welcome_ok), weekly AI newsletter (sends on its own only when the owner turned it on and a real second AI approved), and scheduled sends. Owner still to add the webhook in Resend with its signing secret.

## Nov 27: newsletter audiences (released)
Each email has Send to: all, segments (built in groups and owner tags), chosen people, consenting CRM contacts, typed emails (up to 20, with consent). The exact recipients are frozen at approval in insights_newsletter_recipients (approval only happens when the count matches the button, in one statement). Tagging and adding people are owner only; member tests go only to the member.

## Nov 27: Send now (released)
Write an email has a To field: 1 to 3 people get it at once through /emails, no test needed. Request id and a 10 minute repeat check stop double sends. People added only for that email are direct_only and never get list emails; joining the list later needs list consent (CRM or typed, both now worded as consent to your emails).

## Newsletter look (Nov 27)
Every email now uses one clean layout: the owner's logo centered at the top, a large title in the owner's accent color (first block when it is a heading), a sans serif body, numbered steps with bold numbers, and the same footer. Logo link (PNG, JPG or GIF) and accent color are per site settings under Sending settings. Weekly drafts from the latest article follow the educational shape: headline, two opening paragraphs, up to three steps the article itself states, a closing line, the article link and a "Talk soon" sign off. Health rules unchanged.
