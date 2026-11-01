"use client";

import { useEffect, useState } from "react";
import type { Prospect, ProspectList, ProspectStatus } from "@/lib/analytics/autopilot/backlinks";
import type { AuthorityPlan } from "@/lib/analytics/autopilot/authority-coach";
import { api } from "./seo-ui";
import { Skeleton } from "./ui";

const KIND: Record<Prospect["kind"], { label: string; hint: string }> = {
  mention: { label: "Mentions you", hint: "Already names your brand. Ask them to add a link." },
  resource: { label: "Resource page", hint: "Lists helpful links on your topic. Suggest your page." },
  guest: { label: "Guest article", hint: "Takes articles from other sites. Offer one with a link back." },
  podcast: { label: "Podcast", hint: "A show on your topic that invites guests. Offer to be on it." },
  roundup: { label: "Expert roundup", hint: "Collects expert answers on your topic. Offer one." },
  competitor: { label: "Mentions a competitor", hint: "Mentions a site that beats you on Google. Offer your page as another good resource." },
  broken: { label: "Broken link", hint: "Has a dead link you can replace with your page. A helpful favor, and a strong way to earn a link." },
};

const STATUS: { id: ProspectStatus | "open"; label: string }[] = [
  { id: "open", label: "To do" },
  { id: "contacted", label: "Emailed" },
  { id: "won", label: "Got the link" },
  { id: "skip", label: "Skipped" },
];

/** Websites that could link to this site, found on Google weekly, with an email to send each one. */
export function Backlinks() {
  const [list, setList] = useState<ProspectList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ProspectStatus | "open">("open");

  async function load(body?: unknown) {
    setLoading(true);
    try {
      const data = await api<{ list: ProspectList | null; error?: string }>("/api/seo/backlinks", body);
      setList(data.list);
      setError(data.error ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }
  const [plan, setPlan] = useState<AuthorityPlan | null>(null);
  useEffect(() => {
    load();
    api<{ plan: AuthorityPlan | null }>("/api/seo/authority-plan").then((d) => setPlan(d.plan)).catch(() => setPlan(null));
  }, []);

  async function mark(url: string, status: ProspectStatus) {
    setList((cur) => (cur ? { ...cur, prospects: cur.prospects.map((p) => (p.url === url ? { ...p, status } : p)) } : cur));
    await api("/api/seo/backlinks", { url, status }).catch(() => undefined);
  }

  if (loading && !list) return <Skeleton className="h-40" />;
  const all = list?.prospects ?? [];
  const shown = all.filter((p) => (view === "open" ? p.status === "new" : p.status === view));
  const won = all.filter((p) => p.status === "won").length;

  return (
    <div>
      {plan && <AuthorityPlanCard plan={plan} />}
      <p className="mb-3 text-sm text-dash-muted">
        Links from other websites tell Google your site is trusted. Each week the app looks on Google for real sites on your topics that could link to you, and writes an email for each one. You send it from your own email, so it comes from a real person. Nothing is sent for you.
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg bg-[#F1ECE3] p-0.5 text-xs font-medium">
          {STATUS.map((s) => {
            const n = all.filter((p) => (s.id === "open" ? p.status === "new" : p.status === s.id)).length;
            return (
              <button key={s.id} onClick={() => setView(s.id)} className={`rounded-md px-2.5 py-1 ${view === s.id ? "bg-white text-dash-ink shadow-sm" : "text-dash-muted"}`}>
                {s.label} {n > 0 && <span className="tabular-nums">({n})</span>}
              </button>
            );
          })}
        </div>
        {won > 0 && <span className="text-sm text-dash-up">{won} {won === 1 ? "link" : "links"} won</span>}
        <button onClick={() => load({ refresh: true })} disabled={loading} className="text-xs font-semibold text-dash-green hover:underline disabled:opacity-50">
          {loading ? "Looking on Google..." : "Find more now"}
        </button>
        {list && <span className="text-xs text-dash-muted">Last checked {new Date(list.updatedAt).toLocaleDateString()}</span>}
      </div>
      {error && <p className="mb-3 text-sm text-dash-down">{error}</p>}
      {shown.length === 0 ? (
        <p className="py-6 text-center text-sm text-dash-muted">{view === "open" ? "Nothing to do here right now. New sites are added each week." : "None yet."}</p>
      ) : (
        <ul className="divide-y divide-dash-line/70">
          {shown.map((p) => (
            <ProspectRow key={p.url} p={p} onMark={mark} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProspectRow({ p, onMark }: { p: Prospect; onMark: (url: string, s: ProspectStatus) => void }) {
  const [email, setEmail] = useState<{ subject: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function write() {
    setBusy(true);
    setErr(null);
    try {
      setEmail(await api<{ subject: string; body: string }>("/api/seo/backlinks/email", { url: p.url }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't write the email");
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    if (!email) return;
    await navigator.clipboard.writeText(`Subject: ${email.subject}\n\n${email.body}`).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <li className="py-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <a href={p.url} target="_blank" rel="noreferrer" className="min-w-0 break-words font-medium text-dash-ink hover:underline">
          {p.title || p.domain}
        </a>
        <span className="text-xs text-dash-muted">{p.domain}</span>
        <span className="rounded-full bg-[#F1ECE3] px-2 py-0.5 text-xs text-dash-ink" title={KIND[p.kind].hint}>{KIND[p.kind].label}</span>
        <span className="text-xs tabular-nums text-dash-muted" title="Site strength (Open PageRank)">{p.authority === null ? "not scored" : `${p.authority.toFixed(1)} / 10`}</span>
      </div>
      <p className="mt-1 whitespace-normal break-words text-xs text-dash-muted">{KIND[p.kind].hint} {p.snippet}</p>
      {p.brokenLink && (
        <p className="mt-1 whitespace-normal break-words text-xs text-dash-ink">
          Dead link on their page: &ldquo;{p.anchor}&rdquo; (<span className="text-dash-muted">{p.brokenLink}</span>)
          {p.ourPage && <> &middot; offer your page {(() => { try { return new URL(p.ourPage).pathname; } catch { return p.ourPage; } })()}</>}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {p.status === "new" && (
          <button onClick={write} disabled={busy} className="rounded-full bg-dash-green px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">
            {busy ? "Writing..." : email ? "Write another" : "Write the email"}
          </button>
        )}
        {p.status !== "contacted" && p.status !== "won" && <button onClick={() => onMark(p.url, "contacted")} className="rounded-full border border-dash-line px-3 py-1 text-xs font-semibold text-dash-ink">I emailed them</button>}
        {p.status !== "won" && <button onClick={() => onMark(p.url, "won")} className="rounded-full border border-dash-line px-3 py-1 text-xs font-semibold text-dash-up">Got the link</button>}
        {p.status !== "skip" && <button onClick={() => onMark(p.url, "skip")} className="rounded-full px-3 py-1 text-xs text-dash-muted hover:underline">Skip</button>}
        {p.status === "skip" && <button onClick={() => onMark(p.url, "new")} className="rounded-full px-3 py-1 text-xs text-dash-muted hover:underline">Bring back</button>}
      </div>
      {err && <p className="mt-2 text-xs text-dash-down">{err}</p>}
      {email && (
        <div className="mt-3 rounded-lg border border-dash-line bg-[#FBF8F2] p-3">
          <p className="text-xs font-semibold text-dash-ink">Subject: {email.subject}</p>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-dash-ink">{email.body}</p>
          <div className="mt-2 flex gap-3">
            <button onClick={copy} className="text-xs font-semibold text-dash-green hover:underline">{copied ? "Copied" : "Copy email"}</button>
            <span className="text-xs text-dash-muted">Find their email on their contact page, then send it from yours.</span>
          </div>
        </div>
      )}
    </li>
  );
}

/** The Authority Coach's weekly plan: where authority stands and the moves that survived the second AI's review. */
function AuthorityPlanCard({ plan }: { plan: AuthorityPlan }) {
  const kept = plan.moves.filter((m) => m.kept);
  return (
    <div className="mb-4 rounded-xl border border-dash-line bg-[#FBF8F2] px-4 py-3">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-dash-muted">This week&apos;s authority plan</p>
        <span className="text-[11px] text-dash-muted">{new Date(plan.at).toLocaleDateString()} · {plan.checked === false ? "not yet checked by a second AI" : "checked by a second AI"}</span>
      </div>
      <p className="text-sm text-dash-ink">{plan.assessment}</p>
      {kept.length > 0 && (
        <ol className="mt-2 space-y-1.5">
          {kept.map((m, i) => (
            <li key={i} className="flex gap-2 text-sm">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-dash-green text-xs font-semibold text-white">{i + 1}</span>
              <span className="min-w-0">
                <span className="text-dash-ink">{m.action}</span>
                <span className="block text-xs text-dash-muted">{m.why}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {plan.studied.length > 0 && (
        <p className="mt-2 text-xs text-dash-muted">
          Learned from competitors: {plan.studied.map((s) => `${s.domain} (${s.found} ${s.found === 1 ? "site" : "sites"} to reach out to)`).join(", ")}.
        </p>
      )}
    </div>
  );
}
