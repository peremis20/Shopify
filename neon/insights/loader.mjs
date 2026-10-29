// Small Neon Function entry that loads the full dashboard server from a CDN
// copy pinned to a commit and checks it against its sha256 before running it.
// Keeps the deploy package tiny.
//
// Which version runs comes from the database (insights_settings, key
// "release": {"url", "sha", "assets"}), so a new version goes live with one
// database update instead of a redeploy. Warm instances recheck it every
// minute and switch over; a version that fails its check is never run (the
// current one keeps serving). Without a release row, SERVER_BUNDLE_URL,
// SERVER_BUNDLE_SHA256 and ASSET_BASE_URL are used.
import { createHash } from "node:crypto";

async function releaseFromDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const host = new URL(url).hostname.replace(/^[^.]+\./, "api.");
  const res = await fetch(`https://${host}/sql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Neon-Connection-String": url, "Neon-Raw-Text-Output": "true" },
    body: JSON.stringify({ query: "SELECT value FROM insights_settings WHERE key = 'release'", params: [] }),
  });
  if (!res.ok) return null;
  const value = (await res.json()).rows?.[0]?.value;
  return value ? JSON.parse(value) : null;
}

async function currentRelease() {
  const fromDb = await releaseFromDatabase().catch(() => null);
  if (fromDb?.url && fromDb?.sha) return fromDb;
  return { url: process.env.SERVER_BUNDLE_URL, sha: process.env.SERVER_BUNDLE_SHA256, assets: process.env.ASSET_BASE_URL };
}

async function load(release) {
  const res = await fetch(release.url);
  if (!res.ok) throw new Error(`Couldn't download the dashboard server: ${res.status}`);
  const code = await res.text();
  if (createHash("sha256").update(code).digest("hex") !== release.sha) throw new Error("Dashboard server failed its integrity check.");
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return mod.default;
}

let active = null;
let checkedAt = 0;

async function handler() {
  if (active && Date.now() - checkedAt < 60_000) return active.server;
  checkedAt = Date.now();
  const release = await currentRelease();
  const key = `${release.url}#${release.sha}`;
  if (active?.key !== key) {
    try {
      const server = await load(release);
      if (release.assets) process.env.ASSET_BASE_URL = release.assets;
      active = { key, server };
    } catch (err) {
      console.error(`release ${release.url} not loaded: ${err instanceof Error ? err.message : err}`);
      if (!active) throw err;
    }
  }
  return active.server;
}

export default {
  async fetch(req) {
    return (await handler()).fetch(req);
  },
};
