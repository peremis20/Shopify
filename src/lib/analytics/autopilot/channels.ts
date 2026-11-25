/**
 * Google Analytics puts key events it can't tie to a visit (checkout or server side events, consent
 * blocked sessions) under "Unassigned" or "(not set)". They are real events but not leads from any
 * channel, so reports show them on their own line instead of counting them as channel leads.
 */
export function isUnattributed(channel: string): boolean {
  return /^\s*(unassigned|\(not set\))\s*$/i.test(channel);
}

/** Key events tied to a channel, and those Google Analytics couldn't tie to a visit. */
export function splitLeads(channels: { name: string; keyEvents: number }[]): { leads: number; unattributed: number } {
  let leads = 0;
  let unattributed = 0;
  for (const c of channels) if (isUnattributed(c.name)) unattributed += c.keyEvents; else leads += c.keyEvents;
  return { leads, unattributed };
}

/** The plain note shown under the numbers when some key events couldn't be tied to a visit. */
export function unattributedNote(n: number): string | null {
  if (n <= 0) return null;
  return `Google Analytics also recorded ${n.toLocaleString("en-US")} key ${n === 1 ? "event" : "events"} it couldn't tie to a visit (shown as Unassigned or not set). These are often checkout or server events, so they aren't counted as leads from any channel.`;
}
