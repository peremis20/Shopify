import crypto from "crypto";
import { ensureSchema, sql } from "../db";
import { shopifyGql, type StoreAccess } from "./shopify";
import { report } from "./status";

/**
 * The Leads keeper. A form on the site (a wholesale or quote request, say) sends a copy of what the visitor typed to
 * DashPatrol, keyed by the site's own public key. Each request is kept on the site's account first, so none is lost,
 * then saved in the store's Shopify Customers with tags and a note, so the owner can follow up from one list there.
 * The visitor is never subscribed to email marketing: they asked about a deal, not for a newsletter.
 *
 * Each site keeps its own leads only. A request is accepted only from the site's own address, a few per visitor an
 * hour, and a filled hidden field marks a bot.
 */

export interface Lead {
  business: string;
  name: string;
  email: string;
  phone: string;
  interest: string;
  type: string;
  details: string;
  /** Where on the site it came from, e.g. "Wholesale page". */
  source: string;
}

/** The tag every lead gets in Shopify; set here, never by the visitor. */
export const LEAD_TAG = "Website lead";

const cut = (v: unknown, n: number) =>
  typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, n) : "";
const EMAIL = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
/** Shopify tags can't hold commas. */
const tagOf = (v: string) => v.replace(/[,<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);

/** The visitor's form, cleaned; null for a bot (the hidden field was filled) or a request without a usable email. */
export function cleanLead(input: unknown): Lead | null {
  if (!input || typeof input !== "object") return null;
  const b = input as Record<string, unknown>;
  if (cut(b.website, 200)) return null;
  const email = cut(b.email, 254).toLowerCase();
  if (!EMAIL.test(email)) return null;
  return {
    business: cut(b.business, 120),
    name: cut(b.name, 120),
    email,
    phone: cut(b.phone, 40),
    interest: cut(b.interest, 80),
    type: cut(b.type, 80),
    details: cut(b.details, 2000),
    source: cut(b.source, 80),
  };
}

/** True when the request came from the site itself (its domain, www, or its myshopify address). */
export function fromSite(origin: string | null, siteDomain: string | null, shopDomain?: string | null): boolean {
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = (d: string | null | undefined) => (d ?? "").toLowerCase().replace(/^www\./, "");
  const site = bare(siteDomain);
  return Boolean((site && (host === site || host === `www.${site}`)) || (shopDomain && host === shopDomain.toLowerCase()));
}

/** The note on a new Shopify customer, in plain words. */
export function leadNote(lead: Lead, at: Date): string {
  const day = at.toISOString().slice(0, 10);
  const lines = [
    `Website request ${day}${lead.source ? ` (${lead.source})` : ""}`,
    lead.business && `Business: ${lead.business}`,
    lead.type && `Business type: ${lead.type}`,
    lead.interest && `Interested in: ${lead.interest}`,
    lead.phone && `Phone: ${lead.phone}`,
    lead.details && `Details: ${lead.details}`,
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * The lead's Shopify tags: the fixed lead tag, and what the visitor picked behind a "Lead:" prefix, so a visitor can
 * never give themselves a tag a store uses for pricing or discounts (like "wholesale").
 */
export const leadTags = (lead: Lead) =>
  [...new Set([LEAD_TAG, ...[lead.source, lead.interest].filter(Boolean).map((v) => tagOf(`Lead: ${v}`))])];

/** Splits "Jimmy Jean Louis" into a first and last name for Shopify. */
export function splitName(name: string): { firstName?: string; lastName?: string } {
  const parts = name.split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/** True when Shopify refused because the app may not work with customers yet (the owner allows it once). */
export const needsCustomerAccess = (e: unknown) =>
  /access denied|write_customers|read_customers|protected customer data|not approved|required access/i.test(String((e as Error)?.message ?? e));

async function ensureTable(): Promise<void> {
  await ensureSchema();
  await sql`CREATE TABLE IF NOT EXISTS insights_leads (
    id bigserial PRIMARY KEY,
    account_id bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    data jsonb NOT NULL,
    visitor text,
    shopify_customer text,
    sync_state text NOT NULL DEFAULT 'waiting',
    sync_note text,
    tried_at timestamptz
  )`;
  await sql`ALTER TABLE insights_leads ADD COLUMN IF NOT EXISTS shop_domain text`;
  await sql`ALTER TABLE insights_leads ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0`;
  await sql`CREATE INDEX IF NOT EXISTS insights_leads_account ON insights_leads (account_id, created_at DESC)`;
}

const visitorOf = (ip: string, accountId: string) =>
  crypto.createHash("sha256").update(`${process.env.SESSION_SECRET ?? ""}|lead|${accountId}|${ip}`).digest("hex").slice(0, 32);

/** Tries before a lead Shopify keeps refusing is left for the owner (it stays on the Leads card). */
const MAX_TRIES = 5;

/**
 * Keeps a request on the account. A visitor or site sending too many in an hour is still kept, but held: it is shown
 * on the Leads card and never sent to Shopify, so a flood can't fill the store with junk customers or push out real
 * requests.
 */
export async function keepLead(accountId: string, lead: Lead, ip: string, shopDomain: string | null): Promise<{ id: string; held: boolean }> {
  await ensureTable();
  const visitor = visitorOf(ip || "unknown", accountId);
  const [n] = await sql`SELECT count(*) FILTER (WHERE visitor = ${visitor})::int AS mine, count(*)::int AS all
    FROM insights_leads WHERE account_id = ${accountId} AND created_at > now() - interval '1 hour'`;
  const held = Number(n?.mine ?? 0) >= 5 || Number(n?.all ?? 0) >= 30;
  const [row] = await sql`INSERT INTO insights_leads (account_id, data, visitor, shop_domain, sync_state, sync_note)
    VALUES (${accountId}, ${JSON.stringify(lead)}::jsonb, ${visitor}, ${shopDomain}, ${held ? "held" : "waiting"},
      ${held ? "Too many requests in an hour, so this one was not sent to Shopify." : null})
    RETURNING id`;
  return { id: String(row!.id), held };
}

/**
 * Saves one lead in Shopify. A new email becomes a customer with the tags and a note, never subscribed to email
 * marketing. A customer who already exists only gets the lead tags: their own note and details are never changed.
 */
async function saveInShopify(store: StoreAccess, lead: Lead, at: Date): Promise<string> {
  const tags = leadTags(lead);
  const found = await shopifyGql<{ customers: { nodes: { id: string; defaultEmailAddress: { emailAddress: string | null } | null }[] } }>(
    store,
    `query($q: String!) { customers(first: 5, query: $q) { nodes { id defaultEmailAddress { emailAddress } } } }`,
    { q: `email:"${lead.email}"` },
  );
  // Shopify's search isn't an exact match: only a customer with exactly this email counts.
  const cur = found.customers.nodes.find((c) => c.defaultEmailAddress?.emailAddress?.toLowerCase() === lead.email);
  if (cur) {
    await shopifyGql(store, `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`, { id: cur.id, tags });
    return cur.id;
  }
  // No email marketing consent is set, so Shopify keeps the customer unsubscribed. The phone stays in the note: Shopify
  // rejects a customer whose phone isn't in its exact international format.
  const made = await shopifyGql<{ customerCreate: { customer: { id: string } | null } }>(
    store,
    `mutation($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`,
    { input: { email: lead.email, ...splitName(lead.name), note: leadNote(lead, at), tags } },
  );
  if (!made.customerCreate.customer) throw new Error("Shopify didn't return the new customer.");
  return made.customerCreate.customer.id;
}

/**
 * Saves the account's due leads in Shopify, oldest first, up to `max` (or only the leads in `only`). Each row is claimed
 * before it is sent, so two runs never send the same lead. Without customer access the rest wait for the next day; any
 * other refusal is noted on that lead and the others still go. After five refusals a lead is left on the Leads card.
 */
export async function syncLeads(accountId: string, store: StoreAccess | null, max = 10, only?: string[]): Promise<string | null> {
  await ensureTable();
  const ids = only?.length ? only.filter((x) => /^\d+$/.test(x)).join(",") : null;
  const rows = await sql`UPDATE insights_leads SET tried_at = now(), attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM insights_leads WHERE account_id = ${accountId} AND shopify_customer IS NULL AND sync_state <> 'held' AND attempts < ${MAX_TRIES}
        AND (tried_at IS NULL OR (sync_state IN ('access', 'no-store') AND tried_at < now() - interval '1 day') OR (sync_state NOT IN ('access', 'no-store') AND tried_at < now() - interval '50 minutes'))
        AND (${ids ?? ""} = '' OR id = ANY(string_to_array(${ids ?? ""}, ',')::bigint[]))
      ORDER BY created_at LIMIT ${max} FOR UPDATE SKIP LOCKED)
    RETURNING id, created_at, data, attempts`;
  if (!rows.length) return null;
  if (!store) {
    // Tried again daily without using up its tries, so it goes through once a store is connected.
    await sql`UPDATE insights_leads SET sync_state = 'no-store', sync_note = 'No Shopify store is connected.', attempts = attempts - 1
      WHERE id = ANY(string_to_array(${rows.map((r) => String(r.id)).join(",")}, ',')::bigint[])`;
    return `${rows.length} lead(s) kept; no Shopify store is connected`;
  }
  let saved = 0;
  let refused = 0;
  for (const [i, r] of rows.entries()) {
    const lead = (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Lead;
    try {
      const id = await saveInShopify(store, lead, new Date(String(r.created_at)));
      await sql`UPDATE insights_leads SET shopify_customer = ${id}, sync_state = 'saved', sync_note = NULL, shop_domain = coalesce(shop_domain, ${store.shopDomain})
        WHERE id = ${r.id}`;
      saved++;
    } catch (e) {
      if (needsCustomerAccess(e)) {
        // The same refusal would repeat for every lead: these and the rest wait a day, and keep their tries.
        const waiting = rows.slice(i).map((x) => String(x.id)).join(",");
        await sql`UPDATE insights_leads SET sync_state = 'access', sync_note = 'Shopify needs customer access for DashPatrol.', attempts = attempts - 1
          WHERE id = ANY(string_to_array(${waiting}, ',')::bigint[])`;
        await report("leads", false, "Shopify needs customer access for DashPatrol before leads can be saved there");
        return `${saved} lead(s) saved in Shopify; waiting for customer access`;
      }
      const note = String((e as Error)?.message ?? e).slice(0, 300);
      await sql`UPDATE insights_leads SET sync_state = 'failed', sync_note = ${note} WHERE id = ${r.id}`;
      await report("leads", false, note);
      refused++;
    }
  }
  if (!refused) await report("leads", true);
  return `${saved} lead(s) saved in Shopify${refused ? `; ${refused} refused, tried again later` : ""}`;
}

/** Accounts with leads due to be saved in Shopify, the longest waiting first. */
export async function accountsWithWaitingLeads(limit = 5): Promise<string[]> {
  await ensureTable();
  // Due: never tried, or last tried an hour ago (a day ago when Shopify needs customer access), and not given up on.
  const rows = await sql`SELECT account_id FROM insights_leads WHERE shopify_customer IS NULL AND sync_state <> 'held' AND attempts < ${MAX_TRIES}
        AND (tried_at IS NULL OR (sync_state IN ('access', 'no-store') AND tried_at < now() - interval '1 day') OR (sync_state NOT IN ('access', 'no-store') AND tried_at < now() - interval '50 minutes'))
    GROUP BY account_id ORDER BY min(created_at) LIMIT ${limit}`;
  return rows.map((r) => String(r.account_id));
}

export interface LeadView extends Lead {
  at: string;
  shopify: "saved" | "waiting" | "access" | "failed" | "gave-up" | "no-store" | "held";
  customerId: string | null;
}

/** The site's latest leads for the dashboard, and whether a Shopify store is connected. */
export async function leadsView(accountId: string): Promise<{ leads: LeadView[] }> {
  await ensureTable();
  const rows = await sql`SELECT created_at, data, shopify_customer, sync_state, attempts FROM insights_leads WHERE account_id = ${accountId} ORDER BY created_at DESC LIMIT 50`;
  const states = ["access", "failed", "no-store", "held"];
  return {
    leads: rows.map((r) => ({
      ...((typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Lead),
      at: new Date(String(r.created_at)).toISOString(),
      shopify: (r.shopify_customer
        ? "saved"
        : r.sync_state === "failed" && Number(r.attempts) >= MAX_TRIES
          ? "gave-up"
          : states.includes(String(r.sync_state)) ? r.sync_state : "waiting") as LeadView["shopify"],
      customerId: r.shopify_customer ?? null,
    })),
  };
}

/** Forgets every lead that came from a Shopify store (Shopify asked to erase the store's data). */
export async function forgetShopLeads(shopDomain: string): Promise<void> {
  await ensureTable();
  await sql`DELETE FROM insights_leads WHERE shop_domain = ${shopDomain}`;
}

/** Forgets one person's leads from a Shopify store by email (Shopify asked to erase that customer). */
export async function forgetLeadEmail(shopDomain: string, email: string): Promise<void> {
  await ensureTable();
  await sql`DELETE FROM insights_leads WHERE shop_domain = ${shopDomain} AND lower(data->>'email') = ${email.toLowerCase()}`;
}

/** What is kept about one person, for a Shopify data request: the leads they sent from that store. */
export async function leadsForEmail(shopDomain: string, email: string): Promise<Lead[]> {
  await ensureTable();
  const rows = await sql`SELECT data FROM insights_leads WHERE shop_domain = ${shopDomain} AND lower(data->>'email') = ${email.toLowerCase()} ORDER BY created_at`;
  return rows.map((r) => (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Lead);
}

/** The accounts holding leads from a Shopify store (optionally from one email), found by the store each lead remembers. */
export async function leadAccounts(shopDomain: string, email?: string): Promise<string[]> {
  await ensureTable();
  const rows = email
    ? await sql`SELECT DISTINCT account_id FROM insights_leads WHERE shop_domain = ${shopDomain} AND lower(data->>'email') = ${email.toLowerCase()}`
    : await sql`SELECT DISTINCT account_id FROM insights_leads WHERE shop_domain = ${shopDomain}`;
  return rows.map((r) => String(r.account_id));
}

/** The emails behind one account's leads from a Shopify store. */
export async function leadEmails(shopDomain: string, accountId: string): Promise<string[]> {
  await ensureTable();
  const rows = await sql`SELECT DISTINCT lower(data->>'email') AS email FROM insights_leads WHERE shop_domain = ${shopDomain} AND account_id = ${accountId}`;
  return rows.map((r) => String(r.email)).filter(Boolean);
}
