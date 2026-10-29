"use client";

import { useCallback, useEffect, useState } from "react";
import type { Onboarding as Status, Step } from "@/lib/analytics/onboarding";
import { api } from "./seo-ui";
import { isEmbedded } from "./embedded-client";
import { ConnectButton } from "./SettingsPanel";
import { PlatformConnect } from "./PlatformConnect";
import { Card } from "./ui";

/**
 * The setup checklist at the top of the dashboard: what's done, what's next,
 * and the one action for the next step right there, so nobody gets stuck.
 */
export function Onboarding({ onOpenSettings, onChanged }: { onOpenSettings: () => void; onChanged: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Status>("/api/onboarding")
      .then((s) => {
        setStatus(s);
        setOpen((o) => o ?? s.steps.find((x) => !x.done)?.id ?? null);
      })
      .catch(() => setStatus(null));
  }, []);
  useEffect(load, [load]);

  async function act(id: string, run: () => Promise<Status | void>, refreshDashboard = false) {
    setBusy(id);
    setError(null);
    try {
      const next = await run();
      if (next) setStatus(next);
      else load();
      if (refreshDashboard) onChanged();
      // Setup can stop halfway (a click only the owner can make), so its step stays open.
      if (id !== "setup") setOpen(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  if (!status) return null;
  const done = status.steps.filter((s) => s.done).length;
  const total = status.steps.length;
  if (status.complete && status.dismissed) return null;

  if (status.dismissed) {
    return (
      <div className="mt-6 flex items-center justify-between gap-3 rounded-xl border border-dash-line bg-white px-4 py-3 text-sm">
        <span>
          Setup: {done} of {total} done.
        </span>
        <button
          onClick={() => act("show", () => api<Status>("/api/onboarding/profile", { dismissed: false }))}
          className="font-semibold text-dash-green hover:underline"
        >
          Show the checklist
        </button>
      </div>
    );
  }

  const next = status.steps.find((s) => !s.done);
  return (
    <Card className="mt-6">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl">{status.complete ? "You're all set" : "Let's get you set up"}</h2>
          <p className="text-sm text-dash-muted">
            {status.complete
              ? "Everything is connected and the autopilot is working on your rankings."
              : `${done} of ${total} done. Each step takes about a minute${next ? `; next: ${next.title.toLowerCase()}` : ""}.`}
          </p>
        </div>
        <button
          onClick={() => act("hide", () => api<Status>("/api/onboarding/profile", { dismissed: true }))}
          className="text-sm text-dash-muted hover:text-dash-ink"
        >
          {status.complete ? "Close" : "Hide for now"}
        </button>
      </div>
      <div className="mb-4 h-2 overflow-hidden rounded-full bg-dash-line/60">
        <div className="h-full rounded-full bg-dash-green transition-all" style={{ width: `${(done / total) * 100}%` }} />
      </div>
      {error && <p className="mb-3 rounded-lg bg-dash-down/5 p-3 text-sm text-dash-down">{error}</p>}
      <ol className="divide-y divide-dash-line/70 text-sm">
        {status.steps.map((step, i) => (
          <li key={step.id} className="py-2.5">
            <button onClick={() => setOpen(open === step.id ? null : step.id)} className="flex w-full items-center gap-3 text-left">
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  step.done ? "bg-dash-green text-white" : step.id === next?.id ? "border-2 border-dash-green text-dash-green" : "border border-dash-line text-dash-muted"
                }`}
              >
                {step.done ? "✓" : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`font-semibold ${step.done ? "text-dash-muted" : "text-dash-ink"}`}>{step.title}</span>
                <span className="block text-dash-muted">{step.detail}</span>
              </span>
            </button>
            {open === step.id && (
              <div className="mt-3 pl-9">
                <StepAction step={step} status={status} busy={busy} act={act} onOpenSettings={onOpenSettings} />
              </div>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

type Act = (id: string, run: () => Promise<Status | void>, refreshDashboard?: boolean) => Promise<void>;

const button = "rounded-xl bg-dash-green px-4 py-2 font-semibold text-white hover:bg-dash-deep disabled:opacity-60";
const link = "font-semibold text-dash-green hover:underline";

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function StepAction({ step, status, busy, act, onOpenSettings }: { step: Step; status: Status; busy: string | null; act: Act; onOpenSettings: () => void }) {
  switch (step.id) {
    case "google":
      return step.done ? <button onClick={onOpenSettings} className={link}>Change Google account in Settings</button> : <ConnectButton />;
    case "website":
      return step.done ? (
        !status.siteConnected && status.domain && status.platform !== "shopify" ? (
          <PlatformConnect platform={status.platform} domain={status.domain} onConnected={() => act("website-connected", async () => undefined, true)} />
        ) : (
          <p className="text-dash-muted">Connected. You can change it any time in the Autopilot card.</p>
        )
      ) : (
        <WebsiteConnect busy={busy === "website"} act={act} />
      );
    case "business":
      return <BusinessForm status={status} busy={busy === "business"} act={act} />;
    case "search_console":
    case "analytics":
      return <PropertyHelp step={step} status={status} busy={busy} act={act} onOpenSettings={onOpenSettings} />;
    case "first_check":
      return (
        <button
          disabled={busy === "check"}
          onClick={() => act("check", async () => void (await api("/api/autopilot/check", {})), true)}
          className={button}
        >
          {busy === "check" ? "Checking, about a minute…" : step.done ? "Check again now" : "Run the first check"}
        </button>
      );
    case "preview":
    case "autopilot":
      return (
        <button onClick={() => scrollTo("autopilot")} className={button}>
          {step.id === "preview" ? "Go to Preview next run" : "Go to the autopilot switch"}
        </button>
      );
  }
}

/** Shopify connects in one click; any other website by its address (read from its sitemap, changes as a fix list). */
function WebsiteConnect({ busy, act }: { busy: boolean; act: Act }) {
  const [kind, setKind] = useState<"shopify" | "other">("shopify");
  const [domain, setDomain] = useState("");
  return (
    <div className="space-y-3">
      <div className="inline-flex rounded-lg border border-dash-line bg-white p-0.5">
        {(["shopify", "other"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`rounded-md px-3 py-1.5 font-semibold ${kind === k ? "bg-dash-green text-white" : "text-dash-muted hover:text-dash-ink"}`}
          >
            {k === "shopify" ? "Shopify store" : "Another website"}
          </button>
        ))}
      </div>
      {kind === "shopify" ? (
        <ShopifyConnect />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act("website", () => api<Status>("/api/onboarding/site", { domain }), true);
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="yourwebsite.com"
            aria-label="Website address"
            className="w-56 min-w-0 rounded-lg border border-dash-line bg-white px-3 py-2"
          />
          <button type="submit" disabled={!domain.trim() || busy} className={button}>
            {busy ? "Reading your site…" : "Connect"}
          </button>
          <p className="w-full text-dash-muted">
            WordPress, Wix, Squarespace, Webflow, AI builders or custom code all work. The app reads your pages like Google does
            and hands you each improvement ready to paste, with where to paste it.
          </p>
        </form>
      )}
    </div>
  );
}

function ShopifyConnect() {
  const [shop, setShop] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        window.location.href = `/api/shopify/install?shop=${encodeURIComponent(shop)}`;
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <div className="flex items-center rounded-lg border border-dash-line bg-white focus-within:ring-2 focus-within:ring-dash-green/30">
        <input
          value={shop}
          onChange={(e) => setShop(e.target.value)}
          placeholder="your store name"
          aria-label="Store name"
          className="w-44 min-w-0 rounded-l-lg px-3 py-2 outline-none"
        />
        <span className="whitespace-nowrap pr-3 text-dash-muted">.myshopify.com</span>
      </div>
      <button type="submit" disabled={!shop.trim()} className={button}>
        Connect Shopify
      </button>
      <p className="w-full text-dash-muted">
        Find it in your Shopify admin address: admin.shopify.com/store/<b>your-store-name</b>. Shopify asks you to approve, then
        you come right back.
      </p>
    </form>
  );
}

function BusinessForm({ status, busy, act }: { status: Status; busy: boolean; act: Act }) {
  const [type, setType] = useState(status.businessType ?? "");
  const [brand, setBrand] = useState(status.brandName ?? "");
  const [hosts, setHosts] = useState(status.gaExcludeHosts.join(", "));
  const [more, setMore] = useState(Boolean(status.gaExcludeHosts.length));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        act("business", () => api<Status>("/api/onboarding/profile", { businessType: type, brandName: brand, gaExcludeHosts: hosts }), true);
      }}
      className="max-w-lg space-y-3"
    >
      <label className="block">
        <span className="mb-1 block text-dash-muted">What do you sell?</span>
        <select value={type} onChange={(e) => setType(e.target.value)} className="w-full rounded-lg border border-dash-line bg-white px-3 py-2">
          <option value="" disabled>
            Choose one
          </option>
          {status.businessTypes.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-dash-muted">Brand name, as it should appear in Google titles</span>
        <input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Your brand" className="w-full rounded-lg border border-dash-line px-3 py-2" />
      </label>
      {more ? (
        <label className="block">
          <span className="mb-1 block text-dash-muted">Other websites using the same Analytics tag (left out of your numbers)</span>
          <input value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="othersite.com" className="w-full rounded-lg border border-dash-line px-3 py-2" />
        </label>
      ) : (
        <button type="button" onClick={() => setMore(true)} className="text-dash-muted hover:text-dash-ink">
          Does another website share your Google Analytics? (optional)
        </button>
      )}
      <div>
        <button type="submit" disabled={!type || busy} className={button}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

type SetupState =
  | { status: "needs_permission" }
  | { status: "needs_embed"; embedUrl: string }
  | { status: "needs_ga_account" }
  | { status: "done"; notes: string[] };

const PENDING_SETUP = "insights.pendingSetup";

/** Leaves the page for Google (at the top level when inside Shopify admin). */
async function goToGoogle(purpose: "setup") {
  const { url } = await api<{ url: string }>(`/api/auth/google/link?purpose=${purpose}`);
  if (isEmbedded()) window.open(url, "_top");
  else window.location.href = url;
}

/** "Set it up for me": creates Search Console and Analytics, guiding through the one or two clicks only the owner can do. */
function SetupForMe({ act, busy }: { act: Act; busy: string | null }) {
  const [state, setState] = useState<SetupState | null>(null);

  const run = useCallback(
    () =>
      act(
        "setup",
        async () => {
          const out = await api<{ state: SetupState; onboarding: Status }>("/api/onboarding/setup-google", {});
          if (out.state.status === "needs_permission") {
            try {
              localStorage.setItem(PENDING_SETUP, "1");
            } catch {
              /* it just won't continue on its own */
            }
            await goToGoogle("setup");
          }
          setState(out.state);
          return out.onboarding;
        },
        true
      ),
    [act]
  );

  // Back from Google's permission screen: carry on where it left off.
  useEffect(() => {
    let pending = false;
    try {
      pending = localStorage.getItem(PENDING_SETUP) === "1";
      localStorage.removeItem(PENDING_SETUP);
    } catch {
      /* storage unavailable */
    }
    if (pending) run();
  }, [run]);

  const working = busy === "setup";
  return (
    <div className="space-y-3 rounded-xl border border-dash-green/30 bg-dash-green/5 p-4">
      <p>
        <b>Don&apos;t have it yet?</b> The app can set up Search Console and Google Analytics for your store, verify your site
        and submit your sitemap. Google will ask you to allow it once.
      </p>
      {state?.status === "needs_embed" && (
        <div className="space-y-2">
          <p>
            One last click: turn on <b>Google setup</b> in your theme, then press <b>Save</b>. It adds Google&apos;s tags to your
            store without editing your theme.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <a href={state.embedUrl} target="_blank" rel="noreferrer" className={button}>
              Open the theme editor
            </a>
            <button disabled={working} onClick={run} className={link}>
              {working ? "Checking…" : "I turned it on, finish setup"}
            </button>
          </div>
        </div>
      )}
      {state?.status === "needs_ga_account" && (
        <p>
          Google needs you to create a free Analytics account first (about two minutes):{" "}
          <a href="https://analytics.google.com/analytics/web/provision/" target="_blank" rel="noreferrer" className={link}>
            create it here
          </a>
          , then click Set it up for me again.
        </p>
      )}
      {state?.status === "done" && <p className="text-dash-green">{state.notes.join(" ")}</p>}
      {state?.status !== "needs_embed" && (
        <button disabled={working} onClick={run} className={button}>
          {working ? "Setting up…" : "Set it up for me"}
        </button>
      )}
    </div>
  );
}

function PropertyHelp({ step, status, busy, act, onOpenSettings }: { step: Step; status: Status; busy: string | null; act: Act; onOpenSettings: () => void }) {
  const [copied, setCopied] = useState(false);
  const [askOwner, setAskOwner] = useState(false);
  const google = status.steps.find((s) => s.id === "google")?.done;
  const shopify = status.platform === "shopify";
  if (!google) return <p className="text-dash-muted">Connect Google first; this is then found for you.</p>;
  const access = !step.done ? status.access : null;
  const recheck = (
    <button disabled={busy === "match"} onClick={() => act("match", () => api<Status>("/api/onboarding/match", {}), true)} className={link}>
      {busy === "match" ? "Looking…" : "Check again"}
    </button>
  );
  if (step.done) {
    return (
      <button onClick={onOpenSettings} className={link}>
        Change it in Settings
      </button>
    );
  }
  return (
    <div className="max-w-2xl space-y-3">
      {shopify ? (
        <SetupForMe act={act} busy={busy} />
      ) : (
        <p className="text-dash-muted">
          No {step.id === "analytics" ? "Google Analytics" : "Search Console"} yet? Set it up free at{" "}
          <a
            href={step.id === "analytics" ? "https://analytics.google.com" : "https://search.google.com/search-console/welcome"}
            target="_blank"
            rel="noreferrer"
            className={link}
          >
            {step.id === "analytics" ? "analytics.google.com" : "search.google.com/search-console"}
          </a>{" "}
          with the same Google account, then click Check again.
        </p>
      )}
      {access && (
        <div className="space-y-2">
          <button onClick={() => setAskOwner((v) => !v)} className={link}>
            Already set up under someone else&apos;s Google login? Ask them for access
          </button>
          {askOwner && (
            <>
              <p>
                The Google account <b>{status.email}</b> can&apos;t see {status.domain} yet. Send this to whoever set up your Google
                tools, then click Check again once they&apos;ve added you.
              </p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-dash-line bg-[#FBF8F2] p-3 font-dash text-xs">
                {access.body}
              </pre>
              <div className="flex flex-wrap items-center gap-3">
                <a href={`mailto:?subject=${encodeURIComponent(access.subject)}&body=${encodeURIComponent(access.body)}`} className={button}>
                  Email it
                </a>
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(`${access.subject}\n\n${access.body}`).then(() => setCopied(true), () => setCopied(false));
                  }}
                  className={link}
                >
                  {copied ? "Copied" : "Copy the message"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-4">
        {recheck}
        <button onClick={onOpenSettings} className={link}>
          Pick it yourself in Settings
        </button>
      </div>
      <p className="text-dash-muted">
        Signed in with the wrong Google account? <button onClick={onOpenSettings} className={link}>Switch it in Settings</button>.
      </p>
    </div>
  );
}
