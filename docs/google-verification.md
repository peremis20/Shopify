# Google app verification for DashPatrol

Everything Google asks for, ready to paste. Steps happen in Google Cloud Console for the project that owns the DashPatrol OAuth client.

## 1. Branding (Google Auth Platform, Branding)

* App name: DashPatrol
* User support email: your support address
* App logo: optional (adding one adds a logo review)
* Application home page: https://dashpatrol.io
* Privacy policy: https://dashpatrol.io/privacy
* Terms of service: https://dashpatrol.io/terms
* Authorized domains: dashpatrol.io
* Developer contact email: your email

dashpatrol.io must be verified in Google Search Console by a Google account that is an Owner or Editor on this Cloud project.

## 2. Data access (scopes to list)

Only list the scopes customers are asked for. The Google Ads scope (adwords) is used only by the platform owner's own account, so leave it off.

| Scope | Type | Why DashPatrol needs it |
|---|---|---|
| openid, email | non sensitive | Sign the customer in and know which account is theirs. |
| analytics.readonly | sensitive | Read visits and revenue from organic search for the customer's own site, to measure whether each page change helped. |
| webmasters.readonly | sensitive | Read the searches the customer's pages appear for, with clicks and positions, to pick pages to improve and track rankings. |
| siteverification | sensitive | Only when the customer clicks Set it up for me: verify their site so it can be added to Search Console. |
| webmasters | sensitive | Only when the customer clicks Set it up for me (or Allow on sitemap resubmit): add the site and its sitemap to Search Console. |
| analytics.edit | sensitive | Only when the customer clicks Set it up for me: create a Google Analytics property for their site. |

All of these are sensitive, not restricted, so no paid security assessment is needed.

Short justification to paste:

> DashPatrol is an SEO tool. A site owner signs in and connects their own website. We read their Search Console data (searches, clicks, positions) and Google Analytics data (visits, revenue from search) to choose which pages to improve and to measure whether each change worked. The write scopes are requested separately, only when the owner clicks "Set it up for me", to verify their site, add it and its sitemap to Search Console, and create an Analytics property. Data is used only for that owner's site, never shared, sold or used for ads.

## 3. Demo video (unlisted YouTube link)

Record about 2 minutes, in English, showing:

1. The home page at dashpatrol.io, with the address bar visible, then Open DashPatrol.
2. Clicking Sign in with Google, and the consent screen showing the app name and scopes.
3. The dashboard showing Search Console and Analytics numbers for your own site (proof the read scopes are used).
4. Clicking Set it up for me, the second consent screen with the write scopes, and the result (site added in Search Console, Analytics property created).
5. The Privacy link on the home page.

## 4. Submit

Audience, Publishing status: click Publish app, then Prepare for verification, then paste the above and submit. Google usually replies by email within a few days to a few weeks and may ask questions. Until it is approved, up to 100 users can still sign in after clicking past the unverified warning.
