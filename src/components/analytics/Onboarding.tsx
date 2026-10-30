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
type Screen = "google" | "website" | "connect" | "business" | "data" | "keywords" | "finish";

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
  out.push({ id: "keywords", done: step("targets") || skips.includes("keywords") });
  out.push({ id: "finish", done: step("autopilot") });
  return out;
}

const TITLES: Record<Screen, string> = {
  google: "Sign in with Google",
  website: "What's your website?",
  connect: "Let the app make changes for you",
  business: "What kind of site is this?",
  data: "Search Console and Google Analytics",
  keywords: "Pick your first searches to win",
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

  // Skipped the Google data: a quiet reminder stays until it's added.
  const dataMissing = !all("search_console")?.done || !all("analytics")?.done;
  if (!current && dataMissing && all("google")?.done) {
    const unskip = () => {
      const nextSkips = skips.filter((x) => x !== "data");
      setSkips(nextSkips);
      setBack("data");
      try {
        localStorage.setItem(SKIP_KEY, JSON.stringify(nextSkips));
      } catch {
        /* fine */
      }
    };
    return (
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#E7D3B4] bg-[#FBF1E1] p-4 text-sm">
        <span>
          <b>Add Search Console and Google Analytics</b> to see your search data and let the autopilot measure every change. It
          takes a minute.
        </span>
        <button onClick={unskip} className={button}>
          Set it up
        </button>
      </div>
    );
  }
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
          {current === "data" && <DataScreen status={status} busy={busy} act={act} onOpenSettings={onOpenSettings} onSkip={() => skip("data")} />}
          {current === "keywords" && <KeywordsScreen act={act} onSkip={() => skip("keywords")} />}
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

/**
 * One question: do they have Search Console and Analytics? The app has already
 * looked (at sign in), so this only shows when something wasn't found.
 */
function DataScreen({
  status,
  busy,
  act,
  onOpenSettings,
  onSkip,
}: {
  status: Status;
  busy: string | null;
  act: Act;
  onOpenSettings: () => void;
  onSkip: () => void;
}) {
  const pending = (() => {
    try {
      return localStorage.getItem(PENDING_SETUP) === "1";
    } catch {
      return false;
    }
  })();
  const [mode, setMode] = useState<"choose" | "setup" | "have">(pending ? "setup" : "choose");
  const sc = status.steps.find((x) => x.id === "search_console")!;
  const ga = status.steps.find((x) => x.id === "analytics")!;
  const missing = [!sc.done && "Search Console", !ga.done && "Google Analytics"].filter(Boolean).join(" or ");
  const site = status.domain ?? "your site";
  const choice = "w-full rounded-xl border px-4 py-3 text-left hover:border-dash-green hover:bg-dash-green/5";
  const otherOptions = (
    <button onClick={() => setMode("choose")} className="text-sm text-dash-muted hover:text-dash-ink">
      ← Other options
    </button>
  );
  if (mode === "setup") {
    return (
      <div className="space-y-3">
        <SetupForMe act={act} busy={busy} autoStart={!pending} />
        {otherOptions}
      </div>
    );
  }
  if (mode === "have") {
    return (
      <div className="space-y-3">
        <PropertyHelp step={!sc.done ? sc : ga} status={status} busy={busy} act={act} onOpenSettings={onOpenSettings} hideSetup />
        {otherOptions}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-dash-muted">
        We couldn&apos;t find {missing} for {site} on {status.email}. {sc.done ? "Search Console is connected. " : ""}
        {ga.done ? "Google Analytics is connected. " : ""}
      </p>
      <button onClick={() => setMode("setup")} className={`${choice} border-dash-green bg-dash-green/5`}>
        <span className="block font-semibold text-dash-ink">I don&apos;t have them, set them up for me</span>
        <span className="block text-dash-muted">About a minute. The app creates them and connects your site to Google.</span>
      </button>
      <button onClick={() => setMode("have")} className={`${choice} border-dash-line bg-white`}>
        <span className="block font-semibold text-dash-ink">I already have them on another Google account</span>
        <span className="block text-dash-muted">Switch accounts, or send the owner a quick message to add you.</span>
      </button>
      <button onClick={onSkip} className={`${choice} border-dash-line bg-white`}>
        <span className="block font-semibold text-dash-ink">Skip for now, I&apos;ll add them later</span>
        <span className="block text-dash-muted">
          The autopilot still works, using Google rankings and keyword data. Search Console just adds more detail; a reminder stays on your dashboard.
        </span>
      </button>
    </div>
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
      <p className="text-dash-muted">Your first site check is running now. Once the autopilot is on, every week it:</p>
      <ul className="list-disc space-y-1 pl-5 text-dash-muted">
        <li>Improves up to 4 pages for your searches, specific long tail ones first: titles, descriptions, a new section and links from your other articles</li>
        <li>Writes up to 3 new articles for searches no page covers yet, planned from what ranks on Google page 1</li>
        <li>Checks where you stand on Google every day and undoes changes that don&apos;t help</li>
        {status.platform && status.platform !== "shopify" && status.platform !== "wordpress" && (
          <li>Sends what it can&apos;t change on your site itself (new sections and articles) to your fix list, ready to paste</li>
        )}
      </ul>
      <p className="text-dash-muted">You can change both numbers in Autopilot settings, and undo any change.</p>
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
      <p className="text-dash-muted">So every change fits your site, speaks to shoppers or readers, and stays within health claim rules.</p>
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
  | {
      status: "needs_paste";
      platform: string | null;
      verificationTag: string | null;
      verificationCode: string | null;
      measurementId: string | null;
      gtag: string | null;
      snippet: boolean;
      snippetTag: string | null;
    }
  | { status: "needs_ga_account"; url: string | null }
  | { status: "done"; notes: string[] };

/** Where each platform's own Google boxes are, for the one paste "Set it up for me" can't do itself. */
const PASTE_WHERE: Record<string, { verification: string; analytics: string; separate: boolean }> = {
  webflow: {
    verification: "In Webflow, open Site settings, then the SEO tab. Paste the code into Google Site Verification.",
    analytics: "Same Site settings, Integrations tab: paste the Measurement ID into Google Analytics. Then Publish.",
    separate: true,
  },
  wix: {
    verification: "In Wix, open Marketing & SEO, then SEO, then Site verification. Choose Google Search Console and paste the meta tag.",
    analytics: "Then Settings, Marketing Integrations, Google Analytics, Connect: paste the Measurement ID. Publish.",
    separate: true,
  },
  squarespace: {
    verification: "In Squarespace, open Settings, Developer tools, Code Injection, Header. Paste the code below and Save.",
    analytics: "",
    separate: false,
  },
};
const HEADER_WHERE: Record<string, string> = {
  godaddy: "In GoDaddy: Website, Settings, Site-wide code. Paste the code below, then Publish.",
  duda: "In Duda: Settings, Head HTML. Paste the code below, then Republish.",
  weebly: "In Weebly: Settings, SEO, Header Code. Paste the code below, then Publish.",
  ghost: "In Ghost: Settings, Code injection, Site header. Paste the code below, then Save.",
  hubspot: "In HubSpot: Settings, Website, Pages, Site header HTML. Paste the code below, then Save.",
  framer: "In Framer: Site Settings, General, Custom Code, Start of <head> tag. Paste the code below, then Publish.",
};

const PENDING_SETUP = "insights.pendingSetup";

/** Leaves the page for Google (at the top level when inside Shopify admin). */
async function goToGoogle(purpose: "setup") {
  const { url } = await api<{ url: string }>(`/api/auth/google/link?purpose=${purpose}`);
  if (isEmbedded()) window.open(url, "_top");
  else window.location.href = url;
}

/** "Set it up for me": creates Search Console and Analytics, guiding through the one or two clicks only the owner can do. */
function SetupForMe({ act, busy, autoStart = false }: { act: Act; busy: string | null; autoStart?: boolean }) {
  const [state, setState] = useState<SetupState | null>(null);

  const run = useCallback(
    () =>
      act(
        "setup",
        async () => {
          const out = await api<{ state: SetupState; onboarding: Status }>("/api/onboarding/setup-google", {});
          const goingAway = out.state.status === "needs_permission" || (out.state.status === "needs_ga_account" && out.state.url);
          if (goingAway) {
            try {
              localStorage.setItem(PENDING_SETUP, "1");
            } catch {
              /* it just won't continue on its own */
            }
            if (out.state.status === "needs_permission") await goToGoogle("setup");
            else if (out.state.status === "needs_ga_account" && out.state.url) window.open(out.state.url, "_top");
          }
          setState(out.state);
          return out.onboarding;
        },
        true
      ),
    [act]
  );

  // Back from Google's permission or Analytics terms screen: carry on where it left off.
  useEffect(() => {
    let pending = false;
    try {
      pending = localStorage.getItem(PENDING_SETUP) === "1";
      localStorage.removeItem(PENDING_SETUP);
    } catch {
      /* storage unavailable */
    }
    if (pending || autoStart) run();
    // Only on arrival: later runs come from the buttons.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const working = busy === "setup";
  return (
    <div className="space-y-3 rounded-xl border border-dash-green/30 bg-dash-green/5 p-4">
      <p>
        <b>Don&apos;t have it yet? The app sets it up for you:</b> Search Console and Google Analytics, your site verified and your
        sitemap sent to Google. Google asks you to allow it once.
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
          Google needs you to accept its Analytics terms once.{" "}
          <a href={state.url ?? "https://analytics.google.com/analytics/web/provision/"} target="_top" className={link}>
            Accept Google&apos;s terms
          </a>
          , and you come straight back here.
        </p>
      )}
      {state?.status === "needs_paste" && <PasteCodes state={state} busy={working} onDone={run} />}
      {state?.status === "done" && <p className="text-dash-green">{state.notes.join(" ")}</p>}
      {state?.status !== "needs_embed" && state?.status !== "needs_paste" && (
        <button disabled={working} onClick={run} className={button}>
          {working ? "Setting up…" : "Set it up for me"}
        </button>
      )}
    </div>
  );
}

/** The one paste: Google's code (and Analytics tag) into the platform's own box, then the app finishes the rest. */
function PasteCodes({ state, busy, onDone }: { state: Extract<SetupState, { status: "needs_paste" }>; busy: boolean; onDone: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string) => navigator.clipboard?.writeText(text).then(() => setCopied(key), () => setCopied(null));
  const where = PASTE_WHERE[state.platform ?? ""];
  const header = [state.verificationTag, state.snippetTag ?? state.gtag].filter(Boolean).join("\n");
  const placeText =
    where?.verification ??
    HEADER_WHERE[state.platform ?? ""] ??
    (state.snippet
      ? "Paste this line in your site's header, right next to the snippet line you added."
      : "Paste this inside the <head> of every page (one shared layout or template file on most sites). Built with an AI builder? Ask it to add these lines to the <head> of every page.");
  // Most owners have someone who manages their site: one click sends them everything.
  const handOff = [
    "Hi,",
    "",
    "Could you add this code to our website, please? It takes a minute.",
    "",
    where?.separate
      ? [state.verificationTag && `${where.verification}\n${state.platform === "wix" ? state.verificationTag : state.verificationCode}`, state.measurementId && `${where.analytics}\nMeasurement ID: ${state.measurementId}`]
          .filter(Boolean)
          .join("\n\n")
      : `${placeText}\n\n${header}`,
    "",
    "Then publish the site. Thank you!",
  ].join("\n");
  const box = (key: string, label: string, text: string) => (
    <div className="space-y-1">
      <p className="text-xs font-semibold text-dash-muted">{label}</p>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-auto whitespace-pre-wrap rounded-lg border border-dash-line bg-white p-2 font-mono text-xs">{text}</pre>
        <button type="button" onClick={() => copy(key, text)} className="shrink-0 rounded-lg border border-dash-line bg-white px-3 py-1.5 text-xs font-semibold">
          {copied === key ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
  return (
    <div className="space-y-3">
      <p>
        <b>One paste and you&apos;re done.</b> Google needs to see this code on your site to confirm it&apos;s yours.
      </p>
      {where?.separate ? (
        <>
          {state.verificationTag && (
            <>
              <p>{where.verification}</p>
              {box("v", state.platform === "wix" ? "Meta tag" : "Verification code", state.platform === "wix" ? state.verificationTag : state.verificationCode ?? "")}
            </>
          )}
          {state.measurementId && (
            <>
              <p>{where.analytics}</p>
              {box("m", "Measurement ID", state.measurementId)}
            </>
          )}
        </>
      ) : (
        <>
          <p>{placeText}</p>
          {state.snippetTag && (
            <p className="text-dash-muted">This one paste also lets the autopilot improve your pages and adds Google Analytics, so there&apos;s nothing else to add later.</p>
          )}
          {header && box("h", "Code", header)}
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button disabled={busy} onClick={onDone} className={button}>
          {busy ? "Checking your site…" : "I pasted it, finish setup"}
        </button>
        <a
          href={`mailto:?subject=${encodeURIComponent("Please add this code to our website")}&body=${encodeURIComponent(handOff)}`}
          className="font-semibold text-dash-green hover:underline"
        >
          Not technical? Email it to your web person
        </a>
      </div>
      <p className="text-dash-muted">Sent it to someone? Come back once they&apos;ve added it and click &quot;I pasted it, finish setup&quot;.</p>
    </div>
  );
}

function PropertyHelp({
  step,
  status,
  busy,
  act,
  onOpenSettings,
  hideSetup = false,
}: {
  step: Step;
  status: Status;
  busy: string | null;
  act: Act;
  onOpenSettings: () => void;
  hideSetup?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [askOwner, setAskOwner] = useState(hideSetup);
  const google = status.steps.find((s) => s.id === "google")?.done;
  // Set it up for me works for any connected website.
  const canSetUp = status.platform === "shopify" || Boolean(status.domain);
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
      {/* Never Google's own setup screens: the app sets it up, or the owner adds this account. */}
      {!hideSetup && canSetUp && <SetupForMe act={act} busy={busy} />}
      {access && (
        <div className="space-y-2">
          {!hideSetup && (
            <button onClick={() => setAskOwner((v) => !v)} className={link}>
              Already set up under someone else&apos;s Google login? Ask them for access
            </button>
          )}
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

interface Suggestion {
  query: string;
  page: string;
  monthlySearches?: number;
  why?: string;
  winnable?: boolean;
  role?: "main" | "support";
}

/**
 * The searches the app found (from Search Console, or from studying competitors
 * when there's no data yet), the specific ones with room on page 1 first. The
 * best five come checked; one click hands them to the autopilot.
 */
function KeywordsScreen({ act, onSkip }: { act: Act; onSkip: () => void }) {
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => {
    api<{ opportunities: Suggestion[] }>("/api/seo/opportunities?range=28d")
      .then((d) => {
        const seen = new Set<string>();
        const best = d.opportunities
          .filter((o) => o.role !== "support" && !seen.has(o.query) && seen.add(o.query))
          .sort((a, b) => Number(b.winnable ?? false) - Number(a.winnable ?? false) || (b.monthlySearches ?? 0) - (a.monthlySearches ?? 0))
          .slice(0, 8);
        setItems(best);
        setPicked(new Set(best.slice(0, 5).map((o) => o.query)));
      })
      .catch(() => setItems([]));
  }, []);

  if (!items)
    return (
      <p className="text-dash-muted">
        Studying the sites on Google page 1 for your topics to find searches you can win. This can take about a minute.
      </p>
    );
  if (!items.length)
    return (
      <div className="space-y-3">
        <p className="text-dash-muted">
          Still finding searches for your pages. They&apos;ll show in SEO Tools, Opportunities, within the hour, each with a Rank for this button.
        </p>
        <button onClick={onSkip} className={button}>
          Continue
        </button>
      </div>
    );

  const go = () =>
    act("targets", async () => {
      const list = items.filter((o) => picked.has(o.query));
      for (const [i, o] of list.entries()) {
        setProgress(`Checking Google for "${o.query}" (${i + 1} of ${list.length})`);
        await api("/api/seo/target", { keyword: o.query, monthlySearches: o.monthlySearches });
      }
      setProgress(null);
    });

  return (
    <div className="space-y-3">
      <p className="text-dash-muted">
        Specific searches rank first, so these are what the autopilot works on first. Green ones have smaller sites on page 1, so
        there&apos;s room for you.
      </p>
      <ul className="space-y-1.5">
        {items.map((o) => (
          <li key={o.query}>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-dash-line bg-white px-3 py-2 hover:border-dash-green/40">
              <input
                type="checkbox"
                className="mt-1"
                checked={picked.has(o.query)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(o.query);
                  else next.delete(o.query);
                  setPicked(next);
                }}
              />
              <span className="min-w-0">
                <span className="block font-semibold text-dash-ink">{o.query}</span>
                <span className={`block text-xs ${o.winnable ? "text-dash-up" : "text-dash-muted"}`}>
                  {o.monthlySearches ? `${o.monthlySearches.toLocaleString()} searches a month` : ""}
                  {o.monthlySearches && o.why ? " · " : ""}
                  {o.why ?? ""}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {progress && <p className="text-dash-muted">{progress}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button disabled={!picked.size || progress !== null} onClick={go} className={button}>
          Rank for {picked.size === 1 ? "this search" : `these ${picked.size} searches`}
        </button>
        <button onClick={onSkip} className="font-semibold text-dash-muted hover:text-dash-ink">
          Skip for now
        </button>
      </div>
    </div>
  );
}
