"use client";

import { useEffect, useState } from "react";
import type { LeadView } from "@/lib/analytics/autopilot/leads";
import { api } from "./seo-ui";
import { Card, CardHeader } from "./ui";

const STATE: Record<LeadView["shopify"], string> = {
  saved: "Saved in Shopify",
  waiting: "Saving in Shopify soon",
  access: "Waiting for you to allow customer access in Shopify",
  failed: "Not saved in Shopify yet, trying again",
  "no-store": "Kept here; no Shopify store is connected",
  held: "Kept here only: too many requests came in that hour",
};

/** The Leads card: requests sent from the site's forms, newest first, and whether each is in Shopify Customers. */
export function Leads() {
  const [leads, setLeads] = useState<LeadView[] | null>(null);
  useEffect(() => {
    api<{ leads: LeadView[] }>("/api/leads").then((d) => setLeads(d.leads)).catch(() => setLeads(null));
  }, []);
  if (!leads?.length) return null;
  return (
    <Card className="mt-6">
      <CardHeader title="Leads" />
      <p className="mb-3 text-xs text-dash-muted">
        Requests from your site&apos;s forms.
        {leads.some((l) => l.shopify !== "no-store") ? " With Shopify connected, each new person is saved in Shopify Customers with the tag \"Website lead\" and a note, and never signed up for your emails." : ""}
      </p>
      <ul className="space-y-2">
        {leads.slice(0, 10).map((l, i) => (
          <li key={`${l.at}${i}`} className="rounded-xl border border-dash-line p-3 text-sm text-dash-ink">
            <p className="font-semibold break-words [overflow-wrap:anywhere]">
              {l.business || l.name || l.email}
              {l.interest ? `: ${l.interest}` : ""}
            </p>
            <p className="mt-1 break-words text-dash-ink [overflow-wrap:anywhere]">
              {[l.name, l.email, l.phone].filter(Boolean).join(", ")}
            </p>
            {l.details && <p className="mt-1 break-words text-dash-muted [overflow-wrap:anywhere]">{l.details}</p>}
            <p className="mt-1 text-xs text-dash-muted">
              {new Date(l.at).toLocaleDateString()} · {STATE[l.shopify]}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
