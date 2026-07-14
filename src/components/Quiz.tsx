"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import QuizStepper from "./QuizStepper";
import GoalCard from "./GoalCard";
import OptionButton from "./OptionButton";
import ProductCard from "./ProductCard";
import {
  ACTIVITY_LEVELS,
  AGE_RANGES,
  ALLERGIES,
  BUDGETS,
  CONDITIONS,
  DIETS,
  GENDERS,
  GOALS,
  PRODUCT_FORMS,
  SLEEP_HOURS,
  STRESS_LEVELS,
  SUPPLEMENT_USE,
  WATER_INTAKE,
} from "@/lib/quiz-data";
import { GoalId, QuizAnswers } from "@/types";
import {
  EMPTY_ANSWERS,
  loadAnswersLocal,
  saveAnswersLocal,
} from "@/lib/quiz-storage";
import { buildPlan, recommendProducts } from "@/lib/recommendations";
import { useAuth } from "@/lib/auth-context";
import { saveUserQuiz } from "@/lib/firestore";

export default function Quiz() {
  const router = useRouter();
  const { user, configured } = useAuth();
  const [step, setStep] = useState(1);
  const [answers, setAnswers] = useState<QuizAnswers>(EMPTY_ANSWERS);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Restore any in-progress answers on mount.
  useEffect(() => {
    const stored = loadAnswersLocal();
    if (stored) setAnswers(stored);
  }, []);

  function update(patch: Partial<QuizAnswers>) {
    setAnswers((prev) => {
      const next = { ...prev, ...patch };
      saveAnswersLocal(next);
      return next;
    });
  }

  function toggleInArray<T extends string>(key: keyof QuizAnswers, value: T) {
    const list = answers[key] as unknown as T[];
    const exists = list.includes(value);
    // "none" is exclusive with other selections.
    let next: T[];
    if (value === ("none" as T)) {
      next = exists ? [] : (["none"] as T[]);
    } else {
      next = exists
        ? list.filter((v) => v !== value)
        : [...list.filter((v) => v !== ("none" as T)), value];
    }
    update({ [key]: next } as unknown as Partial<QuizAnswers>);
  }

  const plan = useMemo(() => buildPlan(answers), [answers]);
  const recommended = useMemo(() => recommendProducts(answers), [answers]);

  const canAdvance = useMemo(() => {
    switch (step) {
      case 1:
        return answers.goals.length > 0;
      case 2:
        return (
          answers.activityLevel &&
          answers.sleepHours &&
          answers.stressLevel &&
          answers.waterIntake
        );
      case 3:
        return (
          answers.ageRange &&
          answers.gender &&
          answers.conditions.length > 0 &&
          answers.takesSupplements
        );
      case 4:
        return (
          answers.diet &&
          answers.productForms.length > 0 &&
          answers.budget &&
          answers.allergies.length > 0
        );
      default:
        return true;
    }
  }, [step, answers]);

  function next() {
    if (step < 5) {
      setStep((s) => s + 1);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }
  function back() {
    if (step > 1) {
      setStep((s) => s - 1);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  async function handleSave() {
    if (!user) {
      // Answers are already in localStorage — send them to sign up then dashboard.
      router.push("/signup?next=/dashboard");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await saveUserQuiz(user, answers);
      setSaved(true);
      router.push("/dashboard");
    } catch (e) {
      setSaveError(
        e instanceof Error ? e.message : "Something went wrong saving your plan."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section id="quiz" className="mx-auto max-w-6xl px-5 py-10">
      <QuizStepper current={step} />

      <div className="card mt-6 px-5 py-8 md:px-10 md:py-10">
        <p className="text-sm font-bold text-brand-orange">Step {step} of 5</p>

        {step === 1 && (
          <StepShell
            title="What are your main health goals?"
            subtitle="Select all that apply"
          >
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {GOALS.map((goal) => (
                <GoalCard
                  key={goal.id}
                  goal={goal}
                  selected={answers.goals.includes(goal.id)}
                  onToggle={() => toggleInArray<GoalId>("goals", goal.id)}
                />
              ))}
            </div>
          </StepShell>
        )}

        {step === 2 && (
          <StepShell title="Tell us about your lifestyle" subtitle="Pick what fits you best">
            <Group label="How active are you?">
              <Grid>
                {ACTIVITY_LEVELS.map((o) => (
                  <OptionButton
                    key={o.id}
                    option={o}
                    selected={answers.activityLevel === o.id}
                    onSelect={() => update({ activityLevel: o.id })}
                  />
                ))}
              </Grid>
            </Group>
            <Group label="How much do you sleep?">
              <Grid>
                {SLEEP_HOURS.map((o) => (
                  <OptionButton
                    key={o.id}
                    option={o}
                    selected={answers.sleepHours === o.id}
                    onSelect={() => update({ sleepHours: o.id })}
                  />
                ))}
              </Grid>
            </Group>
            <Group label="Your typical stress level?">
              <Grid>
                {STRESS_LEVELS.map((o) => (
                  <OptionButton
                    key={o.id}
                    option={o}
                    selected={answers.stressLevel === o.id}
                    onSelect={() => update({ stressLevel: o.id })}
                  />
                ))}
              </Grid>
            </Group>
            <Group label="Daily water intake?">
              <Grid>
                {WATER_INTAKE.map((o) => (
                  <OptionButton
                    key={o.id}
                    option={o}
                    selected={answers.waterIntake === o.id}
                    onSelect={() => update({ waterIntake: o.id })}
                  />
                ))}
              </Grid>
            </Group>
          </StepShell>
        )}

        {step === 3 && (
          <StepShell title="A bit about your health" subtitle="This helps us tailor your plan safely">
            <Group label="Your age range">
              <Grid cols={5}>
                {AGE_RANGES.map((o) => (
                  <OptionButton
                    key={o.id}
                    option={o}
                    selected={answers.ageRange === o.id}
                    onSelect={() => update({ ageRange: o.id })}
                  />
                ))}
              </Grid>
            </Group>
            <Group label="Gender">
              <Grid>
                {GENDERS.map((o) => (
                  <OptionButton
                    key={o.id}
                    option={o}
                    selected={answers.gender === o.id}
                    onSelect={() => update({ gender: o.id })}
                  />
                ))}
              </Grid>
            </Group>
            <Group label="Any of these apply to you? (select all)">
              <Grid>
                {CONDITIONS.map((o) => (
                  <OptionButton
                    key={o.id}
                    option={o}
                    multi
                    selected={answers.conditions.includes(o.id)}
                    onSelect={() => toggleInArray("conditions", o.id)}
                  />
                ))}
              </Grid>
            </Group>
            <Group label="Do you currently take supplements?">
              <Grid>
                {SUPPLEMENT_USE.map((o) => (
                  <OptionButton
                    key={o.id}
                    option={o}
                    selected={answers.takesSupplements === o.id}
                    onSelect={() => update({ takesSupplements: o.id })}
                  />
                ))}
              </Grid>
            </Group>
          </StepShell>
        )}

        {step === 4 && (
          <StepShell title="Your preferences" subtitle="We'll match products you'll actually enjoy">
            <Group label="Dietary preference">
              <Grid>
                {DIETS.map((o) => (
                  <OptionButton
                    key={o.id}
                    option={o}
                    selected={answers.diet === o.id}
                    onSelect={() => update({ diet: o.id })}
                  />
                ))}
              </Grid>
            </Group>
            <Group label="Preferred product formats (select all)">
              <Grid>
                {PRODUCT_FORMS.map((o) => (
                  <OptionButton
                    key={o.id}
                    option={o}
                    multi
                    selected={answers.productForms.includes(o.id)}
                    onSelect={() => toggleInArray("productForms", o.id)}
                  />
                ))}
              </Grid>
            </Group>
            <Group label="Monthly budget">
              <Grid>
                {BUDGETS.map((o) => (
                  <OptionButton
                    key={o.id}
                    option={o}
                    selected={answers.budget === o.id}
                    onSelect={() => update({ budget: o.id })}
                  />
                ))}
              </Grid>
            </Group>
            <Group label="Any allergies? (select all)">
              <Grid>
                {ALLERGIES.map((o) => (
                  <OptionButton
                    key={o.id}
                    option={o}
                    multi
                    selected={answers.allergies.includes(o.id)}
                    onSelect={() => toggleInArray("allergies", o.id)}
                  />
                ))}
              </Grid>
            </Group>
          </StepShell>
        )}

        {step === 5 && (
          <StepShell
            title="Your personalized plan is ready! 🎉"
            subtitle="Here's a preview — save it to unlock your full dashboard"
          >
            <div className="rounded-2xl bg-gradient-to-br from-brand-orange-soft to-cream-50 p-6">
              <h3 className="text-lg font-bold text-brand-green">
                {plan.headline}
              </h3>
              <p className="mt-2 text-sm text-ink-muted">{plan.summary}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {plan.focusAreas.map((f) => (
                  <span key={f} className="chip">
                    {f}
                  </span>
                ))}
              </div>
            </div>

            <div className="mt-6">
              <h3 className="mb-3 text-base font-bold text-brand-green">
                Recommended for you
              </h3>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {recommended.map((p) => (
                  <ProductCard key={p.id} product={p} />
                ))}
              </div>
            </div>

            <div className="mt-8 rounded-2xl border-2 border-dashed border-brand-orange/40 bg-white p-6 text-center">
              {!configured ? (
                <p className="text-sm text-ink-muted">
                  Add your Firebase config (see{" "}
                  <code className="rounded bg-cream-200 px-1">.env.local</code>) to
                  enable accounts and save plans to your dashboard.
                </p>
              ) : user ? (
                <>
                  <p className="text-sm font-semibold text-brand-green">
                    Save this plan to your dashboard to track progress and revisit
                    your recommendations anytime.
                  </p>
                  {saveError && (
                    <p className="mt-2 text-sm text-red-500">{saveError}</p>
                  )}
                  <button
                    onClick={handleSave}
                    disabled={saving || saved}
                    className="btn-primary mt-4"
                  >
                    {saved ? "Saved! Redirecting…" : saving ? "Saving…" : "Save & view dashboard"}
                  </button>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-brand-green">
                    Create a free account to save your plan and get your personal
                    health dashboard.
                  </p>
                  <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
                    <button onClick={handleSave} className="btn-primary">
                      Create account & save
                    </button>
                    <Link href="/login?next=/dashboard" className="btn-secondary">
                      I already have an account
                    </Link>
                  </div>
                </>
              )}
            </div>
          </StepShell>
        )}

        {/* Navigation */}
        <div className="mt-8 flex items-center justify-between gap-4">
          {step > 1 ? (
            <button onClick={back} className="btn-secondary">
              ← Back
            </button>
          ) : (
            <span />
          )}

          {step < 5 ? (
            <button
              onClick={next}
              disabled={!canAdvance}
              className="btn-primary flex-1 sm:flex-none"
            >
              Next Step →
            </button>
          ) : (
            <button onClick={() => setStep(1)} className="btn-secondary">
              Retake quiz
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function StepShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2">
      <h2 className="text-2xl font-extrabold text-brand-green md:text-3xl">
        {title}
      </h2>
      <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>
      <div className="mt-6">{children}</div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-7">
      <h3 className="mb-3 text-sm font-bold text-brand-green">{label}</h3>
      {children}
    </div>
  );
}

function Grid({
  children,
  cols = 4,
}: {
  children: React.ReactNode;
  cols?: number;
}) {
  const cls =
    cols === 5
      ? "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
      : "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4";
  return <div className={cls}>{children}</div>;
}
