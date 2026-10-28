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
   Or skip the loader and deploy the whole server with the CLI:
   ```bash
   neon functions deploy insights --src neon/dist/index.mjs --no-bundle --env KEY=VALUE ...
   ```
3. Open the function URL, then paste your Google Client ID and secret under
   **Settings**. They're stored encrypted in the `insights_settings` table.

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
