"use client";

import { useCallback, useEffect, useState } from "react";
import type { ClaimReport } from "@/lib/analytics/autopilot/claim-scan";
import type { PageHealth } from "@/lib/analytics/autopilot/health";
import type { RankWatchRow } from "@/lib/analytics/autopilot/tracking";
import { ArrowDownIcon, ArrowUpIcon } from "./Icons";
import { api, Explainer, pathOf } from "./seo-ui";
import { SortHeader, useSort } from "./sorting";
import { Sparkline } from "./Sparkline";
import { Card, CardHeader, Skeleton } from "./ui";

interface Watch {
  ranks: RankWatchRow[];
  health: PageHealth[];
  claims: ClaimReport;
}

/** Daily Google positions and technical health, side by side under the autopilot. */
export function RankHealth({ connected }: { connected: boolean }) {
  const [data, setData] = useState<Watch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<Watch>("/api/autopilot/watch").then(setData).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (connected) load();
  }, [connected, load]);

  async function checkNow() {
    setBusy(true);
    setError(null);
    try {
      setData(await api<Watch>("/api/autopilot/check", {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't check right now");
    } finally {
      setBusy(false);
    }
  }

  if (!connected) return null;
  const checkButton = (
    <button
      onClick={checkNow}
      disabled={busy}
      className="rounded-lg border border-dash-line bg-white px-3 py-1.5 text-sm font-semibold text-dash-ink hover:border-dash-green/40 disabled:opacity-60"
    >
      {busy ? "Checking, about a minute…" : "Check now"}
    </button>
  );

  return (
    <div className="mt-5 grid gap-5 xl:grid-cols-2">
      <Card>
        <CardHeader title="Page one watch">{checkButton}</CardHeader>
        <Explainer>
          Your position on Google for your most important searches, checked every morning. Search Console runs about 3 days
          behind; this catches a drop the next day, and the autopilot defends it in that day&apos;s run.
        </Explainer>
        {error && <p className="mb-3 rounded-lg bg-dash-down/5 p-3 text-sm text-dash-down">{error}</p>}
        {!data ? <Skeleton className="h-48" /> : <RankTable rows={data.ranks} />}
      </Card>
      <Card>
        <CardHeader title="Site health">{checkButton}</CardHeader>
        <Explainer>
          Whether Google has your important pages indexed, the rich results it found, and how fast each page loads on a phone.
          A few pages are checked each day, so each one is rechecked about weekly.
        </Explainer>
        {!data ? <Skeleton className="h-48" /> : <HealthList pages={data.health} />}
      </Card>
      <Card className="xl:col-span-2">
        <CardHeader title="Claim guard">{checkButton}</CardHeader>
        <Explainer>
          Health claims the FTC and FDA treat as risky, found in your blog posts, pages and product descriptions: disease
          claims, &quot;FDA approved&quot;, &quot;clinically proven&quot;, guaranteed results and missing disclaimers. Checked
          weekly. The autopilot never writes these; existing wording is yours to change, with a safer version for each. This is
          a guide, not legal advice.
        </Explainer>
        {!data ? <Skeleton className="h-32" /> : <ClaimList report={data.claims} />}
      </Card>
    </div>
  );
}

function RankTable({ rows }: { rows: RankWatchRow[] }) {
  const { sorted, sort } = useSort(
    rows,
    {
      query: (r) => r.query,
      position: (r) => r.position ?? 99,
      change: (r) => (r.position !== null && r.previous !== null ? r.previous - r.position : null),
      best: (r) => r.best7,
    },
    { key: "position", dir: "asc" }
  );
  if (!rows.length) {
    return (
      <p className="py-8 text-center text-sm text-dash-muted">
        No daily checks yet. They start with the next morning run once a serper.dev key is saved, or click Check now.
      </p>
    );
  }
  return (
    <div className="max-h-[460px] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-dash-card">
          <tr className="border-b border-dash-line text-left text-xs font-semibold text-dash-ink">
            <th className="px-1 pb-2"><SortHeader label="Search" column="query" sort={sort} /></th>
            <th className="px-1 pb-2 text-right"><SortHeader label="Today" column="position" sort={sort} align="right" /></th>
            <th className="px-1 pb-2 text-right"><SortHeader label="Since yesterday" column="change" sort={sort} align="right" /></th>
            <th className="hidden px-1 pb-2 text-right sm:table-cell"><SortHeader label="Best this week" column="best" sort={sort} align="right" /></th>
            <th className="hidden px-1 pb-2 sm:table-cell">14 days</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const change = r.position !== null && r.previous !== null ? r.previous - r.position : null;
            return (
              <tr key={r.query} className="border-b border-dash-line/70 last:border-0">
                <td className="max-w-[220px] px-1 py-2 text-dash-ink">
                  <span className="block truncate" title={r.query}>{r.query}</span>
                  {r.url && <span className="block truncate text-xs text-dash-muted" title={r.url}>{pathOf(r.url)}</span>}
                </td>
                <td className="whitespace-nowrap px-1 py-2 text-right tabular-nums">
                  {r.position === null ? <span className="text-dash-muted">Off page one</span> : `#${r.position}`}
                </td>
                <td className="whitespace-nowrap px-1 py-2 text-right tabular-nums">
                  {!change ? (
                    <span className="text-dash-muted">—</span>
                  ) : (
                    <span className={`inline-flex items-center gap-0.5 font-semibold ${change > 0 ? "text-dash-up" : "text-dash-down"}`}>
                      {change > 0 ? <ArrowUpIcon className="h-3.5 w-3.5" /> : <ArrowDownIcon className="h-3.5 w-3.5" />}
                      {Math.abs(change)}
                    </span>
                  )}
                </td>
                <td className="hidden whitespace-nowrap px-1 py-2 text-right tabular-nums sm:table-cell">
                  {r.best7 === null ? "—" : `#${r.best7}`}
                </td>
                <td className="hidden px-1 py-1 sm:table-cell">
                  {r.history.filter((h) => h.position !== null).length > 1 && (
                    // Higher line means a better position; days off page one sit at the bottom.
                    <Sparkline values={r.history.map((h) => (h.position === null ? 0 : 11 - h.position))} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const LEVEL_STYLE = {
  high: "bg-dash-down/10 text-dash-down",
  medium: "bg-[#FBF1E1] text-[#8A5A12]",
  low: "bg-[#F1ECE3] text-dash-muted",
} as const;

function HealthList({ pages }: { pages: PageHealth[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!pages.length) {
    return <p className="py-8 text-center text-sm text-dash-muted">No pages checked yet. Click Check now, or wait for the next morning run.</p>;
  }
  const withIssues = pages.filter((p) => p.issues.some((i) => i.level !== "low")).length;
  const noSpeed = pages.every((p) => p.perfScore === null);
  return (
    <div className="text-sm">
      <p className="mb-2 text-dash-muted">
        {pages.length} pages checked, {withIssues ? `${withIssues} need attention` : "no problems found"}.
      </p>
      {noSpeed && (
        <p className="mb-2 rounded-lg bg-[#FBF1E1] p-2.5 text-dash-ink">
          Phone speed isn&apos;t available yet: Google&apos;s shared PageSpeed allowance is used up. Add a free Google API key
          under Platform keys and speed scores will appear on the next check.
        </p>
      )}
      <ul className="max-h-[420px] divide-y divide-dash-line/70 overflow-auto">
        {pages.map((p) => (
          <li key={p.url} className="py-2">
            <button onClick={() => setOpen(open === p.url ? null : p.url)} className="flex w-full items-center gap-2 text-left">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  p.issues.some((i) => i.level === "high") ? "bg-dash-down" : p.issues.some((i) => i.level === "medium") ? "bg-[#D9A23B]" : "bg-dash-up"
                }`}
              />
              <span className="min-w-0 flex-1 truncate text-dash-ink" title={p.url}>{pathOf(p.url)}</span>
              <span className="shrink-0 text-xs text-dash-muted">
                {p.coverage && /redirect/i.test(p.coverage) ? "Redirects" : p.indexed === false ? "Not indexed" : p.indexed ? "Indexed" : ""}
                {p.perfScore !== null ? ` · speed ${p.perfScore}` : ""}
              </span>
            </button>
            {open === p.url && (
              <div className="mt-2 space-y-2 pl-4">
                {p.richResults.length > 0 && (
                  <p className="text-dash-muted">Rich results Google found: {p.richResults.map((r) => r.type).join(", ")}.</p>
                )}
                {p.issues.length === 0 && <p className="text-dash-muted">No problems found.</p>}
                {p.issues.map((i, n) => (
                  <div key={n}>
                    <span className={`mr-2 rounded px-1.5 py-0.5 text-xs font-semibold ${LEVEL_STYLE[i.level]}`}>{i.level}</span>
                    <span className="text-dash-ink">{i.text}</span>
                    <p className="text-dash-muted">{i.fix}</p>
                  </div>
                ))}
                <a href={p.inspectUrl} target="_blank" rel="noreferrer" className="inline-block font-semibold text-dash-green hover:underline">
                  Open in Search Console (request indexing there)
                </a>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClaimList({ report }: { report: ClaimReport }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!report.checkedAt) {
    return <p className="py-8 text-center text-sm text-dash-muted">Not checked yet. Click Check now, or wait for the next morning run.</p>;
  }
  const high = report.pages.filter((p) => p.flags.some((f) => f.level === "high")).length;
  return (
    <div className="text-sm">
      <p className="mb-2 text-dash-muted">
        {report.scanned} posts, pages and products checked {new Date(report.checkedAt).toLocaleDateString()}.{" "}
        {report.pages.length
          ? `${report.pages.length} need a look${high ? `, ${high} with serious claims` : ""}.`
          : "Nothing risky found."}
      </p>
      <ul className="max-h-[420px] divide-y divide-dash-line/70 overflow-auto">
        {report.pages.map((p) => (
          <li key={p.url} className="py-2">
            <button onClick={() => setOpen(open === p.url ? null : p.url)} className="flex w-full items-center gap-2 text-left">
              <span className={`h-2 w-2 shrink-0 rounded-full ${p.flags.some((f) => f.level === "high") ? "bg-dash-down" : "bg-[#D9A23B]"}`} />
              <span className="min-w-0 flex-1 truncate text-dash-ink" title={p.url}>{p.title}</span>
              <span className="shrink-0 text-xs text-dash-muted">
                {p.kind} · {p.flags.length} {p.flags.length === 1 ? "flag" : "flags"}
              </span>
            </button>
            {open === p.url && (
              <div className="mt-2 space-y-3 pl-4">
                {p.flags.map((f, n) => (
                  <div key={n}>
                    <span className={`mr-2 rounded px-1.5 py-0.5 text-xs font-semibold ${LEVEL_STYLE[f.level]}`}>{f.level}</span>
                    <span className="font-semibold text-dash-ink">{f.phrase}</span>
                    {f.excerpt && <p className="mt-1 italic text-dash-muted">{f.excerpt}</p>}
                    <p className="mt-1 text-dash-ink">{f.why}</p>
                    <p className="text-dash-muted">Safer: {f.fix}</p>
                  </div>
                ))}
                <a href={p.url} target="_blank" rel="noreferrer" className="inline-block font-semibold text-dash-green hover:underline">
                  Open the page
                </a>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
