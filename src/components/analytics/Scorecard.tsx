"use client";

import { useEffect, useState } from "react";
import type { AgentScore } from "@/lib/analytics/autopilot/scorecard";
import { api } from "./seo-ui";
import { Card, CardHeader } from "./ui";

/** Each agent's record on this site: what it did and what was measured. Advanced view. */
export function Scorecard() {
  const [scores, setScores] = useState<AgentScore[] | null>(null);
  useEffect(() => {
    api<{ scores: AgentScore[] }>("/api/autopilot/scorecard").then((d) => setScores(d.scores)).catch(() => setScores([]));
  }, []);
  if (!scores?.length) return null;
  return (
    <Card className="mt-6">
      <CardHeader title="Agent scorecard" />
      <p className="mb-3 text-xs text-dash-muted">What each agent did on this site and what was measured. Results count four weeks after each change.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-dash-line text-left text-xs text-dash-muted">
              <th className="py-2 pr-3 font-medium">Agent</th>
              <th className="py-2 pr-3 font-medium">Did</th>
              <th className="py-2 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {scores.map((s) => (
              <tr key={s.agent} className="border-b border-dash-line/60 align-top last:border-0">
                <td className="py-2 pr-3 font-medium text-dash-ink">{s.agent}</td>
                <td className="py-2 pr-3 text-dash-ink">{s.did}</td>
                <td className="py-2 text-dash-muted">{s.result ?? "Nothing yet."}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
