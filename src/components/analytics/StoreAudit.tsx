"use client";

import { useEffect, useState } from "react";
import type { PageReport, ReviewState, SlowApp, StoreFinding } from "@/lib/analytics/autopilot/store-audit";
import type { AppliedChange, PriceFinding, PricingCheck } from "@/lib/analytics/autopilot/pricing-check";
import { api } from "./seo-ui";
import { Card, CardHeader } from "./ui";
import { useIsMember } from "./team-role";

type Labeled<T> = T & { label: string };
type Page = Omit<PageReport, "scripts"> & {
  scripts: (Omit<NonNullable<PageReport["scripts"]>, "sources"> & { sources: Labeled<NonNullable<PageReport["scripts"]>["sources"][number]>[] }) | null;
};

interface View {
  audit: {
    at: string;
    pages: Page[];
    slowApps: Labeled<SlowApp>[];
    findings: StoreFinding[];
    review: ReviewState;
    pricing?: PricingCheck | null;
    priceChanges?: AppliedChange[];
    note: string;
  } | null;
  reviewNote: string | null;
  lastNote: string | null;
  canRunNow: boolean;
  largeImage: number;
}

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};
const kb = (bytes: number) => `${Math.round(bytes / 1000).toLocaleString()} KB`;
const PAGE_NAME: Record<Page["kind"], string> = { home: "Home page", product: "Product page", collection: "Collection page", cart: "Cart page" };
const IMPACT: Record<StoreFinding["impact"], string> = { high: "Big effect", medium: "Some effect", low: "Small effect" };
const yes = (v: boolean) => (v ? "found" : "not found in the page as loaded");

function Fix({ f }: { f: StoreFinding }) {
  return (
    <li className="rounded-xl border border-dash-line p-3">
      <p className="text-sm font-semibold text-dash-ink">{f.problem}</p>
      <p className="mt-1 text-sm text-dash-ink">{f.fix}</p>
      <p className="mt-1 text-xs text-dash-muted">
        {pathOf(f.page)} · {f.who === "autopilot" ? "The autopilot fixes this, following your approval settings" : "You fix this"} · {IMPACT[f.impact]}
      </p>
    </li>
  );
}

function PriceFix({ f, applied, busy, onApply }: { f: PriceFinding; applied: boolean; busy: boolean; onApply: (id: string) => void }) {
  // Applying or undoing on the live site is for the main sign in.
  const member = useIsMember();
  return (
    <li className="rounded-xl border border-dash-line p-3">
      <p className="text-sm font-semibold text-dash-ink">{f.problem}</p>
      <p className="mt-1 text-sm text-dash-ink">{f.fix}</p>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-dash-muted">
        <span>
          {pathOf(f.page)} · {IMPACT[f.impact]}
        </span>
        {f.apply && !applied && (
          <button hidden={member} title={member ? "Only the main sign in can change this for the business." : undefined} disabled={busy} onClick={() => onApply(f.id)} className="rounded-lg bg-dash-green px-2 py-1 font-semibold text-white hover:bg-dash-deep disabled:opacity-60">
            Apply crossed out price
          </button>
        )}
        {applied && <span className="font-semibold text-dash-ink">Applied</span>}
        {!f.apply && <span>You change this price in Shopify</span>}
      </div>
    </li>
  );
}

const amount = (c: number | null, currency: string) => (c === null ? "none" : `${(c / 100).toFixed(2)} ${currency}`);

function AppliedList({ list, busy, onUndo }: { list: AppliedChange[]; busy: boolean; onUndo: (id: string) => void }) {
  // Applying or undoing on the live site is for the main sign in.
  const member = useIsMember();
  if (!list.length) return null;
  return (
    <div className="mt-3">
      <p className="mb-1 text-xs font-semibold text-dash-ink">Crossed out prices you changed here</p>
      <ul className="space-y-1 text-xs text-dash-ink">
        {[...list].reverse().map((c) => (
          <li key={`${c.id}:${c.at}`} className="flex flex-wrap items-center gap-2">
            <span>
              {c.label}: {amount(c.before, c.currency)} to {amount(c.after, c.currency)}, {new Date(c.at).toLocaleDateString()}
            </span>
            <button hidden={member} title={member ? "Only the main sign in can change this for the business." : undefined} disabled={busy} onClick={() => onUndo(`${c.id}@${c.at}`)} className="font-semibold text-dash-green hover:underline disabled:opacity-60">
              Undo
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SlowApps({ apps, pages }: { apps: Labeled<SlowApp>[]; pages: number }) {
  if (!apps.length) return <p className="text-sm text-dash-muted">No outside script loads many scripts on every page checked.</p>;
  return (
    <ul className="space-y-2">
      {apps.map((a) => (
        <li key={a.key} className="rounded-xl border border-dash-line p-3 text-sm">
          <p className="font-semibold text-dash-ink break-words [overflow-wrap:anywhere]">{a.label}</p>
          <p className="text-dash-ink">
            Up to {a.scriptsPerPage} scripts on each of the {pages} pages checked ({a.totalScripts} in all)
            {a.blocking > 0 ? `, ${a.blocking} of them make the page wait before it shows` : ""}.
          </p>
          <p className="text-xs text-dash-muted break-words [overflow-wrap:anywhere]">On {a.pages.map(pathOf).join(", ")}</p>
        </li>
      ))}
    </ul>
  );
}

function PageDetails({ p, largeImage }: { p: Page; largeImage: number }) {
  const f = p.facts;
  return (
    <div className="rounded-xl border border-dash-line p-3 text-sm">
      <p className="font-semibold text-dash-ink break-words [overflow-wrap:anywhere]">
        {PAGE_NAME[p.kind]}: {pathOf(p.url)}
      </p>
      <p className="text-xs text-dash-muted">Picked because: {p.why}</p>
      {p.error && <p className="mt-1 text-dash-down">{p.error}</p>}
      {p.scripts && (
        <p className="mt-2 text-dash-ink">
          {p.scripts.tags} script tags, {p.scripts.external} load a file, {p.scripts.blockingInHead} make the page wait before it shows
          {p.scripts.loadedByApps ? `, and ${p.scripts.loadedByApps} more loaded for apps after the page` : ""}.
        </p>
      )}
      {p.scripts && p.scripts.sources.length > 0 && (
        <ul className="mt-1 list-inside list-disc text-dash-ink">
          {p.scripts.sources.map((s) => (
            <li key={s.key} className="break-words [overflow-wrap:anywhere]">
              {s.label}: {s.scripts} {s.scripts === 1 ? "script" : "scripts"}
              {s.blocking ? `, ${s.blocking} make the page wait` : ""}
            </li>
          ))}
        </ul>
      )}
      {p.images.length > 0 && (
        <p className="mt-2 text-dash-ink break-words [overflow-wrap:anywhere]">
          Largest images: {p.images.slice(0, 3).map((i) => `${pathOf(i.url).split("/").pop()} ${kb(i.bytes)}${i.bytes > largeImage ? " (large)" : ""}`).join(", ")}
        </p>
      )}
      {p.speed && (
        <p className="mt-2 text-dash-ink">
          Phone speed (PageSpeed, checked {new Date(p.speed.checkedAt).toLocaleDateString()}):
          {p.speed.perfScore !== null ? ` score ${Math.round(p.speed.perfScore)} of 100` : ""}
          {p.speed.lcpMs !== null ? `, main content shows in ${(p.speed.lcpMs / 1000).toFixed(1)} s` : ""}
          {p.speed.cls !== null ? `, layout shift ${p.speed.cls.toFixed(2)}` : ""}
        </p>
      )}
      {f && (
        <ul className="mt-2 space-y-0.5 text-xs text-dash-muted">
          <li>Price: {yes(f.pricePresent)}. Add to cart: {yes(f.addToCartPresent)}.</li>
          <li>Review data: {yes(f.reviewMarkup)}. Review widget: {yes(f.reviewWidget)}.</li>
          <li>Shipping info: {f.shippingInfo}. Returns info: {f.returnsInfo}.</li>
          <li>Contact: {f.contactInfo.join(", ") || "none found"}. Trust signs: {f.trustSignals.join(", ") || "none found"}.</li>
          <li>
            About {f.wordCount.toLocaleString()} words. Main button: {f.mainCallToAction ?? "none found"}.
          </li>
        </ul>
      )}
    </div>
  );
}

/** The Store audit card: what stops a sale on the store's key pages, and the apps that slow it. Simple first; Advanced shows the measured numbers. */
export function StoreAudit({ advanced = false }: { advanced?: boolean }) {
  const [view, setView] = useState<View | null>(null);
  const [details, setDetails] = useState(advanced);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<View>("/api/store-audit").then(setView).catch(() => setView(null));
  }, []);
  useEffect(() => setDetails(advanced), [advanced]);
  if (!view) return null;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setView(await api<View>("/api/store-audit", { action: "run" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't run the store audit. Try again later.");
    }
    setBusy(false);
  };
  const applyPrice = async (id: string, undo: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setView(await api<View>("/api/store-audit", { action: undo ? "undo-price" : "apply-price", id, checkAt: view.audit?.pricing?.at ?? null }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change the price. Try again later.");
      // Show what is saved now (a newer check, or a change taken off the list), so the next click works on it.
      await api<View>("/api/store-audit").then(setView).catch(() => undefined);
    }
    setBusy(false);
  };
  const a = view.audit;
  const read = a ? a.pages.filter((p) => p.facts).length : 0;
  return (
    <Card className="mt-6">
      <CardHeader title="Store audit" />
      <p className="mb-3 text-xs text-dash-muted">
        Each week your key pages (home, top products, a collection and the cart) are checked for what stops a sale and what slows them down.
        {a ? ` Last checked ${new Date(a.at).toLocaleDateString()}, ${read} of ${a.pages.length} pages read.` : " The first check runs within the week."}
      </p>
      {view.reviewNote && <p className="mb-3 rounded-lg bg-dash-bg p-2 text-sm text-dash-ink">{view.reviewNote}</p>}
      {!a && view.lastNote && <p className="mb-3 text-sm text-dash-ink">{view.lastNote}</p>}
      {a && (
        <>
          <h3 className="mb-2 font-serif text-lg">Top fixes</h3>
          {a.findings.length ? (
            <ul className="space-y-2">
              {(details ? a.findings : a.findings.slice(0, 5)).map((f) => (
                <Fix key={f.id} f={f} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-dash-muted">{a.review === "checked" ? "Nothing clear to fix on these pages this week." : "No checked fixes yet."}</p>
          )}
          {a.pricing && (
            <>
              <h3 className="mb-2 mt-4 font-serif text-lg">Prices and bundles</h3>
              <p className="mb-2 text-xs text-dash-muted">
                Checked {new Date(a.pricing.at).toLocaleDateString()}: {a.pricing.note}. Prices never change without you.
              </p>
              {a.pricing.findings.length ? (
                <ul className="space-y-2">
                  {(details ? a.pricing.findings : a.pricing.findings.slice(0, 5)).map((f) => (
                    <PriceFix
                      key={f.id}
                      f={f}
                      applied={(a.priceChanges ?? []).some((c) => c.id === f.id && c.checkAt === a.pricing?.at)}
                      busy={busy}
                      onApply={(id) => applyPrice(id, false)}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-dash-muted">Your packs, bundles and crossed out prices add up.</p>
              )}
            </>
          )}
          <AppliedList list={a.priceChanges ?? []} busy={busy} onUndo={(id) => applyPrice(id, true)} />
          <h3 className="mb-2 mt-4 font-serif text-lg">Apps that slow your store</h3>
          <SlowApps apps={a.slowApps} pages={read} />
          {details && (
            <div className="mt-4 space-y-2">
              <h3 className="font-serif text-lg">Each page, as measured</h3>
              {a.pages.map((p) => (
                <PageDetails key={p.url} p={p} largeImage={view.largeImage} />
              ))}
            </div>
          )}
        </>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          onClick={run}
          disabled={busy || !view.canRunNow}
          className="rounded-lg bg-dash-green px-3 py-1.5 text-xs font-semibold text-white hover:bg-dash-deep disabled:opacity-60"
        >
          {busy ? "Checking, this takes a minute" : "Run now"}
        </button>
        {!view.canRunNow && <span className="text-xs text-dash-muted">Run now works once a day.</span>}
        {a && (
          <button onClick={() => setDetails((d) => !d)} className="text-xs font-semibold text-dash-green hover:underline">
            {details ? "Hide details" : "Show details"}
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-dash-down">{error}</p>}
    </Card>
  );
}
