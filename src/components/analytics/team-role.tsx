"use client";

import { useSyncExternalStore, type ReactNode } from "react";

/**
 * Whether the person signed in is a team member (not the business's main sign in). Set once the overview loads.
 * The server refuses every owner only action anyway; this only hides those controls and says why.
 */
let member = false;
const listeners = new Set<() => void>();

export function setMemberSession(v: boolean) {
  if (member === v) return;
  member = v;
  listeners.forEach((f) => f());
}

export const useIsMember = () =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => member,
    () => false,
  );

export const OWNER_ONLY_NOTE = "Only the main sign in can change this for the business.";

/** Shows its controls to the main sign in; a team member sees a short note instead (or nothing with note={null}). */
export function OwnerOnly({ children, note = OWNER_ONLY_NOTE }: { children: ReactNode; note?: string | null }) {
  const isMember = useIsMember();
  if (!isMember) return <>{children}</>;
  return note ? <p className="text-xs text-dash-muted">{note}</p> : null;
}

/** A short note only a team member sees, saying what the main sign in does here. */
export function MemberNote({ text }: { text: string }) {
  return useIsMember() ? <p className="mt-2 text-xs text-dash-muted">{text}</p> : null;
}
