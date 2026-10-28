// Builds the Insights dashboard for Neon Functions:
//   neon/insights/public/app.js + app.css   page assets (commit these; served from a CDN)
//   neon/dist/insights.zip                  the function bundle to deploy
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

mkdirSync(`${root}neon/insights/public`, { recursive: true });
mkdirSync(`${root}neon/dist`, { recursive: true });

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

// Neon Functions run ESM on Node 24; the banner restores require/__dirname for bundled CommonJS.
await build({
  entryPoints: [`${root}neon/insights/index.ts`],
  bundle: true,
  minify: true,
  platform: "node",
  target: "node24",
  format: "esm",
  tsconfig: `${root}tsconfig.json`,
  banner: {
    js: "import{createRequire as ___cr}from'module';import{fileURLToPath as ___f}from'url';import{dirname as ___d}from'path';const require=___cr(import.meta.url);const __filename=___f(import.meta.url);const __dirname=___d(__filename);",
  },
  outfile: `${root}neon/dist/index.mjs`,
  logLevel: "warning",
});

rmSync(`${root}neon/dist/insights.zip`, { force: true });
run("zip", ["-9", "-j", "-q", "neon/dist/insights.zip", "neon/dist/index.mjs"]);
console.log("Built neon/insights/public and neon/dist/insights.zip");
