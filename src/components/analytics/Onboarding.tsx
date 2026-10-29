"use client";

import { useCallback, useEffect, useState } from "react";
import type { Onboarding as Status, Step } from "@/lib/analytics/onboarding";
import { api } from "./seo-ui";
import { isEmbedded } from "./embedded-client";
import { ConnectButton } from "./SettingsPanel";
import { PlatformConnect } from "./PlatformConnect";
import { Card } from "./ui";

/**
 * Guided setup at the top of the dashboard: one question at a time, about two
 * minutes. Steps already done are skipped, optional ones can be skipped, and
 * the first site check starts on its own at the end.
 */
type Screen = "google" | "website" | "connect" | "business" | "data" | "finish";

const SKIP_KEY = "insights.onboardingSkip";
const readSkips = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(SKIP_KEY) ?? "[]");
  } catch {
    return [];
  }
};

/** The screens that apply to this customer, in order, and whether each is done. */
function screensFor(s: Status, skips: string[]): { id: Screen; done: boolean }[] {
  const step = (id: string) => s.steps.find((x) => x.id === id)?.done ?? false;
  const out: { id: Screen; done: boolean }[] = [
    { id: "google", done: step("google") },
    { id: "website", done: step("website") },
  ];
  if (s.platform && s.platform !== "shopify" && step("website")) out.push({ id: "connect", done: s.siteConnected || skips.includes("connect") });
  out.push({ id: "business", done: step("business") });
  out.push({ id: "data", done: (step("search_console") && step("analytics")) || skips.includes("data") });
  out.push({ id: "finish", done: step("autopilot") });
  return out;
}

const TITLES: Record<Screen, string> = {
  google: "Sign in with Google",
  website: "What's your website?",
  connect: "Let the app make changes for you",
  business: "What do you sell?",
  data: "Your Google data",
  finish: "Turn on the autopilot",
};

export function Onboarding({ onOpenSettings, onChanged }: { onOpenSettings: () => void; onChanged: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skips, setSkips] = useState<string[]>([]);
  const [back, setBack] = useState<Screen | null>(null);

  const load = useCallback(() => {
    api<Status>("/api/onboarding").then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(() => {
    setSkips(readSkips());
    load();
  }, [load]);

  async function act(id: string, run: () => Promise<Status | void>, refreshDashboard = false) {
    setBusy(id);
    setError(null);
    try {
      const next = (await run()) || (await api<Status>("/api/onboarding"));
      setStatus(next);
      if (refreshDashboard) onChanged();
      // Setup can stop halfway (a click only the owner can make), so it stays on its screen.
      if (id !== "setup") setBack(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  function skip(id: Screen) {
    const next = [...new Set([...skips, id])];
    setSkips(next);
    setBack(null);
    try {
      localStorage.setItem(SKIP_KEY, JSON.stringify(next));
    } catch {
      /* it just asks again next time */
    }
  }

  if (!status) return null;
  const screens = screensFor(status, skips);
  const current = back ?? screens.find((x) => !x.done)?.id ?? null;
  const all = (id: string) => status.steps.find((x) => x.id === id);

  if (!current) {
    if (status.dismissed) return null;
    return (
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dash-up/30 bg-dash-up/5 p-4 text-sm">
        <span>
          <b>You&apos;re all set.</b> The autopilot is working on your rankings; its changes show in the Autopilot card below.
        </span>
        <button onClick={() => act("hide", () => api<Status>("/api/onboarding/profile", { dismissed: true }))} className="font-semibold text-dash-green hover:underline">
          Close
        </button>
      </div>
    );
  }
  const left = screens.filter((x) => !x.done).length;
  if (status.dismissed) {
    return (
      <div className="mt-6 flex items-center justify-between gap-3 rounded-xl border border-dash-line bg-white px-4 py-3 text-sm">
        <span>
          Setup: {left} quick {left === 1 ? "step" : "steps"} left.
        </span>
        <button onClick={() => act("show", () => api<Status>("/api/onboarding/profile", { dismissed: false }))} className="font-semibold text-dash-green hover:underline">
          Continue setup
        </button>
      </div>
    );
  }

  const index = screens.findIndex((x) => x.id === current);
  const previous = screens.slice(0, index).reverse().find((x) => x.id !== "google")?.id ?? null;
  return (
    <Card className="mt-6">
      <div className="mx-auto max-w-xl py-2">
        <div className="mb-5 flex items-center justify-between text-xs text-dash-muted">
          <span>
            Step {index + 1} of {screens.length}
          </span>
          <button onClick={() => act("hide", () => api<Status>("/api/onboarding/profile", { dismissed: true }))} className="hover:text-dash-ink">
            Finish later
          </button>
        </div>
        <div className="mb-6 flex gap-1.5">
          {screens.map((x, i) => (
            <span key={x.id} className={`h-1.5 flex-1 rounded-full ${i < index || x.done ? "bg-dash-green" : i === index ? "bg-dash-green/50" : "bg-dash-line"}`} />
          ))}
        </div>
        <h2 className="mb-4 font-serif text-2xl text-dash-ink sm:text-3xl">{TITLES[current]}</h2>
        {error && <p className="mb-3 rounded-lg bg-dash-down/5 p-3 text-sm text-dash-down">{error}</p>}
        <div className="text-sm">
          {current === "google" && (
            <div className="space-y-3">
              <p className="text-dash-muted">One Google sign in covers Search Console and Analytics. The app only reads them.</p>
              <ConnectButton />
            </div>
          )}
          {current === "website" && <WebsiteConnect busy={busy === "website"} act={act} />}
          {current === "connect" && status.domain && (
            <div className="space-y-3">
              <PlatformConnect platform={status.platform} domain={status.domain} onConnected={() => act("connected", async () => undefined, true)} />
              <button onClick={() => skip("connect")} className="font-semibold text-dash-muted hover:text-dash-ink">
                Skip for now: I&apos;ll paste changes in myself
              </button>
            </div>
          )}
          {current === "business" && <BusinessPicker status={status} busy={busy} act={act} />}
          {current === "data" && (
            <div className="space-y-3">
              <p className="text-dash-muted">
                {all("search_console")?.done ? "Search Console is connected. " : ""}
                {all("analytics")?.done ? "Google Analytics is connected. " : ""}
                {!all("search_console")?.done ? all("search_console")?.detail : all("analytics")?.detail}
              </p>
              <PropertyHelp step={(!all("search_console")?.done ? all("search_console") : all("analytics"))!} status={status} busy={busy} act={act} onOpenSettings={onOpenSettings} />
              <button onClick={() => skip("data")} className="font-semibold text-dash-muted hover:text-dash-ink">
                Skip for now
              </button>
            </div>
          )}
          {current === "finish" && (
            <Finish status={status} busy={busy} act={act} onLater={() => act("hide", () => api<Status>("/api/onboarding/profile", { dismissed: true }))} />
          )}
        </div>
        {previous && current !== "google" && (
          <button onClick={() => setBack(previous)} className="mt-6 text-sm text-dash-muted hover:text-dash-ink">
            ← Back
          </button>
        )}
      </div>
    </Card>
  );
}

/** The last screen: the first site check starts on its own; one button turns the autopilot on. */
function Finish({ status, busy, act, onLater }: { status: Status; busy: string | null; act: Act; onLater: () => void }) {
  const checked = status.steps.find((x) => x.id === "first_check")?.done;
  useEffect(() => {
    if (!checked) api("/api/autopilot/check", {}).catch(() => undefined);
  }, [checked]);
  return (
    <div className="space-y-4">
      <p className="text-dash-muted">
        Your first site check is running now (rankings, site health, risky claims and overlapping pages). The autopilot then improves
        your pages every day, at most 4 a week, and every change can be undone.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          disabled={busy === "enable"}
          onClick={() => act("enable", async () => void (await api("/api/autopilot/settings", { enabled: true })), true)}
          className={button}
        >
          {busy === "enable" ? "Turning on…" : "Turn on the autopilot"}
        </button>
        <button
          onClick={() => {
            onLater();
            scrollTo("autopilot");
          }}
          className="font-semibold text-dash-green hover:underline"
        >
          Preview its first change before turning it on
        </button>
      </div>
    </div>
  );
}

/** One tap: what the business sells (the brand name is filled in from the store and can be changed later). */
function BusinessPicker({ status, busy, act }: { status: Status; busy: string | null; act: Act }) {
  return (
    <div className="space-y-3">
      <p className="text-dash-muted">So every change fits your business and stays within health claim rules.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {status.businessTypes.map((b) => (
          <button
            key={b.id}
            disabled={busy !== null}
            onClick={() => act(`business`, () => api<Status>("/api/onboarding/profile", { businessType: b.id }), true)}
            className={`rounded-xl border px-4 py-3 text-left font-semibold hover:border-dash-green hover:bg-dash-green/5 disabled:opacity-60 ${
              status.businessType === b.id ? "border-dash-green bg-dash-green/5" : "border-dash-line bg-white"
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

type Act = (id: string, run: () => Promise<Status | void>, refreshDashboard?: boolean) => Promise<void>;

const button = "rounded-xl bg-dash-green px-4 py-2 font-semibold text-white hover:bg-dash-deep disabled:opacity-60";
const link = "font-semibold text-dash-green hover:underline";

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
