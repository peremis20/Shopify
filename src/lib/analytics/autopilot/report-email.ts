import crypto from "crypto";
import zlib from "zlib";
import type { WeeklyReportData } from "./alerts";

/**
 * The weekly report as an email people can read at a glance: number tiles, a donut of where visits came from, bars
 * for the week's work, a status line for the agents and spending meters. Email clients run no scripts and many drop
 * SVG, so everything is tables with inline styles, and the one chart is a PNG drawn here and served by the app itself
 * (never a third party chart service). The plain text version is always sent alongside.
 */

// The validated reference categorical palette (fixed order, never cycled), plus a neutral for "Other".
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"];
const OTHER = "#9a988f";
const INK = "#1f1d1a";
const MUTED = "#6b675f";
const LINE = "#e6e0d6";
const SURFACE = "#ffffff";
const PAGE = "#f7f3ec";
const BRAND = "#0f5a32";
const GOOD = "#0ca30c";
const CRITICAL = "#d03b3b";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (n: number) => Math.round(n).toLocaleString("en-US");

// ---------- the donut, drawn as a PNG ----------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const rgb = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/**
 * A donut of shares, drawn at the given size with 3x3 supersampling for smooth edges, slices in the given colors
 * with a thin white gap between them. White background so it reads the same in light and dark mail apps.
 */
export function donutPng(values: number[], colors: string[], size = 240): Buffer {
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  // Every source with visits keeps a visible sliver (at least 2% of the ring), so the legend never names a missing slice.
  const shares = values.map((v) => (v > 0 && total > 0 ? Math.max(v / total, 0.02) : 0));
  const sum = shares.reduce((a, b) => a + b, 0) || 1;
  const ends: number[] = [];
  let acc = 0;
  for (const sh of shares) ends.push((acc += sh) / sum);
  const c = size / 2;
  const outer = size / 2 - 2;
  const inner = outer * 0.58;
  const gap = values.filter((v) => v > 0).length > 1 ? 1.6 : 0; // pixels of white between slices
  const cols = colors.map(rgb);
  const raw = Buffer.alloc((size * 3 + 1) * size);
  const S = 3;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S - c;
          const py = y + (sy + 0.5) / S - c;
          const d = Math.hypot(px, py);
          let col = [255, 255, 255];
          if (total > 0 && d <= outer && d >= inner) {
            // Clockwise from twelve o'clock.
            const t = ((Math.atan2(px, -py) / (2 * Math.PI)) + 1) % 1;
            const i = ends.findIndex((e) => t <= e);
            const start = i > 0 ? ends[i - 1] : 0;
            // Distance to the nearest slice edge along the arc, in pixels.
            const edge = Math.min(t - start, ends[i] - t) * 2 * Math.PI * d;
            if (i >= 0 && edge >= gap / 2) col = cols[i] ?? cols[cols.length - 1];
          } else if (total === 0 && d <= outer && d >= inner) col = rgb(LINE);
          r += col[0];
          g += col[1];
          b += col[2];
        }
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(r / (S * S));
      raw[o + 1] = Math.round(g / (S * S));
      raw[o + 2] = Math.round(b / (S * S));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- the chart's signed address ----------

const chartKey = () => {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set on the server.");
  return crypto.createHmac("sha256", secret).update("report-chart").digest();
};

/** The chart's address: the shares and colors in the link itself, signed so nobody can make the app draw anything else. */
export function chartUrl(origin: string, values: number[], colors: string[]): string {
  const d = Buffer.from(JSON.stringify({ v: values.map((v) => Math.max(0, Math.round(v))), c: colors })).toString("base64url");
  const s = crypto.createHmac("sha256", chartKey()).update(d).digest("base64url").slice(0, 32);
  return `${origin}/api/report/chart.png?d=${d}&s=${s}`;
}

/** The PNG for a signed chart address, or null when the signature or data isn't right. */
export function chartFromUrl(d: string | null, s: string | null): Buffer | null {
  if (!d || !s || d.length > 600) return null;
  const expected = crypto.createHmac("sha256", chartKey()).update(d).digest("base64url").slice(0, 32);
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { v, c } = JSON.parse(Buffer.from(d, "base64url").toString("utf8")) as { v: unknown; c: unknown };
    if (!Array.isArray(v) || !Array.isArray(c) || v.length !== c.length || v.length > 8) return null;
    if (!v.every((x) => Number.isFinite(x)) || !c.every((x) => typeof x === "string" && /^#[0-9a-f]{6}$/i.test(x))) return null;
    return donutPng(v as number[], c as string[]);
  } catch {
    return null;
  }
}

// ---------- the email ----------

export interface ReportExtras {
  site: string;
  origin: string;
  usage: { ai: number; search: number; limits: { ai: number; search: number } } | null;
  /** Problems on the owner's list that need a person; null when the last check couldn't be read. */
  needsYou: number | null;
}

const pct = (now: number, before: number): { text: string; up: boolean } | null =>
  before > 0 ? { text: `${Math.abs(Math.round(((now - before) / before) * 100))}%`, up: now >= before } : null;

function tile(label: string, value: string, delta: { text: string; up: boolean } | null, note?: string): string {
  const arrow = delta ? `<div style="font-size:13px;color:${MUTED};margin-top:4px">${delta.up ? "&#9650;" : "&#9660;"} ${delta.up ? "up" : "down"} ${delta.text} from last week</div>` : note ? `<div style="font-size:13px;color:${MUTED};margin-top:4px">${esc(note)}</div>` : "";
  return `<td valign="top" style="width:33%;padding:6px"><div style="background:${SURFACE};border:1px solid ${LINE};border-radius:12px;padding:14px">
<div style="font-size:13px;color:${MUTED}">${esc(label)}</div>
<div style="font-size:28px;font-weight:700;color:${INK};line-height:1.2">${esc(value)}</div>${arrow}</div></td>`;
}

/**
 * Sales: the store's own orders when Shopify can be read (Analytics often never receives purchases), else the
 * purchase revenue Analytics recorded. Free orders such as samples are counted and named apart.
 */
function salesTile(d: WeeklyReportData, gaRevenue: number, gaBefore: number): string {
  const s = d.shopify;
  if (s && typeof s === "object" && s.week && s.weekBefore) {
    const w = s.week;
    const paid = w.orders - w.free;
    const amount = w.revenue > 0 ? w.revenue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0";
    const value = !s.currency || s.currency === "USD" ? `$${amount}` : `${amount} ${s.currency}`;
    const parts = [`${paid} paid order${paid === 1 ? "" : "s"}`];
    if (w.free) parts.push(`${w.free} free sample${w.free === 1 ? "" : "s"}`);
    const note = w.orders === 0 ? "No orders this week" : parts.join(", ");
    const delta = pct(w.revenue, s.weekBefore.revenue);
    return tile("Sales from Shopify", value, null, delta ? `${note}. ${delta.up ? "Up" : "Down"} ${delta.text} from last week` : note);
  }
  return tile("Sales", gaRevenue > 0 ? num(gaRevenue) : "0", pct(gaRevenue, gaBefore), gaRevenue === 0 ? "None recorded yet" : undefined);
}

/** A labeled bar: the bar is drawn as a table cell whose width is the share of the row's largest value. */
function barRow(label: string, value: number, max: number, color: string): string {
  const w = max > 0 ? Math.max(value > 0 ? 3 : 0, Math.round((value / max) * 100)) : 0;
  return `<tr><td style="padding:4px 8px 4px 0;font-size:14px;color:${INK};white-space:nowrap;width:40%">${esc(label)}</td>
<td style="padding:4px 0"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
${w > 0 ? `<td width="${w}%" style="background:${color};height:12px;border-radius:0 4px 4px 0;font-size:0;line-height:0">&nbsp;</td>` : ""}
<td style="padding-left:8px;font-size:14px;color:${INK};white-space:nowrap">${num(value)}</td>${w < 100 ? `<td width="${100 - w}%"></td>` : ""}</tr></table></td></tr>`;
}

function meter(label: string, used: number, limit: number): string {
  const share = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return `<div style="margin:8px 0"><div style="font-size:13px;color:${INK}">${esc(label)}: ${num(used)} of ${num(limit)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:4px"><tr>
${share > 0 ? `<td width="${share}%" style="background:${BRAND};height:8px;font-size:0;line-height:0">&nbsp;</td>` : ""}${share < 100 ? `<td style="background:${LINE};height:8px;font-size:0;line-height:0">&nbsp;</td>` : ""}</tr></table></div>`;
}

const section = (title: string, body: string) =>
  `<tr><td style="padding:10px 16px"><div style="background:${SURFACE};border:1px solid ${LINE};border-radius:12px;padding:16px">
<div style="font-size:16px;font-weight:700;color:${INK};margin-bottom:10px">${esc(title)}</div>${body}</div></td></tr>`;

/** The weekly report as HTML: the same numbers as the text version, from the same data, nothing estimated. */
export function weeklyReportHtml(d: WeeklyReportData, x: ReportExtras): string {
  const parts: string[] = [];
  // Number tiles: visits, leads and sales from Google Analytics, with the change from last week.
  if (Array.isArray(d.traffic)) {
    const t = d.totals ?? { visits: 0, leads: 0, revenue: 0 };
    const b = d.totalsBefore ?? {
      visits: d.traffic.reduce((n, c) => n + c.before.sessions, 0),
      leads: d.traffic.reduce((n, c) => n + c.before.keyEvents, 0),
      revenue: d.traffic.reduce((n, c) => n + c.before.revenue, 0),
    };
    const [visitsBefore, leadsBefore, salesBefore] = [b.visits, b.leads, b.revenue];
    parts.push(`<tr><td style="padding:6px 10px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
${tile("Visits, last 7 days", num(t.visits), pct(t.visits, visitsBefore), visitsBefore === 0 && t.visits > 0 ? "None the week before" : undefined)}
${tile("Leads and sign ups", num(t.leads), pct(t.leads, leadsBefore), t.leads === 0 ? "None recorded yet" : undefined)}
${salesTile(d, t.revenue, salesBefore)}
</tr></table></td></tr>`);
    // Where visits came from: a donut with a legend that names every slice (identity is never color alone).
    const shown = d.traffic.filter((c) => c.now.sessions > 0);
    if (shown.length) {
      const top = shown.slice(0, SERIES.length);
      // Everything not named gets one "Other" slice, counted from the full total so the chart adds up to the tile.
      const named = top.reduce((n, c) => n + c.now.sessions, 0);
      const rest = Math.max(0, Math.max(t.visits, named) - named);
      const values = [...top.map((c) => c.now.sessions), ...(rest > 0 ? [rest] : [])];
      const colors = [...top.map((_, i) => SERIES[i]), ...(rest > 0 ? [OTHER] : [])];
      const names = [...top.map((c) => c.name), ...(rest > 0 ? ["Other"] : [])];
      const total = values.reduce((a, b) => a + b, 0);
      let img = "";
      try {
        img = `<img src="${esc(chartUrl(x.origin, values, colors))}" width="160" height="160" alt="Visits by source" style="display:block;border:0">`;
      } catch {
        img = ""; // without the signing secret the legend alone still tells the story
      }
      const legend = names
        .map((n, i) => `<tr><td style="padding:3px 8px 3px 0;width:12px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="10" height="10" bgcolor="${colors[i]}" style="width:10px;height:10px;background:${colors[i]};font-size:0;line-height:0">&nbsp;</td></tr></table></td>
<td style="padding:3px 0;font-size:14px;color:${INK}">${esc(n)}</td><td style="padding:3px 0 3px 12px;font-size:14px;color:${INK};text-align:right;white-space:nowrap">${num(values[i])} (${Math.round((values[i] / total) * 100)}%)</td></tr>`)
        .join("");
      parts.push(section("Where your visits came from", `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
${img ? `<td valign="middle" style="width:172px;padding-right:12px">${img}</td>` : ""}
<td valign="middle"><table role="presentation" cellpadding="0" cellspacing="0" width="100%">${legend}</table></td></tr></table>
<div style="font-size:12px;color:${MUTED};margin-top:10px">From your Google Analytics. A rise after a change is a good sign, not proof the change caused it.</div>`));
    }
  } else {
    parts.push(section("Visits, leads and sales", `<div style="font-size:14px;color:${INK}">${d.traffic === "none" ? "Connect Google Analytics in Settings to see them here." : "Google Analytics couldn't be read this week, so they are left out rather than guessed."}</div>`));
  }
  // The week's work.
  const work = [
    ["Page improvements", d.week.changes],
    ["New articles", d.week.articles],
    ["Links between your pages", d.week.links],
  ] as const;
  const maxWork = Math.max(...work.map(([, v]) => v), 1);
  // The fix list is what waits for the owner now, whenever it was suggested, so it sits under the week's work, not in it.
  const waiting = d.week.suggested ? `<div style="font-size:14px;color:${INK};margin-top:10px">${d.week.suggested} ${d.week.suggested === 1 ? "change is" : "changes are"} waiting on your fix list.</div>` : "";
  parts.push(section("What the agents did in the last 7 days", `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">${work.map(([l, v]) => barRow(l, v, maxWork, BRAND)).join("")}</table>${waiting}`));
  // Agents: one clear status line, then each agent's own record.
  const status = x.needsYou === null
    ? ""
    : x.needsYou === 0
      ? `<div style="font-size:14px;color:${INK};margin-bottom:8px"><span style="color:${GOOD}">&#9679;</span> All agents are working. Nothing needs you.</div>`
      : `<div style="font-size:14px;color:${INK};margin-bottom:8px"><span style="color:${CRITICAL}">&#9679;</span> ${x.needsYou} ${x.needsYou === 1 ? "thing needs" : "things need"} you. Open DashPatrol to see what.</div>`;
  const agents = d.agents
    .filter((a) => a.agent !== "Spending this month")
    .map((a) => `<div style="font-size:14px;color:${INK};padding:4px 0;border-top:1px solid ${LINE}"><strong>${esc(a.agent)}:</strong> ${esc(a.did)}.${a.result ? ` <span style="color:${MUTED}">${esc(a.result)}</span>` : ""}</div>`)
    .join("");
  if (status || agents) parts.push(section("Your agents", status + agents));
  // The team board: what waits on the owner, and what the agents did and found together this week.
  const row = (t: string) => `<div style="font-size:14px;color:${INK};padding:4px 0;border-top:1px solid ${LINE}">${esc(t)}</div>`;
  if (d.team?.needs.length) parts.push(section("Waiting on you", d.team.needs.map(row).join("")));
  if (d.team?.did.length) parts.push(section("From the team board", d.team.did.map(row).join("")));
  if (d.plan.length) parts.push(section("This week's plan", `<ol style="margin:0;padding-left:20px;font-size:14px;color:${INK}">${d.plan.map((p) => `<li style="margin:4px 0">${esc(p)}</li>`).join("")}</ol>`));
  if (x.usage) parts.push(section("Spending this month", `${meter("AI requests", x.usage.ai, x.usage.limits.ai)}${meter("Google results lookups", x.usage.search, x.usage.limits.search)}<div style="font-size:12px;color:${MUTED}">Counted from the first of the month; cached lookups are free.</div>`));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Your DashPatrol week</title></head>
<body style="margin:0;padding:0;background:${PAGE};font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${PAGE}"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px">
<tr><td style="padding:10px 16px"><div style="font-size:22px;font-weight:800;color:${BRAND}">Your DashPatrol week</div><div style="font-size:14px;color:${MUTED}">${esc(x.site)}</div></td></tr>
${parts.join("\n")}
<tr><td style="padding:10px 16px 24px;font-size:12px;color:${MUTED}">You can turn these emails off in Autopilot settings.</td></tr>
</table></td></tr></table></body></html>`;
}
