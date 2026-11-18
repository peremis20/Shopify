"use client";

import { useEffect, useState } from "react";
import type { ConversionChange, ConversionMove, ConversionNumbers, ConversionReport } from "@/lib/analytics/autopilot/conversion";
import { api } from "./seo-ui";
import { Card, CardHeader } from "./ui";

interface View {
  report: ConversionReport | null;
  lastNote: string | null;
}

const pct = (x: number | null) => (x === null ? "not known" : `${(Math.round(x * 1000) / 10).toFixed(1)}%`);
const IMPACT: Record<ConversionMove["impact"], string> = { high: "Big effect", medium: "Some effect", low: "Small effect" };
const REVIEW: Record<Exclude<ConversionReport["review"], "checked">, string> = {
  "no-ai": "No AI key is set up, so this week's moves couldn't be planned.",
  "no-second-ai": "No second AI was free to check this week's moves. Last week's stay.",
  failed: "This week's moves couldn't be planned. Last week's stay.",
  "out-of-time": "This week's moves ran out of time. Last week's stay.",
  "ai-limit": "The monthly AI limit was reached. Last week's moves stay.",
};

function Numbers({ n }: { n: ConversionNumbers }) {
  return (
    <div className="mb-3 text-sm text-dash-ink">
      <p>
        <span className="font-semibold">Conversion rate: {pct(n.rate)}</span>
        {n.sessions !== null && n.paidOrders !== null ? ` (${n.paidOrders} paid orders from ${n.sessions.toLocaleString()} visits, last ${n.days} days)` : ""}
        {n.freeOrders ? `. Free samples: ${n.freeOrders}.` : "."}
      </p>
      {n.funnel && <p className="mt-1 text-xs text-dash-muted">{n.funnel.map((s) => `${s.step} ${s.users.toLocaleString()}`).join(" → ")}</p>}
    </div>
  );
}

function Since({ c, now }: { c: ConversionChange; now: ConversionNumbers }) {
  return (
    <span>
      Rate {pct(c.baseline.rate)} when added, {pct(now.rate)} now
    </span>
  );
}

/** The Conversion card: the store's conversion rate and funnel, and this week's moves to raise it. */
export function Conversion() {
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    api<View>("/api/conversion").then(setView).catch(() => setView(null));
  }, []);
  if (!view) return null;
  const r = view.report;
  const act = async (action: "add" | "undo", id: string) => {
    setBusy(true);
    setError(null);
    try {
      setView(await api<View>("/api/conversion", { action, id, checkAt: r?.at ?? null }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change the page. Try again later.");
      await api<View>("/api/conversion").then(setView).catch(() => undefined);
    }
    setBusy(false);
  };
  const added = new Set((r?.changes ?? []).map((c) => c.id));
  return (
    <Card className="mt-6">
      <CardHeader title="Conversion" />
      <p className="mb-3 text-xs text-dash-muted">
        Each week an agent looks at where shoppers stop buying and picks the moves most likely to fix it. A second AI checks every move. Nothing goes on your store without you.
      </p>
      {!r && <p className="text-sm text-dash-ink">{view.lastNote ?? "The first check runs within the week."}</p>}
      {r && (
        <>
          <Numbers n={r.numbers} />
          {r.review !== "checked" && <p className="mb-2 rounded-lg bg-dash-bg p-2 text-sm text-dash-ink">{REVIEW[r.review]}</p>}
          {r.moves.length ? (
            <ul className="space-y-2">
              {r.moves.map((m) => (
                <li key={m.id} className="rounded-xl border border-dash-line p-3">
                  <p className="text-sm font-semibold text-dash-ink">{m.title}</p>
                  <p className="mt-1 text-sm text-dash-ink">{m.why}</p>
                  <p className="mt-1 text-sm text-dash-ink">{m.action}</p>
                  {m.draft && (
                    <button onClick={() => setOpen(open === m.id ? null : m.id)} className="mt-1 text-xs font-semibold text-dash-green hover:underline">
                      {open === m.id ? "Hide the words" : "See the words"}
                    </button>
                  )}
                  {open === m.id && <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-dash-bg p-2 text-xs text-dash-ink">{m.draft}</pre>}
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-dash-muted">
                    <span>
                      {IMPACT[m.impact]} · How to tell: {m.measure}
                    </span>
                    {m.add && !added.has(m.id) && (
                      <button disabled={busy} onClick={() => act("add", m.id)} className="rounded-lg bg-dash-green px-2 py-1 font-semibold text-white hover:bg-dash-deep disabled:opacity-60">
                        Add to the product page
                      </button>
                    )}
                    {added.has(m.id) && <span className="font-semibold text-dash-ink">Added</span>}
                    {!m.add && <span>You do this one</span>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-dash-muted">{r.review === "checked" ? "No clear move this week." : "No checked moves yet."}</p>
          )}
          {(r.changes ?? []).length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-xs font-semibold text-dash-ink">Sections added to product pages</p>
              <ul className="space-y-1 text-xs text-dash-ink">
                {[...(r.changes ?? [])].reverse().map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2">
                    <span>
                      {c.title}, {new Date(c.at).toLocaleDateString()}. <Since c={c} now={r.numbers} />
                    </span>
                    <button disabled={busy} onClick={() => act("undo", c.id)} className="font-semibold text-dash-green hover:underline disabled:opacity-60">
                      Undo
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-dash-muted">A rise after a change is a good sign, not proof the change caused it.</p>
            </div>
          )}
        </>
      )}
      {error && <p className="mt-2 text-sm text-dash-down">{error}</p>}
    </Card>
  );
}
