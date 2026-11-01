import { authorityOf, authorityReady, readAuthorityHistory, recordAuthority } from "../authority";
import { readProspects } from "../backlinks";
import { topicWords } from "../site-keywords";
import { rankWatch, type RankWatchRow } from "../tracking";
import type { Candidate, RankingApp } from "./types";

/**
 * The loop that ties the other parts together, so what one learns changes
 * what the autopilot does next:
 * - a search that just fell off Google page one is rescued first
 * - as the site gets stronger, harder searches stop being held back
 * - a backlink the owner won lifts the searches on that topic, while the link is fresh
 * (Sales from Google are weighed by the Analytics app.)
 */

/** Below this site strength (0 to 10) Easy searches are strongly preferred; at STRONG they barely are. */
const NEW_SITE = 3;
const STRONG = 5;
const WON_LINK_DAYS = 60;

const dropped = (r: RankWatchRow) => r.previous !== null && r.previous <= 10 && (r.position === null || r.position > 10);

export const feedback: RankingApp = {
  id: "feedback",
  name: "Learning loop",
  role: "Rescues searches that fall off page 1, aims higher as your site gets stronger, and builds on backlinks you win",
  ready: () => true,

  // A search that just fell off page one: win it back before chasing new ones.
  async candidates(hub) {
    const rows = await rankWatch(hub.accountId).catch(() => []);
    const out: Candidate[] = [];
    for (const r of rows.filter(dropped)) {
      if (!r.url) continue;
      out.push({
        op: { query: r.query, page: r.url.split("#")[0].split("?")[0], position: r.position ?? 25, impressions: 0, clicks: 0, ctr: 0, potentialClicks: 1 },
        mode: "defend",
        previousPosition: r.previous ?? undefined,
        weights: {},
      });
    }
    hub.shared.set("feedback.dropped", new Map(rows.filter(dropped).map((r) => [r.query, r.previous!])));
    return out;
  },

  async enrich(hub, cands) {
    // Site strength: the stronger the site, the less the Easy preference matters.
    const history = await readAuthorityHistory(hub.accountId).catch(() => []);
    let strength = history.length ? history[history.length - 1].score : null;
    // Not read on the dashboard yet: look it up now, and keep the reading for the trend.
    if (strength === null && hub.ourDomain && (await authorityReady())) {
      const d = hub.ourDomain.replace(/^www\./, "");
      strength = (await authorityOf([d]).catch(() => new Map<string, number>())).get(d) ?? null;
      if (strength !== null) await recordAuthority(hub.accountId, strength).catch(() => undefined);
    }
    const keep = strength === null || strength < NEW_SITE ? 1 : strength < STRONG ? 0.5 : 0.2;
    hub.shared.set("feedback.strength", strength);

    // Backlinks won recently: their topics get a lift.
    const list = await readProspects(hub.accountId).catch(() => null);
    const since = Date.now() - WON_LINK_DAYS * 86_400_000;
    const wonTopics = (list?.prospects ?? [])
      .filter((p) => p.status === "won" && new Date(p.statusAt ?? p.foundAt).getTime() >= since && p.kind !== "mention")
      .map((p) => [...topicWords(p.topic)]);
    hub.shared.set("feedback.wonTopics", wonTopics);

    const droppedMap = (hub.shared.get("feedback.dropped") as Map<string, number> | undefined) ?? new Map<string, number>();
    for (const c of cands) {
      if (c.weights.ease !== undefined) c.weights.ease = Math.pow(c.weights.ease, keep);
      if (droppedMap.has(c.op.query)) {
        c.mode = "defend";
        c.previousPosition ??= droppedMap.get(c.op.query);
        c.weights[this.id] = 2;
      }
      const have = topicWords(c.op.query);
      if (wonTopics.some((t) => t.length > 0 && t.every((w) => have.has(w)))) c.weights[`${this.id}.links`] = 1.3;
    }
  },

  async brief(hub, c) {
    const dropped = (hub.shared.get("feedback.dropped") as Map<string, number> | undefined)?.has(c.op.query);
    if (dropped) {
      return {
        text: `This search just fell off Google page one (it was #${c.previousPosition ?? "top 10"}). Compare the page with what ranks now and close the gap, without removing what already worked.`,
        summary: "Rescuing a search that fell off page 1",
      };
    }
    const wonTopics = (hub.shared.get("feedback.wonTopics") as string[][] | undefined) ?? [];
    const have = topicWords(c.op.query);
    if (wonTopics.some((t) => t.length > 0 && t.every((w) => have.has(w)))) {
      return { text: "", summary: "A backlink was just won on this topic, so this page has extra pull right now" };
    }
    return null;
  },
};
