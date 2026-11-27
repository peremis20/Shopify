"use client";

import { clearApiCache } from "./seo-ui";

import { connectGoogleEmbedded, isEmbedded } from "./embedded-client";
import { useEffect, useState } from "react";
import type { ConnectionInfo, PropertyOptions } from "@/lib/analytics/types";
import { CloseIcon } from "./Icons";
import { ConfirmButton, GaLogo, GscLogo } from "./ui";

export function SettingsPanel({ connection, account, onClose, onChanged }: {
  connection: ConnectionInfo | undefined;
  account?: TeamAccount;
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
  // A team member works on the business but never changes its Google connection.
  const member = account?.role === "member";

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
      clearApiCache();
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
    clearApiCache();
    await fetch("/api/auth/google/disconnect", { method: "POST" }).catch(() => undefined);
    window.location.href = "/analytics";
  }

  async function signOut() {
    clearApiCache();
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.href = /^app\./i.test(window.location.host) ? `https://${window.location.host.slice(4)}/` : "/analytics";
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

        {(account || mode === "oauth") && (
          <div className="mb-5 rounded-xl border border-dash-line bg-white p-4 text-sm">
            <p className="text-dash-muted">Signed in as</p>
            <div className="mt-0.5 flex items-center justify-between gap-3">
              <p className="break-all font-semibold">{account?.email ?? connection?.email ?? "Google account"}</p>
              <button onClick={signOut} className="text-sm font-semibold text-dash-green hover:underline">
                Sign out
              </button>
            </div>
            {member && account?.ownerEmail && (
              <p className="mt-1 text-xs text-dash-muted">Team member. The main sign in for this business is {account.ownerEmail}.</p>
            )}
          </div>
        )}

        {mode === "oauth" && member && (
          <div className="space-y-3 text-sm">
            <p>
              Google is connected for this business by its main sign in{account?.ownerEmail ? `, ${account.ownerEmail}` : ""}. Only the
              main sign in can change which Analytics and Search Console properties are used, or connect Google again.
            </p>
            {connection?.gaPropertyId && <p className="text-dash-muted">Analytics property: {connection.gaPropertyId}</p>}
            {connection?.gscSiteUrl && <p className="text-dash-muted">Search Console: {connection.gscSiteUrl.replace(/^sc-domain:/, "Domain: ")}</p>}
          </div>
        )}

        {mode === "oauth" && !member && (
          <div className="space-y-5">

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
              <ConfirmButton
                label="Disconnect Google and sign out"
                confirmLabel="Click again to disconnect Google"
                onConfirm={disconnect}
                disabled={saving}
                className="text-sm font-semibold text-dash-down hover:underline disabled:opacity-60"
              />
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

        {account && !isEmbedded() && <TeamBox />}

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

        {mode === "none" && member && (
          <p className="text-sm">Only the main sign in can connect Google for this business{account?.ownerEmail ? ` (${account.ownerEmail})` : ""}.</p>
        )}

        {mode === "none" && !member && (
          <div className="space-y-5 text-sm">
            <p>
              Connect the Google account that has access to your Analytics and Search Console. DashPatrol reads them, and only changes
              something in your Google account when you ask it to, like Set it up for me (which adds your site to Search Console and
              creates an Analytics property).
            </p>
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
      onClick={(e) => {
        // Inside Shopify admin, Google opens at the top level and comes back into the app.
        if (!isEmbedded()) return;
        e.preventDefault();
        connectGoogleEmbedded().catch((err) => alert(err.message));
      }}
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
      clearApiCache();
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

/** Who is signed in: the person, the business's main sign in, and their role in it. */
export interface TeamAccount {
  email: string;
  admin: boolean;
  ownerEmail?: string;
  role?: "owner" | "member";
  business?: string;
}

interface TeamData {
  you: string;
  role: "owner" | "member";
  owner: string;
  business: string;
  embedded: boolean;
  members: { email: string; invitedBy: string; joinedAt: string }[];
  invites: { email: string; invitedBy: string; expiresAt: string }[];
  pending: { token: string; business: string; owner: string; expiresAt: string }[];
  ownsBusiness: boolean;
  businesses: { id: string; name: string; role: "owner" | "member"; current: boolean }[];
  cap: number;
  note?: string;
  reload?: boolean;
  error?: string;
}

type TeamAction = { invite: string } | { remove: string } | { accept: string } | { decline: string } | { switch: string };

async function teamCall(body?: TeamAction): Promise<TeamData> {
  const res = await fetch("/api/account/team", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const out = (await res.json().catch(() => ({}))) as TeamData;
  if (!res.ok) throw new Error(out.error || "That didn't work. Please try again.");
  // Joining, leaving or switching signs this browser in to another business: start fresh there.
  if (out.reload) {
    clearApiCache();
    window.location.href = "/analytics";
  }
  return out;
}

const shortDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** Invites waiting for the person signed in: Join or No thanks. */
function PendingInvites({ data, busy, act }: { data: TeamData; busy: boolean; act: (b: TeamAction) => void }) {
  if (!data.pending.length) return null;
  return (
    <div className="space-y-2">
      {data.pending.map((p) => (
        <div key={p.token} className="rounded-xl border border-dash-green/40 bg-white p-3">
          <p>
            <b>{p.owner}</b> invited you to join <b>{p.business}</b>.
          </p>
          {data.ownsBusiness && (
            <p className="mt-1 text-xs text-dash-muted">Your own business stays as it is. You can switch between them in Settings.</p>
          )}
          <div className="mt-2 flex gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => act({ accept: p.token })}
              className="rounded-lg bg-dash-green px-3 py-1.5 font-semibold text-white disabled:opacity-60"
            >
              Join {p.business}
            </button>
            <button type="button" disabled={busy} onClick={() => act({ decline: p.token })} className="text-xs font-semibold text-dash-muted hover:underline disabled:opacity-50">
              No thanks
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function useTeam() {
  const [data, setData] = useState<TeamData | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    teamCall().then(setData).catch((e) => setNote(e instanceof Error ? e.message : "The team couldn't be loaded."));
  }, []);
  const act = async (body: TeamAction, done?: string): Promise<boolean> => {
    setBusy(true);
    setNote(null);
    try {
      const out = await teamCall(body);
      if (out.reload) return true;
      setData(out);
      setNote(out.note ?? done ?? null);
      return true;
    } catch (e) {
      setNote(e instanceof Error ? e.message : "That didn't work. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { data, note, busy, act };
}

/** On the dashboard: an invite to join another business, shown right after signing in. */
export function TeamInvites() {
  const { data, note, busy, act } = useTeam();
  if (!data?.pending.length) return null;
  return (
    <div className="mb-4 space-y-2 text-sm">
      <PendingInvites data={data} busy={busy} act={(b) => void act(b)} />
      {note && <p className="text-xs text-dash-ink">{note}</p>}
    </div>
  );
}

/** Settings: the team. The main sign in invites and removes people; a member sees who they are and can leave. */
function TeamBox() {
  const { data, note, busy, act } = useTeam();
  const [email, setEmail] = useState("");
  const others = data?.businesses.filter((b) => !b.current) ?? [];
  return (
    <div className="mt-8 space-y-3 border-t border-dash-line pt-6 text-sm">
      <p className="font-serif text-xl">Team</p>
      {data && <PendingInvites data={data} busy={busy} act={(b) => void act(b)} />}

      {data?.role === "owner" && (
        <>
          <p className="text-dash-muted">
            Invite people to work on {data.business} with their own Google email. They join only after they sign in with that email
            and click Join. They can't change your Google connection.
          </p>
          <ul className="space-y-1">
            <li className="flex justify-between gap-2">
              <span className="break-all">{data.owner}</span>
              <span className="text-xs text-dash-muted">main sign in</span>
            </li>
            {data.members.map((m) => (
              <li key={m.email} className="flex items-center justify-between gap-2">
                <span className="break-all">{m.email}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act({ remove: m.email }, `${m.email} was removed and is signed out of this business.`)}
                  className="text-xs font-semibold text-dash-down hover:underline disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            ))}
            {data.invites.map((i) => (
              <li key={i.email} className="flex items-center justify-between gap-2">
                <span className="break-all text-dash-muted">
                  {i.email} <span className="text-xs">(invited, open until {shortDate(i.expiresAt)})</span>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act({ remove: i.email }, "Invite cancelled.")}
                  className="text-xs font-semibold text-dash-down hover:underline disabled:opacity-50"
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              if (!email.trim()) return;
              void act({ invite: email.trim() }).then((ok) => ok && setEmail(""));
            }}
            className="flex gap-2"
          >
            <input
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
              type="email"
              placeholder="name@example.com"
              aria-label="Email to invite"
              className="w-full min-w-0 rounded-lg border border-dash-line px-3 py-2"
            />
            <button type="submit" disabled={busy || !email.trim()} className="rounded-lg bg-dash-green px-3 py-2 font-semibold text-white disabled:opacity-60">
              Invite
            </button>
          </form>
          <p className="text-xs text-dash-muted">Up to {data.cap} team members.</p>
        </>
      )}

      {data?.role === "member" && (
        <>
          <p>
            You are signed in as <b className="break-all">{data.you}</b>, a team member of <b>{data.business}</b>. Its main sign in is{" "}
            <span className="break-all">{data.owner}</span>.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Leave ${data.business}? You lose access until you are invited again.`)) void act({ remove: data.you });
            }}
            className="text-sm font-semibold text-dash-down hover:underline disabled:opacity-50"
          >
            Leave this business
          </button>
        </>
      )}

      {others.length > 0 && (
        <div className="space-y-1 pt-2">
          <p className="font-semibold">Switch business</p>
          {others.map((b) => (
            <button
              key={b.id}
              type="button"
              disabled={busy}
              onClick={() => void act({ switch: b.id })}
              className="block text-left font-semibold text-dash-green hover:underline disabled:opacity-50"
            >
              Open {b.name}
              <span className="ml-1 text-xs font-normal text-dash-muted">{b.role === "owner" ? "(your own)" : "(team member)"}</span>
            </button>
          ))}
        </div>
      )}

      {!data && !note && <p className="text-dash-muted">Loading the team…</p>}
      {note && <p className="text-xs text-dash-ink">{note}</p>}
    </div>
  );
}
