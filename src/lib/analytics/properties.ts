import { listGa4Properties } from "./ga4";
import type { GoogleAuth } from "./google-auth";
import { listGscSites } from "./gsc";
import type { PropertyOptions } from "./types";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Lists both kinds of property, keeping one failure from hiding the other. */
export async function listProperties(auth: GoogleAuth): Promise<PropertyOptions> {
  const [ga, gsc] = await Promise.allSettled([listGa4Properties(auth), listGscSites(auth)]);
  return {
    ga: ga.status === "fulfilled" ? { items: ga.value } : { items: [], error: message(ga.reason) },
    gsc: gsc.status === "fulfilled" ? { items: gsc.value } : { items: [], error: message(gsc.reason) },
  };
}
