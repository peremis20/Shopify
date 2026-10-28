"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import type { AutopilotChange, AutopilotRun, ChangeField } from "@/lib/analytics/autopilot/types";
import type { AutopilotSettingsView } from "@/lib/analytics/autopilot/settings";
import { BoltIcon } from "./Icons";
import { PlatformForm } from "./PlatformSettings";
import { api, pathOf } from "./seo-ui";
import { SortHeader, useSort } from "./sorting";
import { Card, CardHeader, Skeleton } from "./ui";

interface State {
  settings: AutopilotSettingsView;
  changes: AutopilotChange[];
  runs: AutopilotRun[];
}

const FIELD_LABEL: Record<ChangeField, string> = {
  meta_title: "SEO title",
  meta_description: "Meta description",
  content: "New section",
  alt: "Image alt text",
  internal_link: "Internal link",
};

const STATUS_STYLE: Record<AutopilotChange["status"], string> = {
  applied: "bg-dash-green/10 text-dash-green",
  kept: "bg-dash-up/10 text-dash-up",
  reverted: "bg-[#F1ECE3] text-dash-muted",
  failed: "bg-dash-down/10 text-dash-down",
  skipped: "bg-[#F1ECE3] text-dash-muted",
};

const STATUS_LABEL: Record<AutopilotChange["status"], string> = {
  applied: "Live, measuring",
  kept: "Kept",
  reverted: "Undone",
  failed: "Failed",
  skipped: "Skipped",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const textOf = (html: string | null) => (html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export function Autopilot({ connected, admin }: { connected: boolean; admin: boolean }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [platformOpen, setPlatformOpen] = useState(false);

  const load = useCallback(() => {
    api<State>("/api/autopilot").then(setState).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (connected) load();
  }, [connected, load]);

  async function act(label: string, run: () => Promise<void>) {
    setBusy(label);
    setNotice(null);
    try {
      await run();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  const save = (body: Record<string, unknown>) =>
    act("save", async () => {
      const d = await api<{ settings: AutopilotSettingsView }>("/api/autopilot/settings", body);
      setState((s) => (s ? { ...s, settings: d.settings } : s));
    });

  const ready = state?.settings.platformReady && state?.settings.shopConnected;

  return (
    <Card id="autopilot" className="mt-5">
      <CardHeader title="SEO Autopilot" icon={<BoltIcon className="h-5 w-5 text-dash-green" />}>
        {state && ready && (
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
              state.settings.enabled ? "bg-dash-up/10 text-dash-up" : "bg-[#F1ECE3] text-dash-muted"
            }`}
          >
            {state.settings.enabled ? "On" : "Off"}
          </span>
        )}
      </CardHeader>

      {!connected ? (
        <p className="text-sm text-dash-muted">Connect your Google account in Settings first.</p>
      ) : error ? (
        <p className="text-sm text-dash-down">{error}</p>
      ) : !state ? (
        <Skeleton className="h-32" />
      ) : !state.settings.platformReady || (admin && platformOpen) ? (
        admin ? (
          <PlatformForm
            settings={state.settings}
            onSaved={(settings) => {
              setState((s) => (s ? { ...s, settings } : s));
              if (settings.platformReady) setPlatformOpen(false);
            }}
          />
        ) : (
          <p className="text-sm text-dash-muted">The SEO Autopilot is almost ready. It will appear here soon.</p>
        )
      ) : !state.settings.shopConnected ? (
        <ConnectShopify adminLink={admin ? () => setPlatformOpen(true) : undefined} />
      ) : (
        <div className="space-y-5 text-sm">
          <p className="max-w-3xl text-dash-muted">
            Every day the autopilot picks your best opportunity, rewrites the page&apos;s SEO title and description, adds
            missing image descriptions and, on blog posts and pages, a helpful new section, then links to it from a
            related post. It never touches prices, product names or checkout. It improves at most{" "}
            {state.settings.maxPagesPerWeek} pages a week, leaves each page alone for 45 days after changing it, and
            undoes changes that make a page rank worse after 4 weeks.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => save({ enabled: !state.settings.enabled })}
              disabled={busy !== null}
              className={`rounded-xl px-4 py-2.5 font-semibold text-white disabled:opacity-60 ${
                state.settings.enabled ? "bg-dash-down hover:brightness-95" : "bg-dash-green hover:bg-dash-deep"
              }`}
            >
              {state.settings.enabled ? "Turn autopilot off" : "Turn autopilot on"}
            </button>
            <label className="flex items-center gap-2">
              <span className="text-dash-muted">Pages per week</span>
              <select
                id="ap-pages"
                value={state.settings.maxPagesPerWeek}
                onChange={(e) => save({ maxPagesPerWeek: Number(e.target.value) })}
                className="rounded-lg border border-dash-line bg-white px-2 py-1.5"
              >
                {[1, 2, 4, 6, 10].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input
                id="ap-content"
                type="checkbox"
                checked={state.settings.allowContent}
                onChange={(e) => save({ allowContent: e.target.checked })}
              />
              Add new sections to blog posts and pages
            </label>
            <div className="ml-auto flex flex-wrap gap-2">
              <button
                onClick={() =>
                  act("run", async () => {
                    const r = await api<{ message: string }>("/api/autopilot/run", {});
                    setNotice(r.message);
                    load();
                  })
                }
                disabled={busy !== null}
                className="rounded-xl border border-dash-line bg-white px-4 py-2.5 font-semibold text-dash-ink hover:border-dash-green/40 disabled:opacity-60"
              >
                {busy === "run" ? "Working, this takes a minute or two…" : "Run now"}
              </button>
              {admin && (
                <button onClick={() => setPlatformOpen(true)} className="px-2 font-semibold text-dash-green hover:underline">
                  Platform keys
                </button>
              )}
            </div>
          </div>

          {notice && <p className="rounded-lg bg-[#FBF1E1] p-3 text-dash-ink" role="status">{notice}</p>}

          <p className="text-dash-muted">
            Connected store: <span className="font-semibold text-dash-ink">{state.settings.shopDomain}</span>
            {" · "}
            <button
              onClick={() =>
                act("disconnect", async () => {
                  const d = await api<{ settings: AutopilotSettingsView }>("/api/shopify/disconnect", {});
                  setState((s) => (s ? { ...s, settings: d.settings } : s));
                })
              }
              className="font-semibold text-dash-down hover:underline"
            >
              Disconnect store
            </button>
          </p>

          {state.runs.length > 0 && (
            <div>
              <p className="mb-1 font-semibold">Recent runs</p>
              <ul className="space-y-1 text-dash-muted">
                {state.runs.slice(0, 4).map((r) => (
                  <li key={r.id}>
                    <span className="text-dash-ink">{when(r.startedAt)}</span>
                    {r.trigger === "manual" ? " (manual)" : ""}: {r.status === "running" ? "Running…" : r.summary}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ChangeLog
            changes={state.changes}
            busy={busy !== null}
            onUndo={(id) =>
              act(`undo-${id}`, async () => {
                const d = await api<Omit<State, "settings">>("/api/autopilot/revert", { id });
                setState((s) => (s ? { ...s, ...d } : s));
                setNotice("Change undone. The previous version is back on your store.");
              })
            }
          />
        </div>
      )}
    </Card>
  );
}

function ChangeLog({ changes, busy, onUndo }: { changes: AutopilotChange[]; busy: boolean; onUndo: (id: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const { sorted, sort } = useSort(
    changes,
    {
      date: (c) => c.createdAt,
      page: (c) => pathOf(c.pageUrl),
      query: (c) => c.query,
      field: (c) => FIELD_LABEL[c.field],
      status: (c) => STATUS_LABEL[c.status],
    },
    { key: "date", dir: "desc" }
  );

  if (!changes.length) {
    return (
      <p className="py-6 text-center text-dash-muted">
        No changes yet. Every change the autopilot makes will show up here, with the old and new version and an undo
        button.
      </p>
    );
  }

  return (
    <div>
      <p className="mb-2 font-semibold">Change log</p>
      <div className="max-h-[560px] overflow-auto">
        <table className="w-full">
          <thead className="sticky top-0 bg-dash-card">
            <tr className="border-b border-dash-line text-left text-xs text-dash-ink">
              <th className="px-1 pb-2"><SortHeader label="Date" column="date" sort={sort} /></th>
              <th className="px-1 pb-2"><SortHeader label="Page" column="page" sort={sort} /></th>
              <th className="hidden px-1 pb-2 md:table-cell"><SortHeader label="Search" column="query" sort={sort} /></th>
              <th className="px-1 pb-2"><SortHeader label="Change" column="field" sort={sort} /></th>
              <th className="px-1 pb-2"><SortHeader label="Status" column="status" sort={sort} /></th>
              <th className="px-1 pb-2" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <Fragment key={c.id}>
                <tr
                  onClick={() => setOpen(open === c.id ? null : c.id)}
                  className="cursor-pointer border-b border-dash-line/70 hover:bg-dash-bg"
                >
                  <td className="whitespace-nowrap px-1 py-2 text-dash-muted">{when(c.createdAt)}</td>
                  <td className="max-w-[200px] truncate px-1 py-2 text-dash-ink" title={c.pageUrl}>{pathOf(c.pageUrl)}</td>
                  <td className="hidden max-w-[180px] truncate px-1 py-2 md:table-cell" title={c.query}>{c.query}</td>
                  <td className="whitespace-nowrap px-1 py-2">{FIELD_LABEL[c.field]}</td>
                  <td className="px-1 py-2">
                    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[c.status]}`}>
                      {STATUS_LABEL[c.status]}
                    </span>
                  </td>
                  <td className="px-1 py-2 text-right">
                    {(c.status === "applied" || c.status === "kept") && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onUndo(c.id);
                        }}
                        disabled={busy}
                        className="rounded-full border border-dash-line px-2.5 py-0.5 text-xs font-semibold text-dash-down hover:border-dash-down/40 disabled:opacity-50"
                      >
                        Undo
                      </button>
                    )}
                  </td>
                </tr>
                {open === c.id && (
                  <tr className="border-b border-dash-line/70 bg-dash-bg">
                    <td colSpan={6} className="space-y-2 px-3 py-3 text-sm">
                      {c.reason && <p><span className="font-semibold">Why: </span>{c.reason}</p>}
                      {c.before !== null && c.field !== "alt" && (
                        <p><span className="font-semibold">Before: </span><span className="text-dash-muted">{c.before || "(empty)"}</span></p>
                      )}
                      <p><span className="font-semibold">{c.field === "content" || c.field === "internal_link" ? "Added: " : "After: "}</span>{textOf(c.after)}</p>
                      {c.note && <p className="text-dash-muted">{c.note}</p>}
                      <a href={c.pageUrl} target="_blank" rel="noreferrer" className="font-semibold text-dash-green hover:underline">
                        Open the page
                      </a>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ConnectShopify({ adminLink }: { adminLink?: () => void }) {
  const [shop, setShop] = useState("");
  return (
    <div className="grid gap-5 text-sm lg:grid-cols-2">
      <div className="space-y-2">
        <p className="font-semibold">Connect your Shopify store</p>
        <p className="text-dash-muted">
          Type your store name and click Connect. Shopify will ask you to approve access to edit your blog posts, pages,
          SEO titles and image descriptions. Prices, product names and checkout are never changed.
        </p>
        {adminLink && (
          <button onClick={adminLink} className="font-semibold text-dash-green hover:underline">
            Platform keys
          </button>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          window.location.href = `/api/shopify/install?shop=${encodeURIComponent(shop)}`;
        }}
        className="space-y-3 rounded-xl border border-dash-line bg-white p-4"
      >
        <label className="block">
          <span className="mb-1 block text-xs text-dash-muted">Store name</span>
          <div className="flex items-center rounded-lg border border-dash-line focus-within:ring-2 focus-within:ring-dash-green/30">
            <input
              id="ap-shop"
              value={shop}
              onChange={(e) => setShop(e.target.value)}
              placeholder="mystore"
              autoComplete="off"
              className="w-full min-w-0 rounded-l-lg px-3 py-2 outline-none"
            />
            <span className="whitespace-nowrap pr-3 text-dash-muted">.myshopify.com</span>
          </div>
        </label>
        <button
          type="submit"
          disabled={!shop.trim()}
          className="rounded-xl bg-dash-green px-5 py-2.5 font-semibold text-white hover:bg-dash-deep disabled:opacity-60"
        >
          Connect Shopify
        </button>
      </form>
    </div>
  );
}
