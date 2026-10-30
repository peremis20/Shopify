import type { ChangeField } from "./autopilot/types";

/**
 * Where to paste each kind of fix, per website platform, in plain words.
 * Shared by the server and the page (no server-only imports).
 */

export type Platform = "shopify" | "wordpress" | "wix" | "squarespace" | "webflow" | "framer" | "godaddy" | "duda" | "weebly" | "ghost" | "hubspot" | "custom";

export const PLATFORM_LABEL: Record<Platform, string> = {
  shopify: "Shopify",
  wordpress: "WordPress",
  wix: "Wix",
  squarespace: "Squarespace",
  webflow: "Webflow",
  framer: "Framer",
  godaddy: "GoDaddy Website Builder",
  duda: "Duda",
  weebly: "Weebly",
  ghost: "Ghost",
  hubspot: "HubSpot",
  custom: "a custom website",
};

type Where = Partial<Record<ChangeField, string>>;

const CUSTOM: Where = {
  meta_title: "Send this to whoever edits your site: it goes in the page's <title> tag, inside <head>.",
  meta_description: 'Send this to whoever edits your site: it goes in <meta name="description" content="..."> inside <head>.',
  content: "Add this as a new section near the end of the page (it's ready to use HTML).",
  new_article: "Add this as a new blog post: the first line is its headline, then paste the SEO title and description into your SEO settings and the rest as the post body (ready to use HTML).",
  schema: "Paste this in the page's <head> or just before </body>. It tells Google what the page is about.",
  internal_link: "Add this sentence to the end of the other page shown, keeping the link.",
};

const GUIDES: Record<string, Where> = {
  wordpress: {
    meta_title: "Edit the page in WordPress, scroll to the Yoast SEO or Rank Math box, and paste this into SEO title.",
    meta_description: "Same box (Yoast SEO or Rank Math): paste this into Meta description. Then Update.",
    content: "Edit the page, add a Custom HTML block where it fits (near the end is fine), paste, then Update.",
    schema: "Edit the page, add a Custom HTML block at the very end, paste, then Update. (Rank Math users can use its Schema tab instead.)",
    internal_link: "Edit the other page shown, add a Paragraph or Custom HTML block at the end, paste, then Update.",
  },
  wix: {
    meta_title: "In the Wix editor: Pages menu, the ⋯ next to this page, SEO basics, then paste into Title tag. Publish.",
    meta_description: "Same place (SEO basics): paste into Meta description. Publish.",
    content: "Add a text section to the page and paste the text in (Wix keeps headings and lists). Publish.",
    schema: "Pages menu, the ⋯ next to this page, SEO basics, Advanced SEO, Structured data markup, Add new markup, paste. Publish.",
    internal_link: "Open the other page shown, add the sentence in a text box near the end, select the link words and link them. Publish.",
  },
  squarespace: {
    meta_title: "Pages panel, the gear next to this page, SEO tab: paste into SEO Title. Save.",
    meta_description: "Same SEO tab: paste into SEO Description. Save.",
    content: "Edit the page, add a Text block (or a Code block for the exact HTML) near the end, paste. Save.",
    schema: "Pages panel, the gear next to this page, Advanced, Page Header Code Injection: paste. Save.",
    internal_link: "Edit the other page shown, add a Text block near the end with the sentence and its link. Save.",
  },
  webflow: {
    meta_title: "Pages panel, the gear next to this page (or the CMS item for blog posts), SEO settings: paste into Title Tag. Publish.",
    meta_description: "Same SEO settings: paste into Meta Description. Publish.",
    content: "Add a Rich Text element (or the CMS post body) near the end and paste. Publish.",
    schema: "Page settings, Custom Code, Inside <head> tag: paste. Publish.",
    internal_link: "Open the other page shown and add the sentence with its link at the end. Publish.",
  },
  shopify: {
    meta_title: "Shopify admin, the page or post, Search engine listing, Edit: paste into Page title. Save.",
    meta_description: "Same Search engine listing box: paste into Meta description. Save.",
    content: "Edit the page or post, click Show HTML (<>), paste at the end. Save.",
    schema: "Edit the page or post, Show HTML (<>), paste at the very end. Save.",
    internal_link: "Edit the other page shown and add the sentence with its link at the end. Save.",
  },
};

export function fixGuide(platform: string | null | undefined, field: ChangeField): string {
  return GUIDES[platform ?? ""]?.[field] ?? CUSTOM[field] ?? "Add this to the page shown.";
}
