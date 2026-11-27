"use client";

import { useEffect, useState } from "react";
import type { CampaignMetrics, CampaignRow } from "@/lib/analytics/newsletter";
import { apiFresh } from "./seo-ui";
import { Card } from "./ui";

type Rates = Record<"delivered" | "bounced" | "complained" | "unsubscribed" | "opens" | "clicks", number | null>;
interface MetricsData {
  total: CampaignMetrics;
  rates: Rates;
  campaigns: (CampaignRow & { rates: Rates })[];
  growth: { week: string; subscribed: number; unsubscribed: number }[];
  sales: { orders: number; revenue: number; currency: string | null; days: number; capped: boolean } | "access" | "failed" | null;
  tracking: { events: boolean };
}

const n = (v: number) => v.toLocaleString("en-US");
const rate = (v: number | null) => (v === null ? "none yet" : `${v}%`);
const money = (v: number, c: string | null) => {
  try {
    return v.toLocaleString("en-US", { style: "currency", currency: c || "USD", maximumFractionDigits: 0 });
  } catch {
    return `${Math.round(v)}`;
  }
};
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
const KIND: Record<CampaignRow["kind"], string> = { campaign: "", welcome: "Welcome", weekly: "Weekly" };

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-dash-line p-4">
      <p className="text-xs text-dash-muted">{label}</p>
      <p className="font-serif text-2xl text-dash-ink">{value}</p>
      {sub && <p className="mt-1 text-xs text-dash-muted">{sub}</p>}
    </div>
  );
}

/** The newsletter's results: four numbers and one line per email first; delivery details and growth behind Advanced. */
export function NewsletterMetrics({ active, reload }: { active: boolean; reload: number }) {
  const [data, setData] = useState<MetricsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    if (!active) return;
    apiFresh<MetricsData>("/api/newsletter?metrics=1")
      .then((d) => (setData(d), setError(null)))
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load the results."));
  }, [active, reload]);
  if (error && !data) return <Card><p className="text-sm text-red-700">{error}</p></Card>;
  if (!data) return <Card><p className="text-sm text-dash-muted">Loading the results...</p></Card>;
  if (!data.total.sent) return null;
  const t = data.total;
  const shop = data.sales && typeof data.sales === "object" ? data.sales : null;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-serif text-xl text-dash-ink">Results</h2>
        <button className="text-sm font-semibold text-dash-green hover:underline" onClick={() => setAdvanced(!advanced)}>{advanced ? "Simple view" : "Advanced"}</button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Emails sent" value={n(t.sent)} sub={t.delivered ? `${rate(data.rates.delivered)} delivered` : undefined} />
        <Tile label="Opened" value={rate(data.rates.opens)} sub={`${n(t.uniqueOpens)} people, approximate`} />
        <Tile label="Clicked" value={rate(data.rates.clicks)} sub={`${n(t.uniqueClicks)} people`} />
        {shop ? (
          <Tile label={`Sales from the newsletter, last ${shop.days} days`} value={money(shop.revenue, shop.currency)} sub={`${n(shop.orders)} ${shop.orders === 1 ? "order" : "orders"}${shop.capped ? ", at least" : ""}, from Shopify`} />
        ) : (
          <Tile label="Unsubscribed" value={rate(data.rates.unsubscribed)} sub={`${n(t.unsubscribed)} people, from your unsubscribe link`} />
        )}
      </div>
      {data.sales === "access" && <p className="mt-2 text-xs text-dash-muted">To show sales, allow DashPatrol to read orders in Shopify (reconnect Shopify once).</p>}
      {data.sales === "failed" && <p className="mt-2 text-xs text-dash-muted">Sales couldn't be read from Shopify just now. They show again on the next try.</p>}
      {!data.tracking.events && (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          No opens or clicks yet. They come from Resend: add the webhook in Advanced settings, and turn on open and click tracking for your sending domain in Resend.
        </p>
      )}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="text-xs text-dash-muted">
            <tr>
              <th className="py-2 pr-3 font-medium">Email</th>
              <th className="py-2 pr-3 font-medium">Sent</th>
              <th className="py-2 pr-3 font-medium">Opened</th>
              <th className="py-2 pr-3 font-medium">Clicked</th>
              <th className="py-2 pr-3 font-medium">Unsubscribed</th>
              {shop && <th className="py-2 pr-3 font-medium">Orders</th>}
              {advanced && <th className="py-2 pr-3 font-medium">Delivered</th>}
              {advanced && <th className="py-2 pr-3 font-medium">Bounced</th>}
              {advanced && <th className="py-2 pr-3 font-medium">Spam reports</th>}
              {advanced && <th className="py-2 pr-3 font-medium">Opens, clicks (all)</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-dash-line">
            {data.campaigns.map((c) => (
              <tr key={c.id}>
                <td className="py-2 pr-3">
                  <span className="font-medium text-dash-ink">{c.subject}</span>
                  <span className="ml-2 text-xs text-dash-muted">{[KIND[c.kind], c.auto ? "sent on its own" : "", day(c.at)].filter(Boolean).join(", ")}</span>
                </td>
                <td className="py-2 pr-3">{n(c.metrics.sent)}</td>
                <td className="py-2 pr-3">{rate(c.rates.opens)}</td>
                <td className="py-2 pr-3">{rate(c.rates.clicks)}</td>
                <td className="py-2 pr-3">{n(c.metrics.unsubscribed)}</td>
                {shop && <td className="py-2 pr-3">{c.sales ? `${n(c.sales.orders)}, ${money(c.sales.revenue, shop.currency)}` : ""}</td>}
                {advanced && <td className="py-2 pr-3">{n(c.metrics.delivered)}</td>}
                {advanced && <td className="py-2 pr-3">{n(c.metrics.bounced)}</td>}
                {advanced && <td className="py-2 pr-3">{n(c.metrics.complained)}</td>}
                {advanced && <td className="py-2 pr-3">{n(c.metrics.opens)}, {n(c.metrics.clicks)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {advanced && <Growth rows={data.growth} />}
      <p className="mt-3 text-xs text-dash-muted">
        Opens and clicks need open and click tracking turned on for your domain in Resend. Opens are approximate: Apple Mail opens emails on its own to protect privacy, so some opens are counted for people who never read the email.
        {shop ? " Sales count orders whose visit came from a newsletter link, read from Shopify. A sale after an email is a good sign, not proof the email caused it." : ""}
      </p>
    </Card>
  );
}

function Growth({ rows }: { rows: MetricsData["growth"] }) {
  const top = Math.max(1, ...rows.map((r) => Math.max(r.subscribed, r.unsubscribed)));
  return (
    <div className="mt-5">
      <h3 className="text-sm font-semibold text-dash-ink">Subscribers by week</h3>
      <ul className="mt-2 space-y-1 text-xs">
        {rows.map((r) => (
          <li key={r.week} className="grid grid-cols-[5rem_1fr_6rem] items-center gap-2">
            <span className="text-dash-muted">{day(`${r.week}T12:00:00Z`)}</span>
            <span className="flex h-3 gap-1">
              <span className="rounded bg-dash-green" style={{ width: `${(r.subscribed / top) * 50}%` }} />
              <span className="rounded bg-amber-400" style={{ width: `${(r.unsubscribed / top) * 50}%` }} />
            </span>
            <span className="text-dash-muted">+{n(r.subscribed)}, {n(r.unsubscribed)} left</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-dash-muted">Green: people who joined. Yellow: people who unsubscribed.</p>
    </div>
  );
}
