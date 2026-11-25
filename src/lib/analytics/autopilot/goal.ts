/**
 * The goal card in plain words. The goal (20,000 Google visitors a month for every site) is long term; next to a small
 * site's real number it reads as failure, so the card also shows the next step on the way. Pure, safe for the browser.
 */
const STEPS = [100, 500, 1_000, 2_500, 5_000, 10_000, 20_000];

/** The next milestone above this many Google visitors a month, never above the goal. */
export function nextMilestone(visitors: number, goal: number): number {
  return STEPS.find((s) => s > visitors && s < goal) ?? goal;
}

const COUNTS = "It counts clicks from Google search only (Search Console), so it is usually lower than all visits.";

/** What the number counts and what comes next, so a small or zero number isn't read as broken. */
export function goalNote(visitors: number | null, goal: number, opts: { estimate?: boolean } = {}): string {
  if (visitors === null) return `Not measured yet. ${COUNTS}`;
  if (visitors >= goal) return `${opts.estimate ? "On pace for the goal." : "Goal reached."} ${COUNTS}`;
  const next = nextMilestone(visitors, goal).toLocaleString("en-US");
  return visitors === 0
    ? `No clicks from Google search in this period. First step: ${next} a month. ${COUNTS}`
    : `Next step: ${next} a month. ${COUNTS}`;
}

/** Why the goal is so much bigger than today's number. */
export const goalWhy = (goal: number) =>
  `${goal.toLocaleString("en-US")} a month is the long term goal every site works toward; the agents start with the easiest searches and aim higher as the site grows.`;
