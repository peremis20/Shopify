"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Navbar from "./Navbar";
import ProductCard from "./ProductCard";
import { useAuth } from "@/lib/auth-context";
import { getUserProfile } from "@/lib/firestore";
import { getProductsByIds } from "@/lib/products";
import { GOALS } from "@/lib/quiz-data";
import { UserProfile } from "@/types";

const GOAL_TITLE = Object.fromEntries(GOALS.map((g) => [g.id, g.title]));
const GOAL_EMOJI = Object.fromEntries(GOALS.map((g) => [g.id, g.emoji]));

export default function Dashboard() {
  const { user, loading, configured } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login?next=/dashboard");
      return;
    }
    (async () => {
      const p = await getUserProfile(user.uid);
      setProfile(p);
      setFetching(false);
    })();
  }, [user, loading, router]);

  if (loading || fetching) {
    return (
      <main className="page-bg min-h-screen">
        <Navbar />
        <div className="mx-auto max-w-6xl px-5 py-20 text-center text-ink-muted">
          Loading your dashboard…
        </div>
      </main>
    );
  }

  if (!configured) {
    return (
      <main className="page-bg min-h-screen">
        <Navbar />
        <EmptyState
          title="Firebase not configured"
          body="Add your Firebase keys to .env.local to enable accounts and dashboards."
        />
      </main>
    );
  }

  if (!profile) {
    return (
      <main className="page-bg min-h-screen">
        <Navbar />
        <EmptyState
          title="No plan yet"
          body="You haven't completed the health quiz. Take it now to unlock your personalized plan and product recommendations."
          cta={{ href: "/#quiz", label: "Take the quiz →" }}
        />
      </main>
    );
  }

  const products = getProductsByIds(profile.recommendedProductIds);
  const name = profile.displayName || user?.displayName || "there";

  return (
    <main className="page-bg min-h-screen pb-16">
      <Navbar />

      <div className="mx-auto max-w-6xl px-5 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-brand-orange">
              Your Health Dashboard
            </p>
            <h1 className="text-3xl font-extrabold text-brand-green md:text-4xl">
              Hi {name.split(" ")[0]} 👋
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              Last updated {new Date(profile.updatedAt).toLocaleDateString()}
            </p>
          </div>
          <Link href="/#quiz" className="btn-secondary">
            Retake quiz
          </Link>
        </div>

        {/* Focus goals */}
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-bold text-brand-green">Your Goals</h2>
          <div className="flex flex-wrap gap-3">
            {profile.answers.goals.map((g) => (
              <span
                key={g}
                className="flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-brand-green shadow-card"
              >
                <span className="text-lg">{GOAL_EMOJI[g]}</span>
                {GOAL_TITLE[g] ?? g}
              </span>
            ))}
          </div>
        </section>

        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          {/* Plan */}
          <section className="card p-6 lg:col-span-2">
            <h2 className="text-lg font-bold text-brand-green">
              Your Personalized Plan
            </h2>
            <p className="mt-1 text-sm font-semibold text-brand-green/80">
              {profile.plan.headline}
            </p>
            <p className="mt-2 text-sm text-ink-muted">{profile.plan.summary}</p>

            <div className="mt-5 space-y-3">
              {profile.plan.routine.map((item, i) => (
                <div
                  key={i}
                  className="flex gap-3 rounded-xl bg-cream-50 p-4"
                >
                  <span className="flex h-8 items-center rounded-full bg-brand-orange-soft px-3 text-xs font-bold text-brand-green">
                    {item.time}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-brand-green">
                      {item.title}
                    </p>
                    <p className="text-sm text-ink-muted">{item.detail}</p>
                  </div>
                </div>
              ))}
            </div>

            {profile.plan.tips.length > 0 && (
              <div className="mt-5">
                <h3 className="mb-2 text-sm font-bold text-brand-green">
                  Tips for you
                </h3>
                <ul className="space-y-1.5">
                  {profile.plan.tips.map((t, i) => (
                    <li key={i} className="flex gap-2 text-sm text-ink-muted">
                      <span className="text-brand-orange">✓</span>
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* Health snapshot */}
          <section className="card h-fit p-6">
            <h2 className="text-lg font-bold text-brand-green">
              Health Snapshot
            </h2>
            <dl className="mt-4 space-y-3 text-sm">
              <Row label="Age" value={profile.answers.ageRange} />
              <Row label="Activity" value={label(profile.answers.activityLevel)} />
              <Row label="Sleep" value={label(profile.answers.sleepHours)} />
              <Row label="Stress" value={label(profile.answers.stressLevel)} />
              <Row label="Water" value={label(profile.answers.waterIntake)} />
              <Row label="Diet" value={label(profile.answers.diet)} />
              <Row
                label="Allergies"
                value={
                  profile.answers.allergies
                    .filter((a) => a !== "none")
                    .join(", ") || "None"
                }
              />
            </dl>
          </section>
        </div>

        {/* Recommendations */}
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-bold text-brand-green">
            Recommended Products
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {products.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-cream-200 pb-2">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="font-semibold text-brand-green">{value || "—"}</dd>
    </div>
  );
}

function EmptyState({
  title,
  body,
  cta,
}: {
  title: string;
  body: string;
  cta?: { href: string; label: string };
}) {
  return (
    <div className="mx-auto max-w-md px-5 py-20 text-center">
      <div className="card px-8 py-10">
        <div className="mb-3 text-4xl">🌿</div>
        <h1 className="text-xl font-extrabold text-brand-green">{title}</h1>
        <p className="mt-2 text-sm text-ink-muted">{body}</p>
        {cta && (
          <Link href={cta.href} className="btn-primary mt-6">
            {cta.label}
          </Link>
        )}
      </div>
    </div>
  );
}

/** Turn stored option ids into human-readable labels. */
function label(id: string): string {
  const map: Record<string, string> = {
    sedentary: "Mostly sedentary",
    light: "Lightly active",
    moderate: "Moderately active",
    very: "Very active",
    under5: "Under 5 hrs",
    "5to6": "5–6 hrs",
    "7to8": "7–8 hrs",
    over8: "8+ hrs",
    low: "Low",
    high: "High",
    medium: "Medium",
    "no-restriction": "No restrictions",
    vegetarian: "Vegetarian",
    vegan: "Vegan",
    keto: "Keto / Low-carb",
    pescatarian: "Pescatarian",
  };
  return map[id] ?? id;
}
