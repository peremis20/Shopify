"use client";

import { useEffect, useState } from "react";
import { api } from "./seo-ui";
import { WordPressConnect } from "./WordPressConnect";

/**
 * How a WordPress, Webflow or Wix site turns on automatic changes, shown
 * when the site runs on one of them and isn't connected yet. Other platforms
 * keep the fix list.
 */
export function PlatformConnect({ platform, domain, onConnected }: { platform: string | null; domain: string; onConnected: () => void }) {
  if (platform === "wordpress") return <WordPressConnect domain={domain} />;
  if (platform === "webflow") return <WebflowConnect onConnected={onConnected} />;
  if (platform === "wix") return <WixConnect onConnected={onConnected} />;
  return <SnippetConnect platform={platform} onConnected={onConnected} />;
}

/** Where the header code goes, per platform. */
const WHERE: Record<string, string> = {
  squarespace: "Squarespace: Settings, Advanced, Code Injection, Header. Paste, then Save. (Needs a Business plan or higher.)",
  framer: "Framer: Site Settings, General, Custom Code, Start of <head> tag. Paste, then Publish.",
  godaddy: "GoDaddy: Website, Settings, Site-wide code. Paste, then Publish.",
  duda: "Duda: Settings, Head HTML. Paste, then Republish.",
  weebly: "Weebly: Settings, SEO, Header Code. Paste, then Publish.",
  ghost: "Ghost: Settings, Code injection, Site header. Paste, then Save.",
  hubspot: "HubSpot: Settings, Website, Pages, Site header HTML. Paste, then Save.",
  custom:
    "Paste it inside the <head> of every page (in most sites that's one shared layout or template file). Built with an AI builder like Lovable, Bolt or Replit? Ask it: \"Add this script tag to the <head> of every page\" and paste the line.",
};

function SnippetConnect({ platform, onConnected }: { platform: string | null; onConnected: () => void }) {
  const [tag, setTag] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useConnect("/api/snippet/check", onConnected);
  const [checkError, setCheckError] = useState<string | null>(null);
  useEffect(() => {
    api<{ tag: string }>("/api/snippet").then((d) => setTag(d.tag), () => setTag(null));
  }, []);
  if (!tag) return null;
  return (
    <div className={box}>
      <p>
        <b>Let the autopilot change your site itself.</b> Add one line to your site&apos;s header, once. Then SEO titles,
        descriptions, structured data and internal links update automatically, and undo removes them right away. Page text still
        comes as a fix list.
      </p>
      <pre className="overflow-auto whitespace-pre-wrap rounded-lg border border-dash-line bg-white p-3 font-mono text-xs">{tag}</pre>
      <p className="text-dash-muted">{WHERE[platform ?? ""] ?? WHERE.custom}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => navigator.clipboard?.writeText(tag).then(() => setCopied(true), () => setCopied(false))} className={button}>
          {copied ? "Copied" : "Copy the line"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setCheckError(null);
            const d = await api<{ installed: boolean; error?: string }>("/api/snippet/check", {}).catch((e: Error) => ({ installed: false, error: e.message }));
            if (d.installed) run({});
            else setCheckError(d.error ?? "Not found yet.");
          }}
          className="font-semibold text-dash-green hover:underline"
        >
          {busy ? "Checking…" : "I added it, check my site"}
        </button>
      </div>
      {(checkError || error) && <p className="text-dash-down">{checkError ?? error}</p>}
    </div>
  );
}

const box = "space-y-2 rounded-xl border border-dash-green/30 bg-dash-green/5 p-4 text-sm";
const button = "rounded-xl bg-dash-green px-4 py-2 font-semibold text-white hover:bg-dash-deep disabled:opacity-60";
const input = "w-full rounded-lg border border-dash-line bg-white px-3 py-2";

function useConnect(url: string, onConnected: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (body: Record<string, string>) => {
    setBusy(true);
    setError(null);
    try {
      await api(url, body);
      onConnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function WebflowConnect({ onConnected }: { onConnected: () => void }) {
  const [token, setToken] = useState("");
  const { busy, error, run } = useConnect("/api/webflow/connect", onConnected);
  return (
    <form
      className={box}
      onSubmit={(e) => {
        e.preventDefault();
        run({ token });
      }}
    >
      <p>
        <b>Your site runs on Webflow.</b> Connect it and the autopilot updates page SEO titles and descriptions, and blog post
        content, itself. About a minute:
      </p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>In Webflow, open your site&apos;s Site settings, then Apps &amp; integrations, then API access.</li>
        <li>
          Click Generate API token. Give it read and write access to <b>Sites</b>, <b>Pages</b> and <b>CMS</b>, then copy it.
        </li>
        <li>Paste it here.</li>
      </ol>
      <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Webflow API token" aria-label="Webflow API token" className={input} />
      {error && <p className="text-dash-down">{error}</p>}
      <button type="submit" disabled={busy || !token.trim()} className={button}>
        {busy ? "Connecting…" : "Connect Webflow"}
      </button>
      <p className="text-dash-muted">
        The app only publishes the site when it has no other unpublished changes, so your own work in progress never goes live by
        surprise.
      </p>
    </form>
  );
}

function WixConnect({ onConnected }: { onConnected: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [siteId, setSiteId] = useState("");
  const { busy, error, run } = useConnect("/api/wix/connect", onConnected);
  return (
    <form
      className={box}
      onSubmit={(e) => {
        e.preventDefault();
        run({ apiKey, siteId });
      }}
    >
      <p>
        <b>Your site runs on Wix.</b> Connect it and the autopilot updates your blog posts&apos; SEO titles, descriptions and
        structured data itself. Wix doesn&apos;t allow apps to edit regular pages, so those stay on the fix list. About two minutes:
      </p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          Open{" "}
          <a href="https://manage.wix.com/account/api-keys" target="_blank" rel="noreferrer" className="font-semibold text-dash-green hover:underline">
            Wix API Keys
          </a>
          , click Generate API Key, give it a name, tick <b>Wix Blog</b>, then Generate and copy the key.
        </li>
        <li>Open your site&apos;s Wix dashboard and copy the address from your browser (it contains the site id).</li>
        <li>Paste both here.</li>
      </ol>
      <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Wix API key" aria-label="Wix API key" className={input} />
      <input value={siteId} onChange={(e) => setSiteId(e.target.value)} placeholder="Wix dashboard address or site id" aria-label="Wix site id" className={input} />
      {error && <p className="text-dash-down">{error}</p>}
      <button type="submit" disabled={busy || !apiKey.trim() || !siteId.trim()} className={button}>
        {busy ? "Connecting…" : "Connect Wix"}
      </button>
    </form>
  );
}
