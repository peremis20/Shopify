"use client";

import { useEffect, useState } from "react";
import type { AutopilotSettingsView } from "@/lib/analytics/autopilot/settings";
import { api } from "./seo-ui";

/**
 * Platform owner only: the keys every customer's features run on. Customers
 * never see this.
 */
export function PlatformForm({ settings, onSaved }: {
  settings?: AutopilotSettingsView;
  onSaved?: (s: AutopilotSettingsView) => void;
}) {
  const [origin, setOrigin] = useState("https://your-app");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setOrigin(window.location.origin), []);

  const has = settings?.platform;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const d = await api<{ settings: AutopilotSettingsView; claudeError?: string }>("/api/autopilot/platform", {
        anthropicKey,
        geminiKey,
        shopifyClientId: clientId,
        shopifyClientSecret: clientSecret,
      });
      setAnthropicKey("");
      setGeminiKey("");
      setClientSecret("");
      setNote(d.claudeError ? `Saved, but the AI key didn't work: ${d.claudeError}` : "Saved.");
      onSaved?.(d.settings);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  const input = (id: string, label: string, value: string, set: (v: string) => void, saved: boolean | undefined, secret = true) => (
    <label className="block">
      <span className="mb-1 block text-xs text-dash-muted">{label}</span>
      <input
        id={id}
        type={secret ? "password" : "text"}
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={saved ? "Saved. Leave blank to keep" : ""}
        autoComplete="off"
        className="w-full rounded-lg border border-dash-line bg-white px-3 py-2"
      />
    </label>
  );

  return (
    <div className="grid gap-5 text-sm lg:grid-cols-2">
      <div className="space-y-3">
        <p className="font-semibold">Platform setup (only you see this)</p>
        <p className="text-dash-muted">Your customers never enter keys. These power the autopilot for everyone.</p>
        <ol className="list-decimal space-y-1.5 pl-5 marker:text-dash-muted">
          <li>
            <b>AI writer:</b> a Claude API key from console.anthropic.com, or a Gemini API key from aistudio.google.com.
            One is enough; Claude is used when both are set. Usage is billed to you, a few cents per page improved.
          </li>
          <li>
            <b>Shopify app:</b> in the Shopify Dev Dashboard, create one app with <b>public distribution</b>. Set the App
            URL to <code className="break-all rounded bg-white px-1 text-xs">{origin}/analytics</code> and the redirect URL
            to <code className="break-all rounded bg-white px-1 text-xs">{origin}/api/shopify/callback</code>.
          </li>
          <li>
            Give it the scopes <code className="rounded bg-white px-1 text-xs">write_content</code>,{" "}
            <code className="rounded bg-white px-1 text-xs">write_products</code>,{" "}
            <code className="rounded bg-white px-1 text-xs">write_online_store_pages</code>,{" "}
            <code className="rounded bg-white px-1 text-xs">write_files</code>, and send the privacy and app/uninstalled
            webhooks to <code className="break-all rounded bg-white px-1 text-xs">{origin}/api/shopify/webhooks</code>.
          </li>
          <li>Paste the app&apos;s Client ID and secret here.</li>
        </ol>
      </div>
      <form onSubmit={save} className="space-y-3 rounded-xl border border-dash-line bg-white p-4">
        {input("pf-claude", "Claude API key", anthropicKey, setAnthropicKey, has?.hasAnthropic)}
        {input("pf-gemini", "or Gemini API key", geminiKey, setGeminiKey, has?.hasGemini)}
        {input("pf-shop-id", "Shopify app Client ID", clientId, setClientId, has?.hasShopifyApp, false)}
        {input("pf-shop-secret", "Shopify app Client secret", clientSecret, setClientSecret, has?.hasShopifyApp)}
        {note && <p className="text-dash-ink">{note}</p>}
        <button
          type="submit"
          disabled={busy || (!anthropicKey && !geminiKey && !clientId && !clientSecret)}
          className="rounded-xl bg-dash-green px-5 py-2.5 font-semibold text-white hover:bg-dash-deep disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save platform keys"}
        </button>
      </form>
    </div>
  );
}
