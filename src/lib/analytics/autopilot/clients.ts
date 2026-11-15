import { ensureSchema, sql } from "../db";

/**
 * Every site is worked on with its own data only. The sites of other
 * DashPatrol customers are never studied as competitors, never used as
 * writing material, and never suggested as backlinks (links between
 * customers would look like a link network to Google).
 */

let cache: { at: number; domains: Set<string> } | null = null;

const clean = (d: string | null | undefined) =>
  (d ?? "")
    .toLowerCase()
    .replace(/^sc-domain:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .trim();

async function allClientDomains(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < 600_000) return cache.domains;
  await ensureSchema();
  const rows = await sql`
    SELECT site_domain AS d FROM insights_account_profile WHERE site_domain IS NOT NULL
    UNION SELECT gsc_site_url FROM insights_account_google WHERE gsc_site_url IS NOT NULL
    UNION SELECT shop_domain FROM insights_account_autopilot WHERE shop_domain IS NOT NULL`;
  const domains = new Set(rows.map((r) => clean(r.d)).filter(Boolean));
  cache = { at: Date.now(), domains };
  return domains;
}

/** A test for "this domain belongs to another customer" (never the site's own). */
export async function otherClient(ourDomain: string): Promise<(domain: string) => boolean> {
  const ours = clean(ourDomain);
  // If the customer list can't be read, treat every outside site as possibly a customer (safe side), and don't cache that.
  const all = await allClientDomains().catch(() => null);
  return (domain: string) => {
    if (!all) {
      const d = clean(domain);
      return Boolean(d) && d !== ours && !d.endsWith(`.${ours}`);
    }
    const d = clean(domain);
    if (!d || d === ours || d.endsWith(`.${ours}`)) return false;
    for (const c of all) if (c !== ours && (d === c || d.endsWith(`.${c}`))) return true;
    return false;
  };
}

/** Whether the customer list can be read right now. Anything that saves data based on it waits when it can't. */
export async function clientListKnown(): Promise<boolean> {
  return (await allClientDomains().then(() => true).catch(() => false));
}

/**
 * The Instagram and Threads usernames other DashPatrol customers connected: never suggested to another site as a
 * creator. Null when the list can't be read, so anything that suggests accounts waits instead of guessing.
 */
export async function otherClientHandles(accountId: string): Promise<Set<string> | null> {
  try {
    await ensureSchema();
    const ig = await sql`SELECT ig_username AS h FROM insights_account_facebook WHERE account_id <> ${accountId} AND ig_username IS NOT NULL`.catch((e) =>
      /does not exist/i.test((e as Error).message) ? [] : Promise.reject(e),
    );
    const th = await sql`SELECT username AS h FROM insights_account_threads WHERE account_id <> ${accountId}`.catch((e) =>
      /does not exist/i.test((e as Error).message) ? [] : Promise.reject(e),
    );
    return new Set([...ig, ...th].map((r) => String(r.h ?? "").toLowerCase().replace(/^@/, "")).filter(Boolean));
  } catch {
    return null;
  }
}
