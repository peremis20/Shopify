"use client";

import { useEffect, useState } from "react";
import { ConnectButton, GoogleClientForm, SetupSteps } from "./SettingsPanel";
import { BarsIcon, BoltIcon, KeyIcon, SearchIcon } from "./Icons";

const FEATURES = [
  { icon: BarsIcon, title: "Analytics and Search Console together", text: "Traffic, searches and top pages in one view." },
  { icon: KeyIcon, title: "Find quick SEO wins", text: "See the searches you almost rank for and track your positions weekly." },
  { icon: BoltIcon, title: "SEO on autopilot", text: "Your Shopify pages improve every day, with every change logged and undoable." },
];

/** What a visitor sees before signing in. */
export function SignInScreen({ error }: { error?: string | null }) {
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/session")
      .then((r) => r.json())
      .then((s) => setAvailable(Boolean(s.signInAvailable)))
      .catch(() => setAvailable(false));
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-dash-bg px-4 py-12 font-dash text-dash-ink">
      <div className="w-full max-w-4xl">
        <div className="mb-10 text-center">
          <p className="mb-3 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-dash-green">
            <SearchIcon className="h-4 w-4" /> Insights
          </p>
          <h1 className="font-serif text-4xl text-dash-ink sm:text-5xl">Grow your store&apos;s search traffic, automatically</h1>
          <p className="mx-auto mt-4 max-w-xl text-dash-muted">
            Sign in with the Google account that has your Analytics and Search Console. Connect your Shopify store, and
            the autopilot does the rest.
          </p>
        </div>

        <div className="mx-auto max-w-md rounded-2xl border border-dash-line bg-dash-card p-6 text-center shadow-sm">
          {error && <p className="mb-4 rounded-lg bg-dash-down/5 p-3 text-sm text-dash-down">{error}</p>}
          {available === null ? (
            <div className="h-11" />
          ) : available ? (
            <>
              <ConnectButton label="Sign in with Google" />
              <p className="mt-4 text-xs text-dash-muted">
                Read only access to Analytics and Search Console. We never post or change anything in your Google account.
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
      </div>
    </div>
  );
}
