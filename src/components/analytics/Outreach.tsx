"use client";

import { useEffect, useState } from "react";
import type { Journalist, JournalistStatus, MediaRequest, PaidOpportunity } from "@/lib/analytics/autopilot/press";
import { api } from "./seo-ui";
import { Card, CardHeader } from "./ui";

interface View {
  journalists: Journalist[];
  topics: string[];
  paid: PaidOpportunity[];
  paidNote: string;
  requests: MediaRequest[];
  requestsNote: string | null;
  platforms: { name: string; host: string; url: string }[];
  draftsLeft: number;
  cap: number;
  lastRun: { press: string | null; requests: string | null };
}

const STATUS_LABEL: Record<Exclude<JournalistStatus, "dismissed">, string> = { new: "New", pitched: "Pitched", replied: "Replied", covered: "Covered" };
const btn = "rounded-lg border border-dash-line px-3 py-1.5 text-xs font-semibold text-dash-ink hover:border-dash-green disabled:opacity-60";
const primary = "rounded-lg bg-dash-green px-3 py-1.5 text-xs font-semibold text-white hover:bg-dash-deep disabled:opacity-60";

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={btn}
      onClick={() =>
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
          .catch(() => undefined)
      }
    >
      {done ? "Copied" : label}
    </button>
  );
}

/** Runs one action and shows its error under the card. */
function useAct(onView: (v: View) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (key: string, body: Record<string, string>) => {
    setBusy(key);
    setError(null);
    try {
      onView(await api<View>("/api/outreach", body));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't do that. Try again.");
    }
    setBusy(null);
  };
  return { busy, error, act };
}

function JournalistCard({ j, onView }: { j: Journalist; onView: (v: View) => void }) {
  const { busy, error, act } = useAct(onView);
  const date = j.date && /^\d{4}-\d{2}-\d{2}$/.test(j.date) ? new Date(`${j.date}T12:00:00Z`).toLocaleDateString() : j.date;
  return (
    <div className="rounded-xl border border-dash-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-dash-ink">
            {j.name} <span className="font-normal text-dash-muted">at {j.outlet}</span>
          </p>
          <a href={j.articleUrl} target="_blank" rel="noreferrer" className="block break-words text-sm text-dash-green hover:underline [overflow-wrap:anywhere]">
            {j.articleTitle}
          </a>
          <p className="text-xs text-dash-muted">
            {date ? `${date} · ` : ""}About {j.topic}
          </p>
        </div>
        <select
          aria-label="Status"
          value={j.status}
          disabled={busy !== null}
          onChange={(e) => act("status", { action: "status", id: j.id, status: e.target.value })}
          className="rounded-lg border border-dash-line bg-white px-2 py-1 text-xs text-dash-ink"
        >
          {Object.entries(STATUS_LABEL).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-2 text-xs text-dash-muted break-words [overflow-wrap:anywhere]">
        {j.email ? `${j.emailIsOutlets ? "The outlet's published email" : "Email printed on the article"}: ${j.email}` : null}
        {j.email && j.contactPage ? " · " : null}
        {j.contactPage ? (
          <a href={j.contactPage} target="_blank" rel="noreferrer" className="text-dash-green hover:underline">
            Their page on {j.outlet}
          </a>
        ) : null}
        {!j.email && !j.contactPage ? "No contact is printed on the article. Look for them on the outlet's site before you write." : null}
      </p>
      {j.pitch ? (
        <>
          <p className="mt-3 text-sm font-semibold text-dash-ink">{j.pitch.subject}</p>
          <p className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-dash-bg p-3 text-sm text-dash-ink [overflow-wrap:anywhere]">{j.pitch.body}</p>
          <p className="mt-1 text-xs text-dash-muted">Checked by a second AI. Send it yourself, then set the status to Pitched. DashPatrol never sends it.</p>
        </>
      ) : (
        j.pitchNote && <p className="mt-2 text-xs text-dash-muted">{j.pitchNote}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {!j.pitch && (
          <button className={primary} disabled={busy !== null} onClick={() => act("pitch", { action: "pitch", id: j.id })}>
            {busy === "pitch" ? "Writing" : "Draft pitch"}
          </button>
        )}
        {j.pitch && <Copy text={`${j.pitch.subject}\n\n${j.pitch.body}`} />}
        <button className={btn} disabled={busy !== null} onClick={() => act("status", { action: "status", id: j.id, status: "dismissed" })}>
          Dismiss
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-dash-down">{error}</p>}
    </div>
  );
}

function RequestCard({ r, onView }: { r: MediaRequest; onView: (v: View) => void }) {
  const { busy, error, act } = useAct(onView);
  return (
    <div className="rounded-xl border border-dash-line p-4">
      <a href={r.url} target="_blank" rel="noreferrer" className="block break-words font-semibold text-dash-green hover:underline [overflow-wrap:anywhere]">
        {r.title}
      </a>
      <p className="text-xs text-dash-muted">
        {r.platform}
        {r.deadline ? ` · Deadline ${r.deadline}` : ""}
      </p>
      {r.snippet && <p className="mt-1 break-words text-sm text-dash-ink [overflow-wrap:anywhere]">{r.snippet}</p>}
      {r.answer ? (
        <>
          <p className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-dash-bg p-3 text-sm text-dash-ink [overflow-wrap:anywhere]">{r.answer.text}</p>
          <p className="mt-1 break-words text-xs text-dash-muted">From your page {r.answer.page}. Checked by a second AI. Submit it yourself on their site.</p>
        </>
      ) : (
        r.answerNote && <p className="mt-2 text-xs text-dash-muted">{r.answerNote}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {!r.answer && (
          <button className={primary} disabled={busy !== null} onClick={() => act("answer", { action: "answer", url: r.url })}>
            {busy === "answer" ? "Writing" : "Draft an answer"}
          </button>
        )}
        {r.answer && <Copy text={r.answer.text} />}
        <button className={btn} disabled={busy !== null} onClick={() => act("dismiss", { action: "dismiss-request", url: r.url })}>
          Dismiss
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-dash-down">{error}</p>}
    </div>
  );
}

function PaidCard({ p, onView }: { p: PaidOpportunity; onView: (v: View) => void }) {
  const { busy, act } = useAct(onView);
  return (
    <div className="rounded-xl border border-dash-line p-4">
      <p className="font-semibold text-dash-ink break-words [overflow-wrap:anywhere]">{p.outlet}</p>
      <p className="text-xs text-dash-muted">
        {p.type[0].toUpperCase() + p.type.slice(1)} · {p.price ? `Price on their page: ${p.price}` : "No price on their page"}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <a href={p.url} target="_blank" rel="noreferrer" className={btn}>
          See their advertising page
        </a>
        <button className={btn} disabled={busy !== null} onClick={() => act("dismiss", { action: "dismiss-paid", url: p.url })}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * The Outreach tab's own sections: journalists to pitch, media requests to answer, and paid opportunities. Every
 * message is sent by the owner; nothing is bought without the owner.
 */
export function Outreach() {
  const [view, setView] = useState<View | null>(null);
  useEffect(() => {
    api<View>("/api/outreach").then(setView).catch(() => setView(null));
  }, []);
  if (!view) return null;
  return (
    <>
      <Card className="mt-6">
        <CardHeader title="Journalists" />
        <p className="mb-3 text-xs text-dash-muted">
          Reporters and writers who recently wrote about {view.topics.length ? view.topics.join(", ") : "your topics"}, with the name and outlet as printed on their
          article. Each pitch offers them something useful. Send it yourself; at most {view.cap} new drafts a week ({view.draftsLeft} left).
        </p>
        {view.journalists.length ? (
          <div className="space-y-3">
            {view.journalists.map((j) => (
              <JournalistCard key={j.id} j={j} onView={setView} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-dash-muted">{view.lastRun.press ?? "The first search for journalists runs within the week."}</p>
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader title="Media requests" />
        <p className="mb-3 text-xs text-dash-muted">Public requests where journalists ask for sources on your topics. Answer before the deadline, on their site.</p>
        {view.requests.length > 0 && (
          <div className="space-y-3">
            {view.requests.map((r) => (
              <RequestCard key={r.url} r={r} onView={setView} />
            ))}
          </div>
        )}
        {view.requestsNote && (
          <div className="text-sm text-dash-ink">
            <p>{view.requestsNote}</p>
            <ul className="mt-2 list-inside list-disc">
              {view.platforms.map((p) => (
                <li key={p.host}>
                  <a href={p.url} target="_blank" rel="noreferrer" className="text-dash-green hover:underline">
                    {p.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader title="Paid opportunities" />
        <p className="mb-3 rounded-lg bg-dash-bg p-2 text-xs text-dash-ink">{view.paidNote}</p>
        {view.paid.length ? (
          <div className="space-y-3">
            {view.paid.map((p) => (
              <PaidCard key={p.url} p={p} onView={setView} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-dash-muted">No paid placements on your topics were found yet.</p>
        )}
      </Card>
    </>
  );
}
