"use client";

import { useEffect, useState } from "react";
import { api } from "./seo-ui";
import { Card, CardHeader } from "./ui";

/** A live preview of this week's report email, made from the site's own data when opened. */
export function WeeklyReport({ auto = false }: { auto?: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function load() {
    setBusy(true);
    setErr(null);
    try {
      setText((await api<{ text: string }>("/api/autopilot/weekly-report")).text);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The report couldn't be made right now.");
    } finally {
      setBusy(false);
    }
  }
  // On its own page the report is made as soon as it opens.
  useEffect(() => {
    if (auto) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);
  return (
    <Card className="mt-6">
      <CardHeader title="This week's report" />
      <p className="mb-3 text-xs text-dash-muted">The same report your weekly email sends: visits, leads and sales, backlinks and what each agent did.</p>
      {text ? (
        <pre className="whitespace-pre-wrap break-words font-sans text-sm text-dash-ink">{text}</pre>
      ) : (
        <button onClick={load} disabled={busy} className="rounded-full bg-dash-green px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">
          {busy ? "Making the report, about half a minute..." : "See this week's report"}
        </button>
      )}
      {text && (
        <button onClick={load} disabled={busy} className="mt-3 text-xs font-semibold text-dash-green hover:underline disabled:opacity-50">
          {busy ? "Updating..." : "Update"}
        </button>
      )}
      {err && <p className="mt-2 text-xs text-dash-down">{err}</p>}
    </Card>
  );
}
