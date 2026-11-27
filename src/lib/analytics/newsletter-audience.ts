/**
 * Who a newsletter email goes to: the shared names, kept apart with no imports so the browser can use them too
 * (newsletter.ts holds the checks and the queries).
 */

export const SEGMENTS = ["shopify", "imported", "recent", "engaged", "unengaged"] as const;
export type Segment = (typeof SEGMENTS)[number];
export const SEGMENT_LABEL: Record<Segment, string> = {
  shopify: "Shopify customers",
  imported: "Imported",
  recent: "Added in the last 30 days",
  engaged: "Opened or clicked a past email",
  unengaged: "Hasn't opened the last 3",
};

/**
 * "all": everyone subscribed. "segment": anyone in one of the chosen built in segments or owner tags. "people": chosen
 * subscribers (picked from the list, CRM contacts who agreed, or typed addresses; `from` only says how they were
 * picked). Whatever the audience, only people still subscribed are ever emailed.
 */
export type Audience =
  | { type: "all" }
  | { type: "segment"; segments: Segment[]; tags: string[] }
  | { type: "people"; ids: string[]; from: "chosen" | "crm" | "typed" };
