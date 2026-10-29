import { analyzeCompetition, type Competition } from "../serp";
import type { RankingApp } from "./types";

/** Google page one right now: who ranks above the store, and what their pages do. */
export const pageOne: RankingApp = {
  id: "page-one",
  name: "Google page one (serper.dev)",
  role: "Reads who ranks above you, studies their pages, and spots who just passed you",
  ready: (hub) => Boolean(hub.platform.serperKey),

  async brief(hub, cand) {
    const c: Competition = await analyzeCompetition(hub.platform.serperKey!, hub.accountId, cand.op.query, hub.ourDomain);
    hub.shared.set("page-one.competition", c);
    if (!c.serp.organic.length) return null;

    const lines = c.serp.organic.map((r) => `${r.position}. ${r.title} (${r.domain})`).join("\n");
    const pages = c.competitors
      .map(
        (p) => `#${p.position} ${p.domain}: about ${p.words} words${p.schemaTypes.length ? `, structured data: ${p.schemaTypes.join(", ")}` : ""}
  Title: ${p.title}
  Description: ${p.metaDescription || "(none)"}
  Headings: ${p.headings.slice(0, 15).join(" | ") || "(none found)"}`
      )
      .join("\n");
    const text = `Google page one for this search right now (this store is ${c.serp.ourPosition ? `#${c.serp.ourPosition}` : "not on page one"}):
${lines}
${c.newlyAbove.length ? `Moved above this store since the last check: ${c.newlyAbove.join(", ")}.\n` : ""}${pages ? `What the pages to beat do:\n${pages}\n` : ""}${c.serp.questions.length ? `People also ask: ${c.serp.questions.join(" | ")}\n` : ""}${c.serp.related.length ? `Related searches: ${c.serp.related.join(", ")}\n` : ""}
Use this to win the click and the ranking: make the SEO title and description more specific and more useful than the titles above, without copying them. If those pages cover subtopics or questions this page doesn't, the new section should cover the most important ones (answer the "People also ask" questions briefly, as an FAQ with <h3> questions, when they fit). Only use facts consistent with this page; never claim what the competitors claim unless this page supports it.`;

    const ahead = c.serp.organic.filter((r) => r.position < (c.serp.ourPosition ?? 11)).slice(0, 3).map((r) => r.domain);
    const summary = [
      ahead.length ? `Ahead on Google: ${ahead.join(", ")}.` : c.serp.ourPosition === 1 ? "Holding #1 on Google." : "",
      c.newlyAbove.length ? `New above us: ${c.newlyAbove.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return { text, summary: summary || undefined };
  },
};
