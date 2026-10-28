"use client";

import { useMemo } from "react";
import type { KeywordIdea } from "@/lib/analytics/keyword-options";
import { groupTopics } from "@/lib/analytics/topics";
import { formatNumber } from "./format";
import { TrackButton } from "./seo-ui";

/** Keyword ideas grouped into content topics, each a page or post to write. */
export function TopicsView({ ideas, onTrack, unit = "searches a month" }: {
  ideas: KeywordIdea[];
  onTrack: (keywords: string[]) => void;
  /** What the numbers in avgMonthlySearches mean for this list. */
  unit?: string;
}) {
  const topics = useMemo(() => groupTopics(ideas), [ideas]);

  return (
    <div className="grid max-h-[560px] gap-3 overflow-auto sm:grid-cols-2 xl:grid-cols-3">
      {topics.map((t) => (
        <div key={t.title} className="flex flex-col gap-2 rounded-xl border border-dash-line bg-white p-4">
          <div className="flex items-start justify-between gap-2">
            <p className="font-serif text-lg leading-tight text-dash-ink">{t.title}</p>
            <TrackButton label="Track all" onClick={() => onTrack(t.keywords.map((k) => k.keyword))} />
          </div>
          <p className="text-xs text-dash-muted">
            {t.totalSearches ? `${formatNumber(t.totalSearches)} ${unit} · ` : ""}
            {t.keywords.length} keyword{t.keywords.length === 1 ? "" : "s"}
          </p>
          <span className="w-fit rounded-full bg-[#F1ECE3] px-2 py-0.5 text-xs font-medium text-dash-ink">{t.contentType}</span>
          <div className="flex flex-wrap gap-1.5">
            {t.keywords.slice(0, 8).map((k) => (
              <span key={k.keyword} className="rounded-md bg-dash-bg px-2 py-0.5 text-xs text-dash-ink">
                {k.keyword}
              </span>
            ))}
            {t.keywords.length > 8 && <span className="px-1 text-xs text-dash-muted">and {t.keywords.length - 8} more</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
