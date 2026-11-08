# The code repair agent

A scheduled Claude Code session that fixes DashPatrol's own code. The App checker, the Inspector and owners' browsers
find what is broken; this agent fixes it in the code, proves the fix, releases it, and rolls back if the release hurts.
It follows CLAUDE.md in every step.

## Each run

1. **Sabbath.** Between Friday 4 PM and Saturday 11 PM America/Chicago, stop at once and do nothing.
2. **Repository.** Work in the Shopify checkout (add `peremis20/Shopify` with add_repo and clone it if it is missing).
   `git fetch origin claude/stoic-franklin-g39y0y && git checkout -B claude/stoic-franklin-g39y0y origin/claude/stoic-franklin-g39y0y`.
   Run `npm ci` if `node_modules` is missing.
3. **Read what is broken** (Neon project `billowing-pine-62805985`, branch `br-weathered-mouse-b5ymo8mn`, read only):
   - `SELECT key, value FROM insights_settings WHERE key LIKE 'app_check:%'`: in each, `problems` and `aiProblems`
     whose `who` is not `repaired`.
   - `SELECT key, value FROM insights_settings WHERE key LIKE 'client_errors:%' AND updated_at > now() - interval '3 days'`:
     script errors, failed requests, layout overflow and drawing crashes from real browsers.
   - `SELECT value FROM insights_settings WHERE key = 'status:platform'`: parts with `ok: false`.
   - Platform problems (`platform: true`) in `inspect:%` rows.
   - The `insights` function's error logs for the last 6 hours (query_logs).
   - `SELECT value FROM insights_settings WHERE key = 'code_repair:log'`: what earlier runs tried.
4. **Pick what is the code's fault.** A missing key, a refused Google connection, a full monthly limit or a busy AI
   service is not a code bug: leave those to the Inspector. Skip anything this log shows was tried twice already;
   for those, send the owner one short PushNotification saying what is stuck and why a person is needed.
   If nothing is left, stop and reply "Nothing to fix".
5. **Fix the cause, not the symptom.** Reproduce it from the code and data first. Keep the change small and generic
   (any site, any niche). Add or extend a test in `tests/` that fails without the fix. Never touch: secrets or keys,
   sign in and sessions, spending limits, data isolation between sites, guardrails, approval rules, or tests other
   than to add to them. Never delete customer data. Layout bugs: fix the component's classes so it fits a 390px screen.
6. **Prove it.** `npm run build:neon` must pass (it runs every test). Then an independent review: spawn a review
   agent with the diff, not your conclusion, and fix every real finding. Review again until clean.
7. **Release.** Merge `origin/claude/stoic-franklin-g39y0y` again if it moved, rebuild, commit (clear message, no model
   names) and `git push -u origin claude/stoic-franklin-g39y0y`. Save the current `release` row's value under the key
   `release_previous`, then point `release` at the new commit:
   `{"url":"https://cdn.jsdelivr.net/gh/peremis20/Shopify@<sha>/neon/insights/release/server.mjs","sha":"<sha256 of neon/insights/release/server.mjs>","assets":"https://cdn.jsdelivr.net/gh/peremis20/Shopify@<sha>/neon/insights/public"}`.
8. **Check the release.** About 3 minutes later read `https://app.dashpatrol.io/api/heartbeat` (Apify web fetch if
   curl is blocked) and the function logs. If the heartbeat is not ok, or new errors started with the release, put
   `release_previous` back into `release` at once and tell the owner.
9. **Record.** Append to `code_repair:log` (keep the last 50): finding id, what was changed, commit, released or
   rolled back. Tell the owner in one short PushNotification only when something was released, rolled back, or needs
   a person. Plain words, no hyphens or dashes.
