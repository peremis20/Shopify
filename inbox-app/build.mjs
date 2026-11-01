// Builds Team Inbox into one file and a zip for the Neon Function `inbox`.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
const root = new URL("..", import.meta.url).pathname;
mkdirSync(`${root}inbox-app/dist`, { recursive: true });
await build({ entryPoints: [`${root}inbox-app/server.ts`], bundle: true, minify: true, platform: "node", target: "node24", format: "esm", outfile: `${root}inbox-app/dist/index.mjs`, logLevel: "warning" });
rmSync(`${root}inbox-app/dist/inbox.zip`, { force: true });
execFileSync("zip", ["-9", "-j", "-q", `${root}inbox-app/dist/inbox.zip`, `${root}inbox-app/dist/index.mjs`]);
console.log("Built inbox-app/dist/inbox.zip");
