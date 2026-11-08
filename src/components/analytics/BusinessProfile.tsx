"use client";

import { useEffect, useState } from "react";
import { api } from "./seo-ui";
import { Card, CardHeader } from "./ui";

type About = { audience: string; offer: string; difference: string; tone: string; location: string };
const FIELDS: { id: keyof About; label: string; hint: string }[] = [
  { id: "offer", label: "What you offer", hint: "What you sell or provide, in a sentence or two." },
  { id: "audience", label: "Who it's for", hint: "Your customers or readers." },
  { id: "difference", label: "What makes you different", hint: "Why someone picks you over others." },
  { id: "tone", label: "How you talk", hint: "For example: warm and plain, or precise and clinical." },
  { id: "location", label: "Where you serve", hint: "A city, a country, or online everywhere." },
];
const EMPTY: About = { audience: "", offer: "", difference: "", tone: "", location: "" };

/** The business in its own words. Every agent writes from it; the agents fill it from the site, the owner corrects it. */
export function BusinessProfile() {
  const [about, setAbout] = useState<About>(EMPTY);
  const [source, setSource] = useState<"auto" | "owner" | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ about: About | null; source: "auto" | "owner" | null }>("/api/profile/business")
      .then((d) => {
        setAbout({ ...EMPTY, ...(d.about ?? {}) });
        setSource(d.source);
      })
      .catch(() => undefined);
  }, []);
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const d = await api<{ about: About | null; source: "auto" | "owner" | null }>("/api/profile/business", about);
      setAbout({ ...EMPTY, ...(d.about ?? {}) });
      setSource(d.source);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="mt-5">
      <CardHeader title="Your business" />
      <p className="mb-3 text-sm text-dash-muted">
        Every agent writes from this, so pages, articles and emails fit your business instead of sounding generic.
        {source === "auto" && " The agents filled it from your own site. Check it and correct anything."}
        {source === "owner" && " You checked this, so the agents never change it."}
        {!source && " The agents fill it from your site within a day, or write it yourself now."}
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        {FIELDS.map((f) => (
          <label key={f.id} className="block text-sm">
            <span className="font-semibold text-dash-ink">{f.label}</span>
            <textarea
              value={about[f.id]}
              onChange={(e) => setAbout((a) => ({ ...a, [f.id]: e.target.value }))}
              placeholder={f.hint}
              rows={2}
              maxLength={400}
              className="mt-1 w-full rounded-lg border border-dash-line bg-white px-3 py-2 text-sm text-dash-ink focus:outline-none focus:ring-2 focus:ring-dash-green/30"
            />
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button onClick={save} disabled={busy} className="rounded-xl bg-dash-green px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? "Saving..." : "Save"}
        </button>
        {saved && <span className="text-sm text-dash-up">Saved. The agents use it from the next run.</span>}
        {err && <span className="text-sm text-dash-down">{err}</span>}
      </div>
    </Card>
  );
}
