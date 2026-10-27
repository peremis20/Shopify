import type { ReactNode } from "react";
import type { Delta } from "@/lib/analytics/types";
import { ArrowDownIcon, ArrowUpIcon, ExternalIcon } from "./Icons";

export function Card({ id, className = "", children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <section
      id={id}
      className={`scroll-mt-24 rounded-2xl border border-dash-line bg-dash-card p-5 shadow-[0_1px_2px_rgba(40,32,20,0.04)] ${className}`}
    >
      {children}
    </section>
  );
}

export function CardHeader({ title, icon, href, linkLabel = "Open", children }: {
  title: string;
  icon?: ReactNode;
  href?: string;
  linkLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-2.5 font-serif text-xl text-dash-ink">
        {icon}
        {title}
      </h2>
      <div className="flex items-center gap-4">
        {children}
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-sm font-medium text-dash-green hover:underline"
          >
            {linkLabel}
            <ExternalIcon className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * Change vs. previous period. `lowerIsBetter` flips the colour for metrics
 * like average position, where a drop is good news.
 */
export function DeltaBadge({ delta, lowerIsBetter = false }: { delta: Delta; lowerIsBetter?: boolean }) {
  if (delta.change === null) {
    return <span className="text-sm text-dash-muted">No prior data</span>;
  }
  const up = delta.change >= 0;
  const good = lowerIsBetter ? !up : up;
  const Arrow = up ? ArrowUpIcon : ArrowDownIcon;
  return (
    <span className={`inline-flex items-center gap-1 text-sm font-semibold ${good ? "text-dash-up" : "text-dash-down"}`}>
      <Arrow className="h-3.5 w-3.5" strokeWidth={2.4} />
      {Math.abs(delta.change).toFixed(1)}%
    </span>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-[#EFE9DE] ${className}`} />;
}

export function SourceError({ message, source }: { message?: string; source: string }) {
  return (
    <div className="rounded-xl border border-dash-down/25 bg-dash-down/5 p-4 text-sm text-dash-ink">
      <p className="font-semibold text-dash-down">Couldn&apos;t load {source}</p>
      <p className="mt-1 break-words text-dash-muted">{message}</p>
      <p className="mt-2 text-dash-muted">
        Check that the service account email has access to this property and the ID in your settings is right.
      </p>
    </div>
  );
}

export function GaLogo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="15" y="2" width="6" height="20" rx="3" fill="#F9AB00" />
      <rect x="8.5" y="9" width="6" height="13" rx="3" fill="#E37400" />
      <circle cx="5" cy="19" r="3" fill="#E37400" />
    </svg>
  );
}

export function GscLogo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="7" fill="none" stroke="#4285F4" strokeWidth="2.6" />
      <path d="m16 16 5 5" stroke="#34A853" strokeWidth="2.8" strokeLinecap="round" />
      <path d="M7 12.5v-2M10.5 12.5v-5M14 12.5v-3" stroke="#EA4335" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
