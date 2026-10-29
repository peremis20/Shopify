# YoYo AK-100 — Health Quiz & Personalized Dashboard

A personalized health-quiz web app built with **Next.js + TypeScript** and
**Firebase** (Auth + Firestore). Users take a 5-step quiz, get a tailored
wellness plan and product recommendations, create an account, and revisit
everything from their own private dashboard.

The UI matches the YoYo AK-100 brand: warm cream background, deep-green
headings, orange accents, and a friendly, rounded card style.

## Features

- 🎯 **5-step quiz** — Goals → Lifestyle → Health → Preferences → Results, with
  a progress stepper and answers auto-saved as you go.
- 🧠 **Personalized plan engine** — builds a daily routine, tips, and focus
  areas from the answers (`src/lib/recommendations.ts`).
- 🛒 **Smart product recommendations** — scores the YoYo AK-100 catalog against
  the user's goals and preferences (`src/lib/products.ts`).
- 🔐 **Firebase Auth** — email/password + Google sign-in.
- 📊 **Private dashboard** — each user sees their goals, plan, health snapshot,
  and recommended products, stored per-user in Firestore.

## Tech stack

- Next.js 14 (App Router) + TypeScript
- Tailwind CSS (custom brand theme in `tailwind.config.ts`)
- Firebase Web SDK v11 (Auth + Firestore)

## Getting started

```bash
npm install
cp .env.local.example .env.local   # then fill in your Firebase keys
npm run dev
```

Open http://localhost:3000.

> The marketing page and quiz work without Firebase. Accounts, saving plans,
> and the dashboard activate once `.env.local` has valid keys.

## Firebase setup

1. Create a project at https://console.firebase.google.com.
2. **Authentication** → enable **Email/Password** and **Google** providers.
3. **Firestore Database** → create a database (production mode).
4. Project settings → add a **Web app** and copy the config into `.env.local`
   (see `.env.local.example`).
5. Deploy the included security rules so users can only touch their own data:
   ```bash
   firebase deploy --only firestore:rules
   ```

## Insights dashboard (`/analytics`)

One page that pulls Google Analytics 4 and Google Search Console together:
headline KPIs, users and page views over time, search clicks and impressions,
traffic channels, top pages, and top search queries, each compared with the
previous period. It works right away with sample data, then switches to your
real numbers once credentials are added.

### Connect Google with one button (recommended)

Do this once, then anyone with the dashboard password can click
**Connect with Google** and pick their properties from a list.

1. In [Google Cloud Console](https://console.cloud.google.com), create or pick
   a project and enable the **Google Analytics Data API**, the
   **Google Analytics Admin API** and the **Google Search Console API**.
2. APIs and Services, OAuth consent screen: choose **Internal** if you use
   Google Workspace. Otherwise choose External and add your own email as a
   test user. (External apps left in testing mode need you to reconnect
   every 7 days; publish the app to avoid that.)
3. Credentials, Create credentials, **OAuth client ID**, type Web
   application. Add the redirect URI
   `https://YOUR-SITE/api/auth/google/callback` (and
   `http://localhost:3000/api/auth/google/callback` for local testing).
4. Put the client ID and secret, plus your Neon connection string, in
   `.env.local` and in your host's settings:
   ```bash
   GOOGLE_OAUTH_CLIENT_ID=1234-abc.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-...
   DATABASE_URL=postgresql://...neon.tech/neondb?sslmode=require
   DASHBOARD_PASSWORD=choose-one   # strongly recommended once it's online
   ```
5. Restart, open `/analytics`, click **Connect with Google**. The first
   Analytics property and Search Console site are picked automatically;
   change them under **Settings**.

The connected account and the chosen properties are saved in Neon (table
`insights_google_connection`, with the Google token encrypted), so the
dashboard stays connected on every device. Recent reports are cached in
`insights_report_cache` for 10 minutes. The app creates both tables on first
use; `db/insights-schema.sql` has the same definitions. Disconnect from
Settings at any time.

### Or use a service account

If you prefer fixed properties set by the server, create a service account,
add its email as a Viewer in Analytics and a user in Search Console, then
set `GOOGLE_SERVICE_ACCOUNT_JSON`, `GA4_PROPERTY_ID` and `GSC_SITE_URL`
(see `.env.local.example`).

### Put it online

Import the GitHub repo at [vercel.com/new](https://vercel.com/new), add the
environment variables above, and deploy. Then add the live redirect URI to
your OAuth client in Google Cloud.

Data is cached for 10 minutes; the Refresh button pulls fresh numbers.
Search Console reports about 3 days behind, so its date range ends earlier
than the Analytics one.

### Run it on Neon (no other host needed)

The dashboard can run as a [Neon Function](https://neon.com/docs/compute/functions/overview)
in the same Neon project as its database. `DATABASE_URL` is injected automatically.

1. `npm run build:neon` builds the page files into `neon/insights/public`
   and the server into `neon/insights/release/server.mjs` (commit both),
   plus `neon/dist/loader.zip`, a tiny function that downloads that server
   from the CDN and checks its SHA-256 before running it.
2. Deploy `loader.zip` as a function (slug `insights`) with these variables:
   - `ASSET_BASE_URL`: `https://cdn.jsdelivr.net/gh/peremis20/Shopify@<commit>/neon/insights/public`
   - `SERVER_BUNDLE_URL`: `https://cdn.jsdelivr.net/gh/peremis20/Shopify@<commit>/neon/insights/release/server.mjs`
   - `SERVER_BUNDLE_SHA256`: printed by the build
   - `APP_URL`: the function's invocation URL
   - `SESSION_SECRET`: a long random string (encrypts stored Google credentials and tokens)
   - `DASHBOARD_PASSWORD`: the password for the page
   - `GA_EXCLUDE_HOSTNAMES` (optional): other sites sharing your GA4 tag to leave out, e.g. `sakshijewelers.com`
   After that first deploy, new versions don't need a redeploy: set the
   release row and every instance switches within a minute (a version that
   fails its SHA-256 check is never run):
   ```sql
   INSERT INTO insights_settings (key, value) VALUES ('release',
     '{"url":".../release/server.mjs","sha":"<sha256>","assets":".../public"}')
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
   ```
   Or skip the loader and deploy the whole server with the CLI:
   ```bash
   neon functions deploy insights --src neon/dist/index.mjs --no-bundle --env KEY=VALUE ...
   ```
3. Open the function URL, then paste your Google Client ID and secret under
   **Settings**. They're stored encrypted in the `insights_settings` table.

### Keyword research (Google Keyword Planner)

The Keyword Research section pulls keyword ideas, monthly search volume,
competition and bid ranges from Google Keyword Planner through the Google
Ads API, and can look up volume for your Search Console queries.

It needs, once:
1. The **Google Ads API** enabled in the same Google Cloud project.
2. A Google Ads account for the connected Google account (no ads or
   billing needed) and its **developer token** (Google Ads, Admin, API
   Center). Real data needs **Basic access**; a new token starts with test
   access only.
3. Reconnecting Google from the dashboard once, to grant the Ads scope.
   Your Analytics and Search Console choices are kept.

Paste the developer token in the Keyword Research section; it's stored
encrypted in Neon. Or set `GOOGLE_ADS_DEVELOPER_TOKEN`,
`GOOGLE_ADS_CUSTOMER_ID` and, for a manager account,
`GOOGLE_ADS_LOGIN_CUSTOMER_ID`. `GOOGLE_ADS_API_VERSION` defaults to `v26`.
Results are cached for 24 hours.

### SEO tools

The SEO Tools section has three tabs:

- **Opportunities**: Search Console searches where the site ranks 4 to 20,
  with an estimate of extra clicks at position 3, and a content ideas view
  that groups them into topics. Brand searches can be hidden.
- **Rank tracker**: saved keyword lists (stored in Neon) with weekly
  positions for the last 12 weeks, the change over 4 weeks, and the
  ranking page. History comes from Search Console, so nothing needs to
  run on a schedule.
- **Keyword ideas**: Keyword Planner ideas and volumes (see above), with a
  content ideas view that groups keywords into topics and suggests the
  kind of page to write.

### SEO Autopilot

Runs once a day as a Neon scheduled trigger (POST `/api/autopilot/tick`,
accepted without the password only when Neon's `X-Neon-Trigger-Invocation-Id`
header is present). Each run:

1. Measures pages changed at least 4 weeks ago in Search Console; if a
   page dropped more than 3 positions and lost clicks, its changes are undone.
2. Within the weekly page limit, picks one page whose URL maps to a blog
   post, page, product or collection:
   - **Defend first:** a page one search that slipped in the last 7 days
     compared with the 4 weeks before (top 3 by 0.8+ positions, the rest of
     page one by 2+). A defended page can be changed again after 21 days.
   - **Then attack:** searches at #2 to #3 going for #1, and #4 to #20 going
     for the top 3, sized by Keyword Planner search volume and weighted by
     how well the page converts search visitors (GA4 key events). Pages
     rest 45 days between changes.

   With a serper.dev key it reads Google page one for the search, fetches the
   top pages ranking above the store (headings, length, structured data),
   notes who moved above since the last check, and adds People Also Ask
   questions. The AI writer (Claude, Groq or Gemini) gets all of that, plus
   related Keyword Planner phrases, and writes an SEO title, meta
   description, missing image alt text and, for posts and pages, a new
   section; then one internal link is added from the most related other post.
3. Logs every change with the old value. Added sections and links are
   wrapped in `<!-- autopilot:ID -->` markers so undo removes only them.

Prices, product names, handles and checkout are never touched. Setup needs a
Shopify Dev Dashboard app (scopes `write_content`, `write_products`,
`write_online_store_pages`, `write_files`) installed on the store, and a
Claude API key; both are entered in the dashboard and stored encrypted, or
set `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` and
`ANTHROPIC_API_KEY`.

### Page one watch, site health and structured data

- **Page one watch:** every morning the scheduled trigger checks Google page
  one (serper.dev) for up to 15 searches per account: saved keywords first,
  then the page one searches with the most clicks. Positions are stored in
  `insights_rank_daily`. The "Daily rank tracking" app turns a drop against the
  best position of the week into a defend target for that day's run.
- **Site health:** a few pages a day (the top Search Console pages plus any page
  the autopilot changed, each rechecked weekly) go through the Search Console
  URL Inspection API (index status, last crawl, rich results and their issues)
  and PageSpeed Insights (mobile speed; set an optional Google API key in
  Platform keys for higher limits). Results are in `insights_page_health`, with
  plain fixes. Pages Google hasn't indexed are passed over by the autopilot.
  Requesting indexing has no general API, so each page links to its Search
  Console inspection, where the button is.
- **Structured data:** after changing a blog post or page, the autopilot adds
  JSON-LD built only from the page: BlogPosting (when neither the theme nor the
  post has article markup, checked against the live page) and FAQPage (from
  question headings with answers). It is rebuilt on later runs and can be undone
  like any other change.
- **Link fixer:** once a week (and on "Check now") blog posts and pages are
  scanned for links to product addresses that are no longer live. The live
  store is asked where each one redirects, and the link is pointed straight at
  the live product, so clicks and link credit skip the redirect. Only the
  address changes, never the wording, and links to other sites are left alone.
  Each fixed post shows as a "Link fix" in the history and can be undone while
  nobody has edited the post since.
- **Claim guard:** built for health and wellness stores. Everything the
  autopilot writes is checked for wording the FTC and FDA treat as risky
  (disease claims such as "treats diabetes", "FDA approved", "clinically
  proven", "no side effects", guaranteed results, pounds to lose, replacing
  medication); a risky paragraph is dropped and a risky title or description is
  never written. Once a week every published post, page and active product is
  scanned too (`insights_claim_flags`), including whether product pages carry
  the FDA disclaimer when the theme doesn't show it sitewide. Existing wording
  is flagged with a safer version, never changed automatically. Warnings, myth
  busting and "talk to your doctor" sentences aren't flagged. Rules live in
  `autopilot/claims.ts`.
- **Overlap and safety guards** (`autopilot/guards.ts`): the autopilot never
  saves an SEO title or description another page already uses (or nearly), and
  drops new paragraphs copied from another page or repeating the page itself.
  When Search Console shows several of the site's pages getting the same
  search, only the strongest one is worked on. Contact, policy, legal, review
  and similar pages are never touched. Body edits are only written if the page
  is still exactly as it was read, so edits made meanwhile are never
  overwritten. Titles are trimmed at a whole word. An emergency brake holds new
  changes when Google clicks fall 40% or more in a week (from a usual week of
  20+ clicks). A weekly overlap report lists duplicate titles and descriptions,
  posts that repeat each other and searches split between pages, with what to
  do about each.

### Onboarding

A checklist at the top of the dashboard walks each customer through setup:
Google, Shopify, what the business sells, Search Console, Analytics, the first
site check, the first preview and turning the autopilot on. Each open step has
its one action right there.

- **Properties are found, not picked.** After Google sign in and again after
  Shopify connects, the app reads the store's own domain from Shopify and
  chooses the Search Console property and the Analytics property whose web
  stream is that domain (`src/lib/analytics/onboarding.ts`). A choice already
  made is never changed.
- **No access yet?** When the signed-in Google account can't see the site, the
  checklist writes a ready-to-send message to the site owner with the exact
  clicks to add that account, plus Email and Copy buttons and a Check again
  button.
- **Per business, not per Peremis.** `insights_account_profile` holds the
  brand name (titles end with " | Brand"), what the business sells (the writer
  is told this), the store domain and other sites sharing the Analytics tag
  (the old `GA_EXCLUDE_HOSTNAMES` now only seeds the platform owner's account).

### Inside Shopify admin (embedded app)

Installing the app from Shopify is the whole signup. Shopify opens the app in
its admin with App Bridge, which adds a session token to every API call
(`src/lib/analytics/embedded.ts`). The server checks the token's signature
with the app secret, finds the account already connected to that store (so
Peremis keeps its account) or creates one named after the store, and gets the
store's access token with Shopify's token exchange. No password, no "connect
your store" step. "Connect Google" opens Google at the top level with a signed
ticket for that account and comes straight back into Shopify admin.

Shopify settings are in `shopify-app/shopify.app.toml`: App URL
`<APP_URL>/analytics`, embedded on, the access scopes (Shopify installs with
them itself), and the uninstall and privacy webhooks.

### "Set it up for me" (stores without Search Console or Analytics)

`src/lib/analytics/google-setup.ts`. Asks Google for three more permissions
only at that moment (site verification, Search Console write, Analytics edit),
then:

1. gets a Search Console verification code and, when no Analytics property for
   the site is visible, creates a GA4 property and web stream in the
   customer's Analytics account;
2. stores both on the shop as app data (namespace `insights`), which the
   **Google setup** theme app embed (`shopify-app/extensions/google-setup`)
   prints in the page head, so the theme code is never edited. The owner turns
   the embed on once from a link that opens the theme editor with it switched on;
3. once the tag is live, verifies the site, adds it to Search Console, submits
   `sitemap.xml` and saves both properties on the account.

Each step says what's needed next (permission, the embed, or a free Analytics
account, which only Google's own page can create). Deploy the extension with
Shopify CLI from `shopify-app/` (`shopify app deploy`).

### Any website (WordPress, Wix, Squarespace, Webflow, custom)

Sites that aren't Shopify connect by address (checklist step "Connect your
website", or "Not on Shopify?" in the Autopilot card).

- **Reading:** `src/lib/analytics/site-crawl.ts` reads the sitemap (robots.txt,
  sitemap indexes followed, same site only), then each page's title, meta
  description, H1, main content, structured data and whether the supplement
  disclaimer shows, into `insights_site_pages` (about 60 pages a day, each
  reread weekly). It detects the platform from the HTML.
- **Fix list mode:** the autopilot plans exactly as for Shopify, through
  `autopilot/site-source.ts`, but saves each change as `suggested`: new SEO
  title, description, section, structured data and an internal link sentence,
  each with Copy and where to paste it on that platform
  (`src/lib/analytics/fix-guides.ts`). "Done, I pasted it" starts the 4 week
  measurement; a change that didn't help is flagged to change back by hand.
- **Checks:** the weekly claim guard and overlap report read the same pages.
  Rankings, site health and keywords already worked for any site.

### WordPress (automatic changes)

`wordpress-plugin/insights-connector` is a small plugin (built into
`neon/insights/public/insights-connector.zip`, downloadable from the
dashboard). Activating it creates a private key; Settings > Insights >
"Connect to Insights" opens `/api/wordpress/connect`, which signs the owner in
if needed, checks the plugin answers with that key and saves the connection
(encrypted). From then on the autopilot edits WordPress like a Shopify store
(`autopilot/wordpress.ts`, `autopilot/site-source.ts`):

- SEO title and description go into Yoast, Rank Math, SEOPress or All in One
  SEO, whichever is active, or the plugin shows them itself.
- New sections are appended only if the post is unchanged since it was read.
- Structured data is stored apart from the content and printed in the head.
- Everything is logged and undoable like on Shopify. Deactivating the plugin
  disconnects it.

### Webflow and Wix

- **Webflow** (`autopilot/webflow.ts`): the owner pastes a site API token
  (Sites, Pages, CMS read and write). Static pages get SEO title and
  description updates, published only when the site has no other unpublished
  work (otherwise saved for the owner's next publish). CMS items (blog posts)
  get their SEO fields (matched by name) and new sections in the rich text
  body, written to the live item. Structured data and static page content go
  on the fix list (site tokens can't reach custom code).
- **Wix** (`autopilot/wix.ts`): the owner pastes an API key with Wix Blog
  permissions and the dashboard address (holding the site id). Blog posts get
  SEO title, meta description and structured data as SEO tags, published
  right away. Static pages and post text have no edit API, so those go on the
  fix list.

Each platform's writer says what it supports per item (`SiteWriter.supports`);
anything it can't do becomes a fix list item, so one run can mix automatic
changes and suggestions.

### The one-line snippet (custom code, AI builders, any site)

`autopilot/snippet.ts`. Sites with no usable API add
`<script async src="<APP_URL>/s.js?k=<site key>"></script>` to their header
once (the dashboard shows where for Squarespace, Framer, GoDaddy, Duda,
Weebly, Ghost, HubSpot, custom code and AI builders, and checks the live home
page for it). On each page view the script asks `/api/snippet/data` for that
page's live changes and applies them: SEO title, meta description, structured
data and internal link sentences. Nothing is stored on the site: the snippet
serves the autopilot's applied or kept changes (`resource_type = 'snippet'`),
so Undo removes a change from the site at once. Page text stays on the fix
list.

### Adding an app to the autopilot

Each data source the autopilot uses is an app in
`src/lib/analytics/autopilot/apps/` (Search Console, Google Analytics, Keyword
Planner, Google page one). An app implements `RankingApp` and can:

- `candidates`: suggest pages and searches to work on
- `enrich`: add facts and score weights to every candidate, whichever app found it
- `brief`: tell the writer what it knows about the chosen target, and add a line to the run summary

Apps share what they learn through `hub.shared` and run in the order listed in
`apps/index.ts`, so a later app can build on an earlier one. To add an API,
write one file that exports a `RankingApp` (put its key in `PlatformSettings`
if it needs one) and add it to `RANKING_APPS`. It then shows up under "Apps
working together" on the Autopilot page.

**Preview next run** on the Autopilot page (POST `/api/autopilot/preview`)
goes through a whole run on live data and shows what would change, without
writing anything to the store, measuring, or counting as a run.

### Running it as a SaaS

Customers only click **Sign in with Google** (creates their account and
connects Analytics and Search Console) and **Connect Shopify** (OAuth
install of the platform's public Shopify app, expiring offline tokens that
refresh automatically). All data is scoped to the signed-in account.

The platform owner (emails in `ADMIN_EMAILS`) sets up, once:
- the Google OAuth client (Settings, Platform owner);
- the AI keys (any of Claude / `ANTHROPIC_API_KEY`, Groq / `GROQ_API_KEY`, GitHub Models / `GITHUB_MODELS_TOKEN`, Gemini / `GEMINI_API_KEY`; extra ones are backups) and the public Shopify app's Client ID and secret
  (SEO Autopilot, Platform keys); app redirect URL
  `/api/shopify/callback`, webhooks to `/api/shopify/webhooks`;
- Google Ads for keyword data (SEO Tools, Keyword ideas, Connect Google Ads,
  then the developer token).

Sessions are signed with `SESSION_SECRET`. The scheduled trigger runs
hourly and processes up to three customers whose daily run is due.

### Adding more apps later

The data layer lives in `src/lib/analytics/`:

- `ga4.ts` and `gsc.ts` are the two live connectors. A new app gets its own
  file following the same shape (take a date range, return typed data).
- `overview.ts` calls each connector and returns one response to the page.
- `integrations.ts` lists every app shown under Connected Apps. Google Ads,
  Meta, Mailchimp and Shopify are already listed as coming soon.

The UI is in `src/components/analytics/`.

## Data model

Firestore stores one document per user at `users/{uid}`:

```ts
{
  uid, email, displayName,
  answers,               // everything the user selected in the quiz
  plan,                  // generated routine, tips, focus areas
  recommendedProductIds, // computed product matches
  createdAt, updatedAt
}
```

## Project structure

```
src/
  app/            # routes: / (quiz), /login, /signup, /dashboard, /analytics
  components/     # Navbar, Hero, Quiz, Dashboard, cards, etc.
  lib/            # firebase, auth-context, firestore, quiz-data,
                  # products, recommendations, quiz-storage
  types/          # shared TypeScript types
```

## Deploy

Deploy to any Next.js host (Vercel recommended). Add the same
`NEXT_PUBLIC_FIREBASE_*` environment variables in your host's dashboard.
