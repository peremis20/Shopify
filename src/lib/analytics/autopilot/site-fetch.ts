import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { privateIp } from "./broken-links";

/**
 * Reads a page of the site itself, and nothing else. Used where the page's text goes to an AI (the Store audit), so a
 * redirect can never hand it another site's page:
 * - every hop (redirects are followed by hand, at most 3) must stay on the site's bare host, its www form or a
 *   subdomain of it, over http or https on the usual ports, never a raw IP address or a local name;
 * - every hop's name is resolved here, all its addresses must be public, and the request connects to exactly that
 *   address (DNS pinned), so the name can't point somewhere private between the check and the read;
 * - the body is read up to a cap, within a time limit.
 */

export const bareHost = (host: string) => host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

/** The site's bare host, its www form, or a subdomain of it. */
export function onSite(host: string, siteHost: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const s = bareHost(siteHost);
  return h === s || h.endsWith(`.${s}`);
}

export interface Addr {
  address: string;
  family: number;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface SiteFetchDeps {
  lookup: (host: string) => Promise<Addr[]>;
  request: (url: URL, addr: Addr, method: "GET" | "HEAD", timeoutMs: number, maxBytes: number) => Promise<RawResponse>;
}

export type SiteFetchResult = (RawResponse & { url: string }) | { refused: string };

const UA = "Mozilla/5.0 (compatible; DashPatrolStoreAudit/1.0)";

/** One request to one already checked address: the name is kept for TLS and the Host header. */
function pinnedRequest(url: URL, addr: Addr, method: "GET" | "HEAD", timeoutMs: number, maxBytes: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const pin: LookupFunction = (_host, opts, cb) => {
      // Node may ask for every address (happy eyeballs): it gets only the checked one.
      if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: Addr[]) => void)(null, [addr]);
      else cb(null, addr.address, addr.family);
    };
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8" },
        lookup: pin,
        servername: url.hostname,
        agent: false,
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
        };
        if (method === "HEAD" || (res.statusCode ?? 0) >= 300) {
          res.resume();
          res.on("end", done);
          res.on("error", done);
          return;
        }
        res.on("data", (c: Buffer) => {
          if (size >= maxBytes) return;
          chunks.push(c.subarray(0, maxBytes - size));
          size += c.length;
          // Enough read: stop downloading the rest.
          if (size >= maxBytes) {
            res.destroy();
            done();
          }
        });
        res.on("end", done);
        res.on("error", done);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("timed out")), timeoutMs);
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}

const DEFAULT_DEPS: SiteFetchDeps = {
  lookup: async (host) => (await dnsLookup(host, { all: true })).map((a) => ({ address: a.address, family: a.family })),
  request: pinnedRequest,
};

/** Reads `href` from the site at `siteHost` only. Refused (with a plain reason) when any hop leaves the site or isn't public. */
export async function siteFetch(
  href: string,
  siteHost: string,
  opts: { method?: "GET" | "HEAD"; timeoutMs?: number; maxBytes?: number } = {},
  deps: SiteFetchDeps = DEFAULT_DEPS,
): Promise<SiteFetchResult> {
  const method = opts.method ?? "GET";
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { refused: "Not a web address." };
  }
  for (let hop = 0; hop <= 3; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") return { refused: "Not a web page address." };
    if (url.port && url.port !== "80" && url.port !== "443") return { refused: "An unusual port was refused." };
    const host = url.hostname.toLowerCase();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":") || host.startsWith("[")) return { refused: "A raw IP address was refused." };
    if (!onSite(host, siteHost)) return { refused: `The page sent visitors to another site (${host}), which isn't read.` };
    const addrs = await deps.lookup(host).catch(() => [] as Addr[]);
    if (!addrs.length) return { refused: "The site's address couldn't be found." };
    if (addrs.some((a) => privateIp(a.address))) return { refused: "The site's address points to a private network, which isn't read." };
    const res = await deps.request(url, addrs[0], method, timeoutMs, maxBytes);
    const location = res.status >= 300 && res.status < 400 ? res.headers.location : null;
    if (!location) return { ...res, url: url.href };
    try {
      url = new URL(location, url);
    } catch {
      return { refused: "The page redirected to an unreadable address." };
    }
  }
  return { refused: "Too many redirects." };
}
