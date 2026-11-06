"use client";

import type { ComponentType, SVGProps } from "react";
import type { IntegrationInfo } from "@/lib/analytics/types";
import { isEmbedded } from "./embedded-client";
import { clearApiCache } from "./seo-ui";
import { BarsIcon, BoltIcon, CloseIcon, FileIcon, HomeIcon, KeyIcon, ListIcon, PlugIcon, SearchIcon } from "./Icons";

export type NavItem = { id: string; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> };

/** Advanced view: every section of the dashboard. */
export const NAV_ADVANCED: NavItem[] = [
  { id: "overview", label: "Overview", icon: HomeIcon },
  { id: "analytics", label: "Google Analytics", icon: BarsIcon },
  { id: "search-console", label: "Search Console", icon: SearchIcon },
  { id: "pages", label: "Top Pages", icon: FileIcon },
  { id: "queries", label: "Search Queries", icon: ListIcon },
  { id: "autopilot", label: "SEO Autopilot", icon: BoltIcon },
  { id: "keywords", label: "SEO Tools", icon: KeyIcon },
  { id: "apps", label: "Connected Apps", icon: PlugIcon },
];

/** Simple view: six places, the home screen first. */
export const NAV_SIMPLE: NavItem[] = [
  { id: "home", label: "Dashboard", icon: HomeIcon },
  { id: "keywords", label: "Keywords", icon: KeyIcon },
  { id: "content", label: "Content", icon: FileIcon },
  { id: "backlinks", label: "Backlinks", icon: PlugIcon },
  { id: "report", label: "Report", icon: ListIcon },
  { id: "settings", label: "Settings", icon: BoltIcon },
];

export function Sidebar({ items = NAV_ADVANCED, active, onNavigate, integrations, open, onClose, email, company }: {
  items?: NavItem[];
  /** Who is signed in; with it the menu shows the account and a Sign out button. */
  email?: string | null;
  /** The business name; shown in place of the email when set. */
  company?: string | null;
  active: string;
  onNavigate: (id: string) => void;
  integrations: IntegrationInfo[];
  open: boolean;
  onClose: () => void;
}) {
  const upcoming = integrations.filter((i) => i.status === "coming_soon");
  const connected = integrations.filter((i) => i.status === "connected");

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={onClose} />}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col overflow-hidden bg-gradient-to-b from-[#0F5130] via-[#0C4428] to-[#0A3A22] text-white/90 transition-transform lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-6 pb-6 pt-7">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#4CC34A] text-lg font-extrabold text-[#0C4428]">D</span>
            <div>
              <p className="text-2xl font-bold leading-none text-white">DashPatrol</p>
              <p className="mt-1 text-xs text-white/70">SEO Growth Manager</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-white/70 hover:bg-white/10 lg:hidden" aria-label="Close menu">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3">
          {items.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-[16px] font-medium transition-colors ${
                active === id ? "bg-gradient-to-r from-[#4CC34A] to-[#6FD35A] text-white shadow-lg shadow-black/20" : "hover:bg-white/10 hover:text-white"
              }`}
            >
              <Icon className="h-5 w-5 shrink-0" />
              {label}
            </button>
          ))}

          {connected.length > 0 && (
            <div className="mt-6 border-t border-white/15 pt-5">
              <p className="px-3.5 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/80">Connected to</p>
              <div className="space-y-2">
                {connected.map((app) => (
                  <div key={app.id} className="flex items-center justify-between gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-white">
                    <span className="truncate">{app.name}</span>
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#4CC34A] text-[10px] font-bold text-[#0C4428]" aria-label="Connected">✓</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {upcoming.length > 0 && (
            <div className="mt-6 border-t border-white/10 pt-5">
              <p className="px-3.5 pb-2 text-[11px] uppercase tracking-[0.16em] text-white/45">Coming next</p>
              {upcoming.map((app) => (
                <div key={app.id} className="flex items-center justify-between px-3.5 py-2 text-sm text-white/60">
                  <span className="truncate">{app.name}</span>
                  <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide">Soon</span>
                </div>
              ))}
            </div>
          )}
        </nav>

        {/* Inside Shopify admin the sign in comes from Shopify itself, so there's nothing to sign out of here. */}
        {email && !isEmbedded() && (
          <div className="border-t border-white/10 px-6 py-4">
            <p className="text-[11px] uppercase tracking-[0.16em] text-white/45">Signed in as</p>
            <p className="truncate text-sm text-white" title={email}>{company || email}</p>
            <button
              onClick={async () => {
                clearApiCache();
                await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
                window.location.href = "/analytics";
              }}
              className="mt-2 text-sm font-semibold text-[#C6F432] hover:underline"
            >
              Sign out
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
