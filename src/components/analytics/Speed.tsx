"use client";

import { useEffect, useState } from "react";
import type { SpeedFix, SpeedReport } from "@/lib/analytics/autopilot/speed";
import { api } from "./seo-ui";
import { Card, CardHeader } from "./ui";
import { useIsMember } from "./team-role";

interface View {
  report: SpeedReport | null;
  speedNote: string | null;
  imagesNote: string | null;
}

const kb = (b: number) => `${Math.round(b / 1000).toLocaleString()} KB`;
const pathOf = (u: string) => {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
};
const IMPACT: Record<SpeedFix["impact"], string> = { high: "Big effect", medium: "Some effect", low: "Small effect" };

/** The Speed card: the Speed agent's phone test and fixes, and the Image agent's lighter copies. */
export function Speed() {
  // Applying or undoing on the live site is for the main sign in.
  const member = useIsMember();
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<View>("/api/speed").then(setView).catch(() => setView(null));
  }, []);
  if (!view) return null;
  const sp = view.report?.speed;
  const im = view.report?.images;
  // A change shows once its original is safely backed up (a bare reservation changed nothing).
  const changes = (view.report?.imageChanges ?? []).filter((c) => c.backupId);
  const act = async (action: "shrink" | "undo", id: string) => {
    setBusy(true);
    setError(null);
    try {
      setView(await api<View>("/api/speed", { action, id, checkAt: im?.at ?? null }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change the image. Try again later.");
      await api<View>("/api/speed").then(setView).catch(() => undefined);
    }
    setBusy(false);
  };
  const done = new Set(changes.map((c) => c.fileId));
  const scores = sp?.history.filter((h) => h.score !== null) ?? [];
  return (
    <Card className="mt-6">
      <CardHeader title="Speed" />
      <p className="mb-3 text-xs text-dash-muted">
        Two agents keep your store fast on phones. The Speed agent runs Google&apos;s phone speed test on your key pages each week. The Image agent makes lighter copies of heavy images and swaps them in when you click Shrink.
      </p>
      <h3 className="mb-2 font-serif text-lg">Speed agent</h3>
      {!sp && <p className="text-sm text-dash-ink">{view.speedNote ?? "The first speed test runs within the week."}</p>}
      {sp && (
        <>
          <p className="mb-2 text-sm text-dash-ink">
            {sp.note}. Tested {new Date(sp.at).toLocaleDateString()}.
            {scores.length > 1 ? ` Score over the weeks: ${scores.map((h) => h.score).join(", ")}.` : ""}
          </p>
          {sp.fixes.length ? (
            <ul className="space-y-2">
              {sp.fixes.map((f) => (
                <li key={f.id} className="rounded-xl border border-dash-line p-3">
                  <p className="text-sm font-semibold text-dash-ink">{f.problem}</p>
                  <p className="mt-1 text-sm text-dash-ink">{f.fix}</p>
                  <p className="mt-1 text-xs text-dash-muted">
                    {pathOf(f.page)} · {IMPACT[f.impact]} · {f.byImageAgent ? "The Image agent handles this" : "You or your theme developer fix this"}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-dash-muted">Google found nothing clear to fix on these pages.</p>
          )}
        </>
      )}
      <h3 className="mb-2 mt-4 font-serif text-lg">Image agent</h3>
      {!im && <p className="text-sm text-dash-ink">{view.imagesNote ?? "The first image check runs after the speed test."}</p>}
      {im && (
        <>
          <p className="mb-2 text-sm text-dash-ink">{im.note}.</p>
          {im.candidates.length > 0 && <p className="mb-2 text-xs text-dash-muted">Lighter copies are at most 1600 pixels wide, so a zoomed in photo can look a little softer. Undo puts the original back anytime.</p>}
          {im.candidates.length > 0 && (
            <ul className="space-y-2">
              {im.candidates.map((c) => (
                <li key={c.fileId} className="flex flex-wrap items-center gap-3 rounded-xl border border-dash-line p-3 text-sm text-dash-ink">
                  <span className="break-words [overflow-wrap:anywhere]">
                    {c.name}: {kb(c.before)} to {kb(c.after)}
                    {c.newWidth < c.width ? `, ${c.width} to ${c.newWidth} pixels wide` : ""}
                    {c.toJpeg ? ", saved as JPEG (it has no transparent parts)" : ""}. On {pathOf(c.page)}.
                  </span>
                  {done.has(c.fileId) ? (
                    <span className="text-xs font-semibold">Done</span>
                  ) : (
                    <button hidden={member} title={member ? "Only the main sign in can change this for the business." : undefined} disabled={busy} onClick={() => act("shrink", c.fileId)} className="rounded-lg bg-dash-green px-2 py-1 text-xs font-semibold text-white hover:bg-dash-deep disabled:opacity-60">
                      Shrink
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {changes.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-xs font-semibold text-dash-ink">Images made lighter (the original is kept in your Shopify files)</p>
          <ul className="space-y-1 text-xs text-dash-ink">
            {[...changes].reverse().map((c) => (
              <li key={c.fileId} className="flex flex-wrap items-center gap-2">
                <span>
                  {c.name}: {kb(c.before)} to {kb(c.after)}, {new Date(c.at).toLocaleDateString()}
                </span>
                <button hidden={member} title={member ? "Only the main sign in can change this for the business." : undefined} disabled={busy} onClick={() => act("undo", c.fileId)} className="font-semibold text-dash-green hover:underline disabled:opacity-60">
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-dash-down">{error}</p>}
    </Card>
  );
}
