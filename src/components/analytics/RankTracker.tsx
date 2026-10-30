"use client";

import { useEffect, useState } from "react";
import type { RankWatchRow } from "@/lib/analytics/autopilot/tracking";
import type { KeywordList, Ranking } from "@/lib/analytics/seo-types";
import { formatNumber } from "./format";
import { ArrowDownIcon, ArrowUpIcon, CloseIcon } from "./Icons";
import { api, Explainer, pathOf, RankForThis } from "./seo-ui";
import { SortHeader, useSort } from "./sorting";
import { Sparkline } from "./Sparkline";
import { Skeleton } from "./ui";

export function RankTracker({ lists, activeId, setActiveId, update }: {
  lists: KeywordList[] | null;
  activeId: string | null;
  setActiveId: (id: string) => void;
  update: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [rankings, setRankings] = useState<Ranking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newKeyword, setNewKeyword] = useState("");
  const [newList, setNewList] = useState("");

  const active = lists?.find((l) => l.id === activeId) ?? null;
  const keywordKey = active?.keywords.join("|") ?? "";

  useEffect(() => {
    if (!active) return;
    if (!active.keywords.length) {
      setRankings([]);
      return;
    }
    setRankings(null);
    setError(null);
    api<{ rankings: Ranking[] }>(`/api/seo/rankings?listId=${active.id}`)
      .then((d) => setRankings(d.rankings))
      .catch((err) => setError(err.message));
    // keywordKey reloads when keywords are added or removed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, keywordKey]);

  const { sorted, sort } = useSort(
    rankings ?? [],
    {
      keyword: (r) => r.keyword,
      position: (r) => r.position,
      change: (r) => r.change,
      clicks: (r) => r.clicks,
      page: (r) => (r.topPage ? pathOf(r.topPage) : null),
    },
    { key: "position", dir: "asc" }
  );

  if (!lists) return <Skeleton className="h-48" />;

  return (
    <div>
      <GoogleToday />
      <Explainer>
        Your Google position for each keyword, week by week, from Search Console. History goes back 12 weeks right away,
        so there&apos;s nothing to wait for. Add keywords here or with the Track buttons in the other tabs.
      </Explainer>

      <div className="mb-4 flex flex-wrap items-end gap-3 text-sm">
        {lists.length > 0 && (
          <label className="block">
            <span className="mb-1 block text-xs text-dash-muted">List</span>
            <select
              id="rank-list"
              value={activeId ?? ""}
              onChange={(e) => setActiveId(e.target.value)}
              className="rounded-lg border border-dash-line bg-white px-3 py-2"
            >
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.keywords.length})
                </option>
              ))}
            </select>
          </label>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!newKeyword.trim()) return;
            const keywords = newKeyword.split(",").map((k) => k.trim()).filter(Boolean);
            (active
              ? update({ action: "add", listId: active.id, keywords })
              : update({ action: "create", name: "My keywords", keywords })
            ).then(() => setNewKeyword(""));
          }}
          className="flex items-end gap-2"
        >
          <label className="block">
            <span className="mb-1 block text-xs text-dash-muted">Add keywords</span>
            <input
              id="rank-add"
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              placeholder="neuro plus, brain supplements"
              className="w-64 max-w-full rounded-lg border border-dash-line bg-white px-3 py-2"
            />
          </label>
          <button type="submit" className="rounded-lg bg-dash-green px-4 py-2 font-semibold text-white hover:bg-dash-deep">
            Add
          </button>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (newList.trim()) update({ action: "create", name: newList.trim() }).then(() => setNewList(""));
          }}
          className="flex items-end gap-2"
        >
          <label className="block">
            <span className="mb-1 block text-xs text-dash-muted">New list</span>
            <input
              id="rank-new-list"
              value={newList}
              onChange={(e) => setNewList(e.target.value)}
              placeholder="Blog topics"
              className="w-40 rounded-lg border border-dash-line bg-white px-3 py-2"
            />
          </label>
          <button type="submit" className="rounded-lg border border-dash-line bg-white px-4 py-2 font-semibold text-dash-ink">
            Create
          </button>
        </form>
        {active && (
          <button
            onClick={() => update({ action: "delete", listId: active.id })}
            className="ml-auto text-xs font-semibold text-dash-down hover:underline"
          >
            Delete this list
          </button>
        )}
      </div>

      {error && <p className="rounded-lg bg-dash-down/5 p-3 text-sm text-dash-down">{error}</p>}

      {!active || active.keywords.length === 0 ? (
        <p className="py-8 text-center text-sm text-dash-muted">
          No keywords tracked yet. Add some above, or use + Track in Opportunities or Keyword ideas.
        </p>
      ) : !rankings ? (
        <Skeleton className="h-48" />
      ) : (
        <div className="max-h-[520px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-dash-card">
              <tr className="border-b border-dash-line text-left text-xs font-semibold text-dash-ink">
                <th className="px-1 pb-2"><SortHeader label="Keyword" column="keyword" sort={sort} /></th>
                <th className="px-1 pb-2 text-right"><SortHeader label="Position" column="position" sort={sort} align="right" /></th>
                <th className="px-1 pb-2 text-right"><SortHeader label="4 weeks" column="change" sort={sort} align="right" /></th>
                <th className="hidden px-1 pb-2 sm:table-cell">12 weeks</th>
                <th className="hidden px-1 pb-2 text-right sm:table-cell"><SortHeader label="Clicks" column="clicks" sort={sort} align="right" /></th>
                <th className="hidden px-1 pb-2 md:table-cell"><SortHeader label="Ranking page" column="page" sort={sort} /></th>
                <th className="px-1 pb-2" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.keyword} className="border-b border-dash-line/70 last:border-0">
                  <td className="max-w-[220px] truncate px-1 py-2 text-dash-ink" title={r.keyword}>{r.keyword}</td>
                  <td className="whitespace-nowrap px-1 py-2 text-right tabular-nums">
                    {r.position === null ? <span className="text-dash-muted">Not in results</span> : r.position.toFixed(1)}
                  </td>
                  <td className="whitespace-nowrap px-1 py-2 text-right tabular-nums">
                    {r.change === null || r.change === 0 ? (
                      <span className="text-dash-muted">—</span>
                    ) : (
                      <span className={`inline-flex items-center gap-0.5 font-semibold ${r.change > 0 ? "text-dash-up" : "text-dash-down"}`}>
                        {r.change > 0 ? <ArrowUpIcon className="h-3.5 w-3.5" /> : <ArrowDownIcon className="h-3.5 w-3.5" />}
                        {Math.abs(r.change).toFixed(1)}
                      </span>
                    )}
                  </td>
                  <td className="hidden px-1 py-1 sm:table-cell">
                    {r.weeks.filter((w) => w.position !== null).length > 1 && (
                      // Higher line means a better (smaller) position; weeks with no data sit at the bottom.
                      <Sparkline values={r.weeks.map((w) => (w.position === null ? 0 : 101 - Math.min(w.position, 100)))} />
                    )}
                  </td>
                  <td className="hidden px-1 py-2 text-right tabular-nums sm:table-cell">{formatNumber(r.clicks)}</td>
                  <td className="hidden max-w-[200px] truncate px-1 py-2 text-dash-muted md:table-cell" title={r.topPage}>
                    {r.topPage ? pathOf(r.topPage) : "—"}
                  </td>
                  <td className="px-1 py-2 text-right">
                    <button
                      onClick={() => update({ action: "remove", listId: active.id, keyword: r.keyword })}
                      className="rounded p-1 text-dash-muted hover:bg-black/5 hover:text-dash-down"
                      aria-label={`Stop tracking ${r.keyword}`}
                    >
                      <CloseIcon className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * What the daily rank check found on Google, for every search it watches.
 * Works from day one, before Search Console has any data.
 */
function GoogleToday() {
  const [rows, setRows] = useState<RankWatchRow[] | null>(null);
  const [roles, setRoles] = useState<Record<string, "main" | "support">>({});

  useEffect(() => {
    api<{ ranks: RankWatchRow[]; roles?: Record<string, "main" | "support"> }>("/api/autopilot/watch")
      .then((d) => {
        setRows(d.ranks);
        setRoles(d.roles ?? {});
      })
      .catch(() => setRows([]));
  }, []);

  if (!rows) return <Skeleton className="mb-6 h-24" />;
  // Main (long tail) targets first, then the broad searches that support them.
  const sorted = [...rows].sort(
    (a, b) =>
      Number(roles[a.query] === "support") - Number(roles[b.query] === "support") ||
      (a.position ?? 999) - (b.position ?? 999) ||
      a.query.localeCompare(b.query)
  );

  return (
    <div className="mb-6">
      <h3 className="mb-1 text-sm font-semibold text-dash-ink">On Google today</h3>
      <Explainer>
        The searches the app checks on Google every day (up to 15 a day, taking turns), with where your site shows up.
        These start right away, without waiting for Search Console.
      </Explainer>
      {sorted.length === 0 ? (
        <p className="py-4 text-center text-sm text-dash-muted">
          The first daily check is picking your searches now. Positions show here within a few hours.
        </p>
      ) : (
        <div className="max-h-[360px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-dash-card">
              <tr className="border-b border-dash-line text-left text-xs font-semibold text-dash-ink">
                <th className="px-1 pb-2">Search</th>
                <th className="px-1 pb-2 text-right">Position</th>
                <th className="px-1 pb-2 text-right">Change</th>
                <th className="hidden px-1 pb-2 md:table-cell">Your page</th>
                <th className="hidden px-1 pb-2 text-right sm:table-cell">Checked</th>
                <th className="px-1 pb-2" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const change = r.position !== null && r.previous !== null ? r.previous - r.position : null;
                return (
                  <tr key={r.query} className="border-b border-dash-line/70 last:border-0">
                    <td className="max-w-[240px] px-1 py-2 text-dash-ink" title={r.query}>
                      <div className="truncate">{r.query}</div>
                      {roles[r.query] && (
                        <div className="text-xs text-dash-muted">{roles[r.query] === "support" ? "Supporting (broad)" : "Main target (long tail)"}</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-1 py-2 text-right tabular-nums">
                      {r.position === null ? <span className="text-dash-muted">Not on page 1</span> : r.position}
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
                    <td className="hidden max-w-[200px] truncate px-1 py-2 text-dash-muted md:table-cell" title={r.url ?? ""}>
                      {r.url ? pathOf(r.url) : "—"}
                    </td>
                    <td className="hidden whitespace-nowrap px-1 py-2 text-right text-dash-muted sm:table-cell">{r.checkedOn}</td>
                    <td className="px-1 py-2 text-right">{r.position !== 1 && <RankForThis keyword={r.query} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
