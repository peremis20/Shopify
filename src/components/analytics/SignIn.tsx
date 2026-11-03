"use client";

import { useEffect, useState } from "react";
import { ConnectButton, GoogleClientForm, SetupSteps } from "./SettingsPanel";
import { BarsIcon, BoltIcon, KeyIcon } from "./Icons";

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

  // The public site (dashpatrol.io) when the app runs on app.dashpatrol.io, so the menu matches the home page.
  const [home, setHome] = useState("");
  useEffect(() => {
    const h = window.location.host;
    if (/^app\./i.test(h)) setHome(`https://${h.slice(4)}`);
  }, []);
  const jakarta = { fontFamily: '"Plus Jakarta Sans", Inter, system-ui, sans-serif' };
  const links: [string, string][] = [["Benefits", "#benefits"], ["Features", "#see"], ["How It Works", "#how"], ["Savings", "#calc"], ["FAQ", "#faq"]];

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0A3520] via-[#0E4A2A] to-[#12602F] font-dash text-white">
      <header className="bg-[#0B3B22]">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <a target="_top" href={`${home}/`} className="flex items-center gap-2 text-[22px] font-extrabold text-white no-underline" style={jakarta}>
            <span className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-[#3DCB5A] text-lg text-[#0B3B22]">D</span>
            DashPatrol
          </a>
          {home && <nav className="hidden items-center gap-6 text-[15px] font-medium md:flex">
            {links.map(([label, hash]) => (
              <a key={hash} target="_top" href={`${home}/${hash}`} className="text-white/85 no-underline hover:text-white">{label}</a>
            ))}
          </nav>}
          <a target="_top" href={`${home}/`} className="text-sm font-semibold text-[#C6F432] no-underline hover:underline md:hidden">Home</a>
        </div>
      </header>

      <div className="flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-4xl">
          <div className="mb-10 text-center">
            <p className="mb-4 inline-block rounded-full bg-[#1E8A45] px-4 py-2 text-[13px] font-bold tracking-[0.06em] text-[#E9FFD9]">
              YOUR SEO TEAM, IN ONE APP
            </p>
            <h1 className="text-4xl font-extrabold leading-tight sm:text-5xl" style={jakarta}>
              Grow your business on <span className="italic text-[#C6F432]">autopilot.</span>
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-white/85">
              Sign in with the Google account that has your Analytics and Search Console. Connect your website, and a
              short checklist walks you through the rest.
            </p>
          </div>

          <div className="mx-auto max-w-md rounded-3xl bg-white p-7 text-center text-[#0E2A1A] shadow-[0_30px_60px_rgba(0,0,0,0.35),0_0_0_8px_rgba(155,226,60,0.25)]">
            {error && <p className="mb-4 rounded-lg bg-dash-down/5 p-3 text-sm text-dash-down">{error}</p>}
            {unreachable ? (
              <div className="space-y-3" role="alert">
                <p className="text-sm">Couldn&apos;t reach DashPatrol. Check your connection and try again.</p>
                <button
                  onClick={() => setAttempt((n) => n + 1)}
                  className="rounded-xl bg-[#0F5A32] px-4 py-2 text-sm font-semibold text-white hover:bg-[#0A3520]"
                >
                  Try again
                </button>
              </div>
            ) : available === null ? (
              <div className="h-11" />
            ) : available ? (
              <>
                <p className="mb-4 text-lg font-extrabold" style={jakarta}>Start free in one click</p>
                <ConnectButton label="Sign in with Google" />
                <p className="mt-4 text-xs text-[#5C6660]">
                  Free during early access. No credit card. DashPatrol reads your Analytics and Search Console. It only
                  changes something in your Google account when you ask it to, like Set it up for me (which adds your site
                  and creates an Analytics property).
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
              <div key={title} className="rounded-2xl border border-white/15 bg-white/[0.07] p-5">
                <Icon className="mb-3 h-6 w-6 text-[#C6F432]" />
                <p className="font-semibold">{title}</p>
                <p className="mt-1 text-sm text-white/80">{text}</p>
              </div>
            ))}
          </div>
          <p className="mt-8 text-center text-xs text-white/70">
            <a target="_top" href={`${home}/privacy`} className="text-white/85 hover:underline">Privacy policy</a> ·{" "}
            <a target="_top" href={`${home}/terms`} className="text-white/85 hover:underline">Terms of use</a> ·{" "}
            <a target="_top" href={`${home}/`} className="text-white/85 hover:underline">DashPatrol home</a>
          </p>
        </div>
      </div>
    </div>
  );
}
