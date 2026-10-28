// Builds the Insights dashboard for Neon Functions:
//   neon/insights/public/app.js + app.css   page assets (commit these; served from a CDN)
//   neon/insights/release/server.mjs        the dashboard server (commit it; loaded from a CDN)
//   neon/dist/insights.zip                  the whole server as one function bundle
//   neon/dist/loader.zip                    a tiny function that loads server.mjs (see loader.mjs)
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("..", import.meta.url).pathname;
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

mkdirSync(`${root}neon/insights/public`, { recursive: true });
mkdirSync(`${root}neon/dist`, { recursive: true });
mkdirSync(`${root}neon/insights/release`, { recursive: true });

await build({
  entryPoints: [`${root}neon/insights/client.tsx`],
  bundle: true,
  minify: true,
  format: "iife",
  jsx: "automatic",
  target: "es2020",
  tsconfig: `${root}tsconfig.json`,
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: `${root}neon/insights/public/app.js`,
  logLevel: "warning",
});

writeFileSync(`${root}neon/dist/tailwind.css`, "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n");
run("npx", ["tailwindcss", "-c", "tailwind.config.ts", "-i", "neon/dist/tailwind.css", "-o", "neon/insights/public/app.css", "--minify"]);

// Neon Functions run ESM on Node 24. The server has no CommonJS dependencies, so it needs
// no require() shim, which also lets loader.mjs import it from a data: URL.
await build({
  entryPoints: [`${root}neon/insights/index.ts`],
  bundle: true,
  minify: true,
  platform: "node",
  target: "node24",
  format: "esm",
  tsconfig: `${root}tsconfig.json`,
  outfile: `${root}neon/dist/index.mjs`,
  logLevel: "warning",
});

copyFileSync(`${root}neon/dist/index.mjs`, `${root}neon/insights/release/server.mjs`);
const sha = createHash("sha256").update(readFileSync(`${root}neon/insights/release/server.mjs`)).digest("hex");

rmSync(`${root}neon/dist/insights.zip`, { force: true });
run("zip", ["-9", "-j", "-q", "neon/dist/insights.zip", "neon/dist/index.mjs"]);
mkdirSync(`${root}neon/dist/loader`, { recursive: true });
copyFileSync(`${root}neon/insights/loader.mjs`, `${root}neon/dist/loader/index.mjs`);
rmSync(`${root}neon/dist/loader.zip`, { force: true });
run("zip", ["-9", "-j", "-q", "neon/dist/loader.zip", "neon/dist/loader/index.mjs"]);
console.log(`Built neon/insights/public, release/server.mjs (sha256 ${sha}) and neon/dist/*.zip`);
