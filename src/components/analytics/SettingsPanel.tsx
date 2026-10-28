"use client";

import { useEffect, useState } from "react";
import type { ConnectionInfo, PropertyOptions } from "@/lib/analytics/types";
import { CloseIcon } from "./Icons";
import { GaLogo, GscLogo } from "./ui";

export function SettingsPanel({ connection, account, onClose, onChanged }: {
  connection: ConnectionInfo | undefined;
  account?: { email: string; admin: boolean };
  onClose: () => void;
  onChanged: () => void;
}) {
  const [options, setOptions] = useState<PropertyOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ga, setGa] = useState(connection?.gaPropertyId ?? "");
  const [gsc, setGsc] = useState(connection?.gscSiteUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const mode = connection?.mode ?? "none";

  useEffect(() => {
    if (mode !== "oauth") return;
    fetch("/api/analytics/properties")
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Couldn't load your properties");
        setOptions(body);
      })
      .catch((err) => setLoadError(err.message));
  }, [mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/analytics/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gaPropertyId: ga, gscSiteUrl: gsc }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Couldn't save");
      onChanged();
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    setSaving(true);
    await fetch("/api/auth/google/disconnect", { method: "POST" }).catch(() => undefined);
    window.location.href = "/analytics";
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.href = "/analytics";
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-md flex-col overflow-y-auto bg-dash-bg p-6 shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 id="settings-title" className="font-serif text-2xl">Settings</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-dash-muted hover:bg-black/5" aria-label="Close settings">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {mode === "oauth" && (
          <div className="space-y-5">
            <div className="rounded-xl border border-dash-line bg-white p-4 text-sm">
              <p className="text-dash-muted">Signed in as</p>
              <div className="mt-0.5 flex items-center justify-between gap-3">
                <p className="font-semibold">{account?.email ?? connection?.email ?? "Google account"}</p>
                <button onClick={signOut} className="text-sm font-semibold text-dash-green hover:underline">
                  Sign out
                </button>
              </div>
            </div>

            {loadError && <p className="rounded-lg bg-dash-down/5 p-3 text-sm text-dash-down">{loadError}</p>}

            <label className="block">
              <span className="mb-1.5 flex items-center gap-2 text-sm font-semibold"><GaLogo className="h-4 w-4" />Google Analytics property</span>
              <select
                id="ga-property"
                value={ga}
                onChange={(e) => setGa(e.target.value)}
                disabled={!options}
                className="w-full rounded-xl border border-dash-line bg-white px-3 py-2.5 text-sm disabled:opacity-60"
              >
                <option value="">{options ? "None" : "Loading your properties…"}</option>
                {options?.ga.items.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.account})
                  </option>
                ))}
              </select>
              {options?.ga.error && <span className="mt-1 block text-xs text-dash-down">{options.ga.error}</span>}
              {options && !options.ga.error && !options.ga.items.length && (
                <span className="mt-1 block text-xs text-dash-muted">This Google account has no GA4 properties.</span>
              )}
            </label>

            <label className="block">
              <span className="mb-1.5 flex items-center gap-2 text-sm font-semibold"><GscLogo className="h-4 w-4" />Search Console property</span>
              <select
                id="gsc-site"
                value={gsc}
                onChange={(e) => setGsc(e.target.value)}
                disabled={!options}
                className="w-full rounded-xl border border-dash-line bg-white px-3 py-2.5 text-sm disabled:opacity-60"
              >
                <option value="">{options ? "None" : "Loading your properties…"}</option>
                {options?.gsc.items.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/^sc-domain:/, "Domain: ")}
                  </option>
                ))}
              </select>
              {options?.gsc.error && <span className="mt-1 block text-xs text-dash-down">{options.gsc.error}</span>}
              {options && !options.gsc.error && !options.gsc.items.length && (
                <span className="mt-1 block text-xs text-dash-muted">This Google account has no verified Search Console sites.</span>
              )}
            </label>

            {saveError && <p className="text-sm text-dash-down">{saveError}</p>}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <button onClick={disconnect} disabled={saving} className="text-sm font-semibold text-dash-down hover:underline disabled:opacity-60">
                Disconnect Google and sign out
              </button>
              <button
                onClick={save}
                disabled={saving || !options}
                className="rounded-xl bg-dash-green px-5 py-2.5 text-sm font-semibold text-white hover:bg-dash-deep disabled:opacity-60"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}

        {account?.admin && (
          <div className="mt-8 space-y-4 border-t border-dash-line pt-6 text-sm">
            <p className="font-serif text-xl">Platform owner</p>
            <p className="text-dash-muted">
              Google sign in for all customers uses this OAuth client. Replace it only if you move to a new Google Cloud
              project.
            </p>
            <GoogleClientForm onSaved={onChanged} />
          </div>
        )}

        {mode === "service_account" && (
          <div className="space-y-4 text-sm">
            <p>This dashboard reads data through the server&apos;s Google service account.</p>
            <dl className="space-y-2 rounded-xl border border-dash-line bg-white p-4">
              <div><dt className="text-dash-muted">Analytics property</dt><dd className="font-medium">{connection?.gaPropertyId ?? "Not set (GA4_PROPERTY_ID)"}</dd></div>
              <div><dt className="text-dash-muted">Search Console property</dt><dd className="font-medium">{connection?.gscSiteUrl ?? "Not set (GSC_SITE_URL)"}</dd></div>
            </dl>
            <p className="text-dash-muted">These come from the server&apos;s environment settings.</p>
            {connection?.oauthAvailable && <ConnectButton label="Use my Google account instead" />}
          </div>
        )}

        {mode === "none" && (
          <div className="space-y-5 text-sm">
            <p>Connect the Google account that has access to your Analytics and Search Console. The dashboard only reads data and never changes anything.</p>
            {connection?.oauthAvailable ? (
              <ConnectButton />
            ) : (
              <>
                <SetupSteps redirectUri={connection?.redirectUri} canSaveClient={connection?.canSaveClient} />
                {connection?.canSaveClient && <GoogleClientForm onSaved={onChanged} />}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ConnectButton({ label = "Connect with Google" }: { label?: string }) {
  return (
    <a
      href="/api/auth/google/start"
      className="inline-flex items-center gap-2.5 rounded-xl border border-dash-line bg-white px-4 py-2.5 text-sm font-semibold text-dash-ink shadow-sm hover:border-dash-green/40"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
        <path fill="#4285F4" d="M22.5 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.2-4.8 3.2-8z" />
        <path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.2 1-3.7 1-2.8 0-5.2-1.9-6.1-4.5H2.2v2.8A11 11 0 0 0 12 23z" />
        <path fill="#FBBC05" d="M5.9 14.1a6.6 6.6 0 0 1 0-4.2V7.1H2.2a11 11 0 0 0 0 9.8z" />
        <path fill="#EA4335" d="M12 5.4c1.6 0 3 .6 4.1 1.6l3.1-3.1A11 11 0 0 0 2.2 7.1l3.7 2.8C6.8 7.3 9.2 5.4 12 5.4z" />
      </svg>
      {label}
    </a>
  );
}

export function GoogleClientForm({ onSaved }: { onSaved: () => void }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/analytics/google-client", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Couldn't save");
      setClientSecret("");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-dash-line bg-white p-4">
      <p className="font-semibold">Paste your Google credentials</p>
      <label className="block">
        <span className="mb-1 block text-xs text-dash-muted">Client ID</span>
        <input
          id="google-client-id"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="1234-abc.apps.googleusercontent.com"
          autoComplete="off"
          className="w-full rounded-lg border border-dash-line px-3 py-2 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs text-dash-muted">Client secret</span>
        <input
          id="google-client-secret"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder="GOCSPX-..."
          autoComplete="off"
          className="w-full rounded-lg border border-dash-line px-3 py-2 text-sm"
        />
      </label>
      {error && <p className="text-sm text-dash-down">{error}</p>}
      <p className="text-xs text-dash-muted">Stored encrypted in your Neon database. Only this dashboard can read it.</p>
      <button
        type="submit"
        disabled={saving || !clientId || !clientSecret}
        className="rounded-xl bg-dash-green px-5 py-2.5 text-sm font-semibold text-white hover:bg-dash-deep disabled:opacity-60"
      >
        {saving ? "Saving…" : "Save credentials"}
      </button>
    </form>
  );
}

export function SetupSteps({ redirectUri, canSaveClient }: { redirectUri?: string; canSaveClient?: boolean }) {
  const [origin, setOrigin] = useState("https://your-site.com");
  useEffect(() => setOrigin(window.location.origin), []);
  const callback = redirectUri ?? `${origin}/api/auth/google/callback`;
  return (
    <div className="space-y-3">
      <p className="font-semibold">One time setup (about 10 minutes)</p>
      <ol className="list-decimal space-y-2 pl-5 text-dash-ink marker:text-dash-muted">
        <li>
          In Google Cloud Console, create a project and enable the <b>Google Analytics Data API</b>,{" "}
          <b>Google Analytics Admin API</b> and <b>Google Search Console API</b>.
        </li>
        <li>
          Set up the <b>OAuth consent screen</b>. Choose Internal if you use Google Workspace, otherwise External and add
          your own email as a test user.
        </li>
        <li>
          Under Credentials, create an <b>OAuth client ID</b> of type Web application, with this redirect URI:
          <code className="mt-1 block break-all rounded bg-white px-2 py-1 text-xs">{callback}</code>
        </li>
        {canSaveClient ? (
          <li>Paste the Client ID and Client secret below and save. A <b>Connect with Google</b> button then appears.</li>
        ) : (
          <li>
            Add <code className="rounded bg-white px-1">GOOGLE_OAUTH_CLIENT_ID</code>,{" "}
            <code className="rounded bg-white px-1">GOOGLE_OAUTH_CLIENT_SECRET</code> and your Neon{" "}
            <code className="rounded bg-white px-1">DATABASE_URL</code> to your environment settings and restart. A{" "}
            <b>Connect with Google</b> button then appears here.
          </li>
        )}
      </ol>
    </div>
  );
}
