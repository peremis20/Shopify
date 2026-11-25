/**
 * Google Analytics puts key events it can't tie to a visit (checkout or server side events, consent
 * blocked sessions) under "Unassigned" or "(not set)". They are real events but not leads from any
 * channel, so reports show them on their own line instead of counting them as channel leads.
 */
export function isUnattributed(channel: string): boolean {
  return /^\s*(unassigned|\(not set\))\s*$/i.test(channel);
}

/** Key events tied to a channel, and those Google Analytics couldn't tie to a visit. */
export function splitLeads(channels: { name: string; keyEvents: number }[]): { leads: number; unattributed: number } {
  let leads = 0;
  let unattributed = 0;
  for (const c of channels) if (isUnattributed(c.name)) unattributed += c.keyEvents; else leads += c.keyEvents;
  return { leads, unattributed };
}

/** The plain note shown under the numbers when some key events couldn't be tied to a visit. */
export function unattributedNote(n: number): string | null {
  if (n <= 0) return null;
  return `Google Analytics also recorded ${n.toLocaleString("en-US")} key ${n === 1 ? "event" : "events"} it couldn't tie to a visit (shown as Unassigned or not set). These are often checkout or server events, so they aren't counted as leads from any channel.`;
}

/**
 * Why Google Analytics sales and Shopify sales differ, said once and plainly, as possible causes and without amounts:
 * the two can be in different currencies and their 7 days are counted a little differently (Analytics by whole days to
 * yesterday, Shopify the last 168 hours), so only a clear gap is explained. Null when there is nothing to explain.
 */
export function salesGapNote(gaRevenue: number, shopRevenue: number | null | undefined): string | null {
  if (shopRevenue == null || shopRevenue <= 0 || gaRevenue <= 0) return null;
  const gap = Math.abs(shopRevenue - gaRevenue);
  if (gap <= 1 || gap / Math.max(shopRevenue, gaRevenue) <= 0.05) return null;
  return shopRevenue > gaRevenue
    ? "Google Analytics shows less in sales than Shopify this week. Shopify counts every order from every sales channel, with tax and shipping, while Analytics only counts purchases its tag saw on your site. Go by Shopify's number."
    : "Google Analytics shows more in sales than Shopify this week. That can come from test orders, a purchase tag that fires twice, or refunds Analytics doesn't know about. Go by Shopify's number.";
}
