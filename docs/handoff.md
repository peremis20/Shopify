# Handoff (from the previous session, 2026-11-23)

Rules: read CLAUDE.md. Branch claude/stoic-franklin-g39y0y (Shopify and centralhealthmagazine). No PR unless asked. Keys only in Platform keys. Real data only. No hyphens or dashes in user facing text; short plain replies. Sabbath: nothing runs or releases Friday sundown to Saturday sundown.

Release steps: independent review agent, fix, review again; `npm run build:neon` (runs tests); commit and push; UPDATE the `release` row in insights_settings (prepend old value to `release_history`, keep 10); check https://app.dashpatrol.io/api/heartbeat (Apify web fetch, curl is blocked).

Neon: project billowing-pine-62805985, branch br-weathered-mouse-b5ymo8mn. Hourly trigger trigger-65764442-eb74-409e-b643-9e35061bb1a3 must be cron "17 * * * *" (it was found changed to daily on 2026-11-22 and put back).

## Open work
1. Released 2026-11-25 (c5a983c): Site watch review fixes, and the planner fix (out of reach searches hidden, shared plan rules, one retry with the critic's reasons when fewer than 2 moves survive). Next: read the next strategy:% and authority_plan:% rows and check more moves are kept.
2. Customer view findings still open: owners aren't told why plan moves were dropped; odd Analytics numbers (111 key events from 7 unassigned sessions; goal card shows 0 visitors); empty Shopify pages section; Allow button for Google re-crawl not clear. One plan move made an inflammation claim: guardrail area, left alone.
3. Newsletter: Jimmy can't pay for Klaviyo. Proposed: DashPatrol writes it weekly, second AI checks, owner approves, sent by Shopify Email (owner presses send) or a free Brevo account (app sends). Waiting for his choice.
4. Owner items: publish the speed theme copy, approve write_customers, bonus halving, 15% vs 20% sell sheet, whether the finder should also search functional medicine doctors and naturopaths.

## Nov 25: Unassigned key events (released 1a30f40)
Google Analytics key events on the Unassigned or (not set) channel are no longer counted as leads in the weekly email, the HTML email or the dashboard. They show on a plain note instead (`autopilot/channels.ts`), revenue still counts, and the customer view check (VIEW_FACTS in writer.ts) knows why the totals differ.
