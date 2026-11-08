"use client";

import { Component, type ReactNode } from "react";

/**
 * Catches what stops the app working in a real browser and reports it, so the App checker and the code repair agent
 * see it: script errors, failed promises, failed app requests, a page wider than the screen (a layout or CSS bug),
 * and a crash while drawing a page. Only the app's own problems are sent: no page content, no personal data.
 */

const sent = new Set<string>();
let budget = 10;

export function reportClientError(kind: string, message: string): void {
  try {
    const where = `${location.pathname}${location.hash}`.slice(0, 120);
    const key = `${kind}|${message.slice(0, 200)}|${where}`;
    if (sent.has(key) || budget <= 0) return;
    sent.add(key);
    budget--;
    const body = JSON.stringify({ kind, message: message.slice(0, 500), where, width: window.innerWidth });
    // The original fetch, so a failing report can't report itself.
    void original?.("/api/client-errors", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true, credentials: "same-origin" }).catch(() => undefined);
  } catch {
    // Reporting must never break the page.
  }
}

let original: typeof fetch | null = null;

export function installErrorReporter(): void {
  if (typeof window === "undefined" || original) return;
  original = window.fetch.bind(window);
  window.addEventListener("error", (e) => reportClientError("script", `${e.message}${e.filename ? ` at ${e.filename.split("/").pop()}:${e.lineno}` : ""}`));
  window.addEventListener("unhandledrejection", (e) => reportClientError("promise", String((e.reason as Error)?.message ?? e.reason)));
  const wrapped = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const own = url.startsWith("/api/") && !url.startsWith("/api/client-errors");
    try {
      const res = await wrapped(input, init);
      if (own && res.status >= 500) reportClientError("request", `${url.split("?")[0]} answered ${res.status}`);
      return res;
    } catch (err) {
      if (own && (err as Error)?.name !== "AbortError") reportClientError("request", `${url.split("?")[0]} failed: ${(err as Error)?.message ?? err}`);
      throw err;
    }
  };
  // A page wider than the screen means something overflows: a layout or CSS bug.
  const checkWidth = () => {
    const over = document.documentElement.scrollWidth - window.innerWidth;
    if (over > 4) {
      const wide = [...document.querySelectorAll<HTMLElement>("body *")].find((el) => el.getBoundingClientRect().right > window.innerWidth + 4 && el.children.length === 0);
      reportClientError("layout", `The page is ${over}px wider than a ${window.innerWidth}px screen${wide ? `; it overflows at <${wide.tagName.toLowerCase()} class="${String(wide.className).slice(0, 80)}">` : ""}`);
    }
  };
  window.addEventListener("load", () => setTimeout(checkWidth, 3000));
  window.addEventListener("hashchange", () => setTimeout(checkWidth, 3000));
}

/** Shows a short message instead of a blank page when drawing a page crashes, and reports it. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportClientError("render", `${error.message}${info.componentStack ? ` in ${info.componentStack.trim().split("\n")[0].trim()}` : ""}`);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
        <p>Something on this page didn&apos;t load. It was reported and is being fixed.</p>
        <button onClick={() => location.reload()} style={{ marginTop: 12, textDecoration: "underline" }}>
          Try again
        </button>
      </div>
    );
  }
}
