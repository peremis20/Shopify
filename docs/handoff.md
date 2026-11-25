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
