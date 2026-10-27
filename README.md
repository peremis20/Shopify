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

### Connect Google (about 10 minutes)

1. In [Google Cloud Console](https://console.cloud.google.com), create or pick
   a project and enable the **Google Analytics Data API** and the
   **Google Search Console API**.
2. IAM and Admin, Service Accounts: create a service account, then open it,
   go to Keys, and add a JSON key. A file downloads.
3. Google Analytics, Admin, Property access management: add the service
   account email as a **Viewer**.
4. Search Console, Settings, Users and permissions: add the same email as a
   **Restricted** user.
5. Add these to `.env.local` (and to your host's environment settings):
   ```bash
   GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'  # whole key file on one line
   GA4_PROPERTY_ID=123456789              # GA Admin, Property details
   GSC_SITE_URL=sc-domain:example.com     # or https://www.example.com/
   DASHBOARD_PASSWORD=choose-one          # optional, locks /analytics
   ```
6. Restart the server and open http://localhost:3000/analytics.

Data is cached for 10 minutes; the Refresh button pulls fresh numbers.
Search Console reports about 3 days behind, so its date range ends earlier
than the Analytics one.

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
