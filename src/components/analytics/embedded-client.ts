"use client";

/**
 * Running inside Shopify admin: Shopify loads the app in an iframe with a
 * `host` parameter and App Bridge (window.shopify) issues session tokens.
 * Every call to the app's own API carries one, since cookies don't work in
 * the iframe. Pages that must leave the iframe (Google sign in) open at the
 * top level and come back into Shopify admin afterwards.
 */

declare global {
  interface Window {
    shopify?: { idToken: () => Promise<string> };
  }
}

export const isEmbedded = () =>
  typeof window !== "undefined" && (Boolean(window.shopify) || new URLSearchParams(window.location.search).has("host"));

/** Adds the Shopify session token to requests for the app's own API. */
export function installEmbeddedFetch() {
  if (!isEmbedded() || !window.shopify) return;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const own = url.startsWith("/") || url.startsWith(window.location.origin);
    if (!own || !window.shopify) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${await window.shopify.idToken()}`);
    return original(input, { ...init, headers });
  };
}

/** Starts Google sign in from inside Shopify admin, at the top level (Google won't load in an iframe). */
export async function connectGoogleEmbedded() {
  const res = await fetch("/api/auth/google/link");
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.url) throw new Error(body.error ?? "Couldn't start Google sign in.");
  window.open(body.url, "_top");
}
