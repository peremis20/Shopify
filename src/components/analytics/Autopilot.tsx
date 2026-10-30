"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import type { AppStatus } from "@/lib/analytics/autopilot/apps";
import type { AutopilotChange, AutopilotPreview, AutopilotRun, ChangeField } from "@/lib/analytics/autopilot/types";
import type { AutopilotSettingsView } from "@/lib/analytics/autopilot/settings";
import { fixGuide, PLATFORM_LABEL, type Platform } from "@/lib/analytics/fix-guides";
import { BoltIcon } from "./Icons";
import { PlatformConnect } from "./PlatformConnect";
import { PlatformForm } from "./PlatformSettings";
import { api, pathOf } from "./seo-ui";
import { SortHeader, useSort } from "./sorting";
import { Card, CardHeader, Skeleton } from "./ui";

interface State {
  settings: AutopilotSettingsView;
  apps?: AppStatus[];
  changes: AutopilotChange[];
  runs: AutopilotRun[];
}

const FIELD_LABEL: Record<ChangeField, string> = {
  meta_title: "SEO title",
  meta_description: "Meta description",
  content: "New section",
  alt: "Image alt text",
  internal_link: "Internal link",
  link_fix: "Link fix",
  schema: "Structured data",
  intent: "Content gap",
  new_article: "New article",
};

const STATUS_STYLE: Record<AutopilotChange["status"], string> = {
  applied: "bg-dash-green/10 text-dash-green",
  kept: "bg-dash-up/10 text-dash-up",
  reverted: "bg-[#F1ECE3] text-dash-muted",
  failed: "bg-dash-down/10 text-dash-down",
  skipped: "bg-[#F1ECE3] text-dash-muted",
  suggested: "bg-[#FBF1E1] text-[#8A5A12]",
};

const STATUS_LABEL: Record<AutopilotChange["status"], string> = {
  applied: "Live, measuring",
  kept: "Kept",
  reverted: "Undone",
  failed: "Failed",
  skipped: "Skipped",
  suggested: "On the fix list",
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
  const [preview, setPreview] = useState<AutopilotPreview | null>(null);

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

  const website = state?.settings.website ?? null;
  const ready = state?.settings.platformReady && (state?.settings.shopConnected || website);
  const fixes = state?.changes.filter((c) => c.status === "suggested") ?? [];

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
      ) : !state.settings.shopConnected && !website ? (
        <ConnectShopify adminLink={admin ? () => setPlatformOpen(true) : undefined} onWebsite={load} />
      ) : (
        <div className="space-y-5 text-sm">
          {website && !website.connection && <PlatformConnect platform={website.platform} domain={website.domain} onConnected={load} />}
          {website && !website.connection && (
            <p className="max-w-3xl rounded-lg bg-[#FBF1E1] p-3 text-dash-ink">
              The app reads {website.domain} like Google does but can&apos;t edit it, so each improvement lands on your{" "}
              <b>fix list</b> below, ready to paste, with where to paste it. Mark it done and it&apos;s measured like any other change.
            </p>
          )}
          <p className="max-w-3xl text-dash-muted">
            Every day the autopilot works to win page one and keep it. It first defends any page that&apos;s slipping,
            then pushes your #2 and #3 results for #1 and your page two results into the top 3. It studies the pages
            ranking above you and rewrites your SEO title, description and content to beat them. It never touches
            prices, product names or checkout. It changes at most {state.settings.maxPagesPerWeek} pages a week and
            undoes any change that makes a page rank worse after 4 weeks.
          </p>

          {state.apps && state.apps.length > 0 && <ConnectedApps apps={state.apps} />}

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
                  act("preview", async () => {
                    const r = await api<{ message: string; preview?: AutopilotPreview }>("/api/autopilot/preview", {});
                    setPreview(r.preview ?? null);
                    if (!r.preview) setNotice(r.message);
                    load();
                  })
                }
                disabled={busy !== null}
                className="rounded-xl border border-dash-line bg-white px-4 py-2.5 font-semibold text-dash-ink hover:border-dash-green/40 disabled:opacity-60"
              >
                {busy === "preview" ? "Checking live data…" : "Preview next run"}
              </button>
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
          {preview && <PreviewCard preview={preview} onClose={() => setPreview(null)} />}

          {website ? (
            <p className="text-dash-muted">
              Website: <span className="font-semibold text-dash-ink">{website.domain}</span>
              {website.platform ? ` (${PLATFORM_LABEL[website.platform as Platform] ?? website.platform})` : ""}
              {website.connection && (
                <>
                  {" · connected"}
                  {website.connection.detail ? ` (${website.connection.detail})` : ""}
                  {" · "}
                  <button
                    onClick={() =>
                      act("disconnect", async () => {
                        const d = await api<{ settings: AutopilotSettingsView }>("/api/site/disconnect", { kind: website.connection!.kind });
                        setState((s) => (s ? { ...s, settings: d.settings } : s));
                      })
                    }
                    className="font-semibold text-dash-down hover:underline"
                  >
                    Disconnect
                  </button>
                </>
              )}
            </p>
          ) : (
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
          )}

          {state.runs.length > 0 && (
            <div>
              <p className="mb-1 font-semibold">Recent runs</p>
              <ul className="space-y-1 text-dash-muted">
                {state.runs.slice(0, 4).map((r) => (
                  <li key={r.id}>
                    <span className="text-dash-ink">{when(r.startedAt)}</span>
                    {r.trigger === "manual" ? " (manual)" : r.trigger === "preview" ? " (preview)" : ""}:{" "}
                    {r.status === "running" ? "Running…" : r.summary}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {fixes.length > 0 && (
            <FixList
              fixes={fixes}
              platform={website?.platform ?? (state.settings.shopConnected ? "shopify" : null)}
              busy={busy !== null}
              onMark={(id, done) =>
                act(`fix-${id}`, async () => {
                  const d = await api<Omit<State, "settings">>("/api/autopilot/fix", { id, done });
                  setState((s) => (s ? { ...s, ...d } : s));
                })
              }
            />
          )}

          <ChangeLog
            changes={state.changes.filter((c) => c.status !== "suggested")}
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

/** Improvements for a site the app can't edit: each ready to paste, with where it goes on the owner's platform. */
function FixList({
  fixes,
  platform,
  busy,
  onMark,
}: {
  fixes: AutopilotChange[];
  platform: string | null;
  busy: boolean;
  onMark: (id: string, done: boolean) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const html = (f: AutopilotChange) => f.field === "content" || f.field === "schema" || f.field === "internal_link" || f.field === "new_article";
  return (
    <div>
      <p className="mb-1 font-semibold">Fix list ({fixes.length})</p>
      <p className="mb-3 text-dash-muted">Paste each one in, then mark it done. Biggest wins first: titles and descriptions take a minute each.</p>
      <ul className="space-y-3">
        {fixes.map((f) => (
          <li key={f.id} className="rounded-xl border border-dash-line bg-white p-4">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <p>
                <span className="font-semibold">{FIELD_LABEL[f.field]}</span>
                <span className="text-dash-muted"> on </span>
                <a href={f.field === "internal_link" && f.targetId ? f.targetId : f.pageUrl} target="_blank" rel="noreferrer" className="font-semibold text-dash-green hover:underline">
                  {pathOf(f.field === "internal_link" && f.targetId ? f.targetId : f.pageUrl)}
                </a>
              </p>
              {f.query && <span className="text-xs text-dash-muted">for “{f.query}”</span>}
            </div>
            {f.field === "internal_link" && <p className="mb-2 text-dash-muted">Links to {pathOf(f.pageUrl)}, which the search above should find.</p>}
            {f.before && !html(f) && <p className="mb-1 text-dash-muted line-through">{f.before}</p>}
            {html(f) ? (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-dash-line bg-[#FBF8F2] p-3 font-mono text-xs">{f.after}</pre>
            ) : (
              <p className="rounded-lg border border-dash-line bg-[#FBF8F2] p-3 text-dash-ink">{f.after}</p>
            )}
            <p className="mt-2 text-dash-muted">{fixGuide(platform, f.field)}</p>
            {f.reason && <p className="mt-1 text-xs text-dash-muted">Why: {f.reason}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                onClick={() => navigator.clipboard?.writeText(f.after ?? "").then(() => setCopied(f.id), () => setCopied(null))}
                className="rounded-xl border border-dash-line px-3 py-1.5 font-semibold text-dash-ink hover:border-dash-green/40"
              >
                {copied === f.id ? "Copied" : "Copy"}
              </button>
              <button onClick={() => onMark(f.id, true)} disabled={busy} className="rounded-xl bg-dash-green px-3 py-1.5 font-semibold text-white hover:bg-dash-deep disabled:opacity-60">
                Done, I pasted it
              </button>
              <button onClick={() => onMark(f.id, false)} disabled={busy} className="font-semibold text-dash-muted hover:text-dash-ink">
                Skip
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConnectedApps({ apps }: { apps: AppStatus[] }) {
  return (
    <div>
      <p className="mb-2 font-semibold">Apps working together</p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {apps.map((a) => (
          <li key={a.id} className="flex items-start gap-2 rounded-lg border border-dash-line bg-white p-2.5">
            <span
              className={`mt-1 h-2 w-2 shrink-0 rounded-full ${a.ready ? "bg-dash-up" : "bg-dash-line"}`}
              aria-label={a.ready ? "Connected" : "Not set up"}
            />
            <span>
              <span className="font-semibold text-dash-ink">{a.name}</span>
              <span className="text-dash-muted">{a.ready ? "" : " (not set up)"}</span>
              <span className="block text-dash-muted">{a.role}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const MODE_LABEL: Record<AutopilotPreview["mode"], string> = {
  defend: "Defend a slipping ranking",
  top: "Go for #1",
  climb: "Climb into the top 3",
};

function PreviewCard({ preview, onClose }: { preview: AutopilotPreview; onClose: () => void }) {
  return (
    <div className="rounded-xl border border-dash-green/30 bg-dash-green/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-dash-ink">Preview of the next run. Nothing was changed on your store.</p>
          <p className="text-dash-muted">
            {MODE_LABEL[preview.mode]}: <span className="text-dash-ink">“{preview.query}”</span> on{" "}
            <span className="text-dash-ink">{pathOf(preview.page)}</span>, now position {preview.position.toFixed(1)}
            {preview.monthlySearches ? `, ${preview.monthlySearches.toLocaleString()} searches a month` : ""}.
          </p>
        </div>
        <button onClick={onClose} className="font-semibold text-dash-green hover:underline">Close</button>
      </div>
      {preview.apps.length > 0 && <p className="mt-2 text-dash-muted">Used: {preview.apps.join(", ")}.</p>}
      {preview.notes.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-dash-muted">
          {preview.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-dash-ink">{preview.reason}</p>
      <div className="mt-3 space-y-3">
        {preview.changes.map((c, i) => (
          <div key={i} className="rounded-lg border border-dash-line bg-white p-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-dash-muted">{FIELD_LABEL[c.field]}</p>
            {c.before !== null && <p className="text-dash-muted line-through">{textOf(c.before)}</p>}
            {c.field === "content" ? (
              <div className="prose-sm text-dash-ink [&_h2]:font-semibold [&_h3]:font-semibold" dangerouslySetInnerHTML={{ __html: c.after }} />
            ) : (
              <p className="text-dash-ink">{textOf(c.after)}</p>
            )}
          </div>
        ))}
        {!preview.changes.length && <p className="text-dash-muted">The page already looks strong; the next run would leave it as is.</p>}
      </div>
    </div>
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
                      <p><span className="font-semibold">{c.field === "content" || c.field === "internal_link" ? "Added: " : c.field === "link_fix" ? "" : "After: "}</span>{textOf(c.after)}</p>
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

function ConnectShopify({ adminLink, onWebsite }: { adminLink?: () => void; onWebsite: () => void }) {
  const [shop, setShop] = useState("");
  const [domain, setDomain] = useState("");
  const [reading, setReading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
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
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setReading(true);
          setFailed(null);
          try {
            await api("/api/onboarding/site", { domain });
            onWebsite();
          } catch (err) {
            setFailed(err instanceof Error ? err.message : "Couldn't read that website.");
          } finally {
            setReading(false);
          }
        }}
        className="space-y-3 rounded-xl border border-dash-line bg-white p-4 lg:col-start-2"
      >
        <p className="font-semibold">Not on Shopify?</p>
        <p className="text-dash-muted">
          WordPress, Wix, Squarespace, Webflow, AI builders and custom sites work too. The app reads your pages and hands you
          each improvement ready to paste.
        </p>
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="yourwebsite.com"
          aria-label="Website address"
          className="w-full rounded-lg border border-dash-line px-3 py-2"
        />
        {failed && <p className="text-dash-down">{failed}</p>}
        <button type="submit" disabled={!domain.trim() || reading} className="rounded-xl bg-dash-green px-5 py-2.5 font-semibold text-white hover:bg-dash-deep disabled:opacity-60">
          {reading ? "Reading your site…" : "Connect website"}
        </button>
      </form>
    </div>
  );
}
