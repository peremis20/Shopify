"use client";

import { useEffect, useState } from "react";
import { ConnectButton, GoogleClientForm, SetupSteps } from "./SettingsPanel";
import { BarsIcon, BoltIcon, KeyIcon, SearchIcon } from "./Icons";

const FEATURES = [
  { icon: BarsIcon, title: "Analytics and Search Console together", text: "Traffic, searches and top pages in one view." },
  { icon: KeyIcon, title: "Find quick SEO wins", text: "See the searches you almost rank for and track your positions weekly." },
  { icon: BoltIcon, title: "SEO on autopilot", text: "Your pages improve every day on Shopify, WordPress, Webflow, Wix or any site, with every change logged and undoable." },
];

/** What a visitor sees before signing in. */
export function SignInScreen({ error }: { error?: string | null }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setUnreachable(false);
    setAvailable(null);
    fetch("/api/session")
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((s) => {
        // The owner setup form only shows when the server itself says sign in isn't set up.
        if (typeof s?.signInAvailable !== "boolean") throw new Error("unexpected answer");
        setAvailable(s.signInAvailable);
      })
      .catch(() => setUnreachable(true));
  }, [attempt]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-dash-bg px-4 py-12 font-dash text-dash-ink">
      <div className="w-full max-w-4xl">
        <div className="mb-10 text-center">
          <p className="mb-3 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-dash-green">
            <SearchIcon className="h-4 w-4" /> DashPatrol
          </p>
          <h1 className="font-serif text-4xl text-dash-ink sm:text-5xl">Grow your search traffic, automatically</h1>
          <p className="mx-auto mt-4 max-w-xl text-dash-muted">
            Sign in with the Google account that has your Analytics and Search Console. Connect your website, and a
            short checklist walks you through the rest.
          </p>
        </div>

        <div className="mx-auto max-w-md rounded-2xl border border-dash-line bg-dash-card p-6 text-center shadow-sm">
          {error && <p className="mb-4 rounded-lg bg-dash-down/5 p-3 text-sm text-dash-down">{error}</p>}
          {unreachable ? (
            <div className="space-y-3" role="alert">
              <p className="text-sm text-dash-ink">Couldn&apos;t reach DashPatrol. Check your connection and try again.</p>
              <button
                onClick={() => setAttempt((n) => n + 1)}
                className="rounded-xl bg-dash-green px-4 py-2 text-sm font-semibold text-white hover:bg-dash-deep"
              >
                Try again
              </button>
            </div>
          ) : available === null ? (
            <div className="h-11" />
          ) : available ? (
            <>
              <ConnectButton label="Sign in with Google" />
              <p className="mt-4 text-xs text-dash-muted">
                DashPatrol reads your Analytics and Search Console. It only changes something in your Google account when you ask it
                to, like Set it up for me (which adds your site and creates an Analytics property).
              </p>
            </>
          ) : (
            <div className="space-y-4 text-left text-sm">
              <p className="font-semibold">First time setup for the platform owner</p>
              <SetupSteps canSaveClient />
              <GoogleClientForm onSaved={() => window.location.reload()} />
            </div>
          )}
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <div key={title} className="rounded-2xl border border-dash-line bg-dash-card p-5">
              <Icon className="mb-3 h-6 w-6 text-dash-green" />
              <p className="font-semibold">{title}</p>
              <p className="mt-1 text-sm text-dash-muted">{text}</p>
            </div>
          ))}
        </div>
        <p className="mt-8 text-center text-xs text-dash-muted">
          <a href="/privacy" className="hover:underline">Privacy</a> · <a href="/terms" className="hover:underline">Terms</a>
        </p>
      </div>
    </div>
  );
}
