# Handoff (from the previous session, 2026-11-23)

Rules: read CLAUDE.md. Branch claude/stoic-franklin-g39y0y (Shopify and centralhealthmagazine). No PR unless asked. Keys only in Platform keys. Real data only. No hyphens or dashes in user facing text; short plain replies. Sabbath: nothing runs or releases Friday sundown to Saturday sundown.

Release steps: independent review agent, fix, review again; `npm run build:neon` (runs tests); commit and push; UPDATE the `release` row in insights_settings (prepend old value to `release_history`, keep 10); check https://app.dashpatrol.io/api/heartbeat (Apify web fetch, curl is blocked).

Neon: project billowing-pine-62805985, branch br-weathered-mouse-b5ymo8mn. Hourly trigger trigger-65764442-eb74-409e-b643-9e35061bb1a3 must be cron "17 * * * *" (it was found changed to daily on 2026-11-22 and put back).

## Open work
1. Site watch (src/lib/analytics/autopilot/site-watch.ts, handlers.ts tick block, alerts.ts EMAIL_WORTHY, tests/site-watch.test.ts). Committed f9cf07c and pushed, NOT released. The second independent review of 7a27ae5..f9cf07c never came back: run it again, fix findings, then build and release.
2. Code repair findings: Strategist and Authority Coach plans often have every move dropped by the critic (critic reasons look correct). Possible improvement: planner prompt should favor small, on topic moves backed by the site's own data. Not a code bug yet.
3. Owner items: publish the speed theme copy, approve write_customers, bonus halving, 15% vs 20% sell sheet, whether the finder should also search functional medicine doctors and naturopaths.
