// Small Neon Function entry that loads the full dashboard server from
// SERVER_BUNDLE_URL (a CDN copy pinned to a commit) and checks it against
// SERVER_BUNDLE_SHA256 before running it. Keeps the deploy package tiny.
import { createHash } from "node:crypto";

const res = await fetch(process.env.SERVER_BUNDLE_URL);
if (!res.ok) throw new Error(`Couldn't download the dashboard server: ${res.status}`);
const code = await res.text();
const hash = createHash("sha256").update(code).digest("hex");
if (hash !== process.env.SERVER_BUNDLE_SHA256) throw new Error("Dashboard server failed its integrity check.");

const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
export default mod.default;
