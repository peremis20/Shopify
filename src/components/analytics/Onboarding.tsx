"use client";

import { useCallback, useEffect, useState } from "react";
import type { Onboarding as Status, Step } from "@/lib/analytics/onboarding";
import { api } from "./seo-ui";
import { ConnectButton } from "./SettingsPanel";
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
      setOpen(null);
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
    case "shopify":
      return step.done ? <p className="text-dash-muted">Connected. You can disconnect any time in the Autopilot card.</p> : <ShopifyConnect />;
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

function PropertyHelp({ step, status, busy, act, onOpenSettings }: { step: Step; status: Status; busy: string | null; act: Act; onOpenSettings: () => void }) {
  const [copied, setCopied] = useState(false);
  const google = status.steps.find((s) => s.id === "google")?.done;
  if (!google) return <p className="text-dash-muted">Connect Google first; this is then found for you.</p>;
  const access = !step.done ? status.access : null;
  const recheck = (
    <button disabled={busy === "match"} onClick={() => act("match", () => api<Status>("/api/onboarding/match", {}), true)} className={button}>
      {busy === "match" ? "Looking…" : "Check again"}
    </button>
  );
  return (
    <div className="max-w-2xl space-y-3">
      {access ? (
        <>
          <p>
            The Google account <b>{status.email}</b> doesn&apos;t have access to {status.domain} yet. If someone else set up your
            Google tools, send them this message. Once they add you, click Check again.
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
            {recheck}
          </div>
          <p className="text-dash-muted">
            Signed in with the wrong Google account? <button onClick={onOpenSettings} className={link}>Switch it in Settings</button>.
          </p>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {recheck}
          <button onClick={onOpenSettings} className={link}>
            {step.done ? "Change it in Settings" : "Pick it yourself in Settings"}
          </button>
        </div>
      )}
    </div>
  );
}
