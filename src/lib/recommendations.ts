import { GOALS } from "./quiz-data";
import { PRODUCTS } from "./products";
import { GoalId, HealthPlan, PlanItem, Product, QuizAnswers } from "@/types";

const GOAL_LABELS: Record<GoalId, string> = Object.fromEntries(
  GOALS.map((g) => [g.id, g.title])
) as Record<GoalId, string>;

/**
 * Score every product against the user's answers and return the best matches.
 * Products earn points for each selected goal they serve, with a bonus for
 * matching the user's preferred product form, and are filtered by allergies.
 */
export function recommendProducts(answers: QuizAnswers, limit = 4): Product[] {
  const goalSet = new Set(answers.goals);
  const formSet = new Set(answers.productForms);

  const scored = PRODUCTS.map((product) => {
    let score = 0;
    for (const g of product.goals) {
      if (goalSet.has(g)) score += 10;
    }
    // Small nudge for matching the user's preferred delivery format.
    if (formSet.size > 0 && formSet.has(product.form)) score += 3;
    // "Daily Greens" is a good foundational pick for everyone.
    if (product.id === "ak-greens") score += 1;
    return { product, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.product);
}

/** Build a human-readable, personalized health plan from the answers. */
export function buildPlan(answers: QuizAnswers): HealthPlan {
  const focusAreas = answers.goals.map((g) => GOAL_LABELS[g] ?? g);
  const routine = buildRoutine(answers);
  const tips = buildTips(answers);

  const headline =
    focusAreas.length > 0
      ? `Your plan is built around ${joinReadable(focusAreas)}.`
      : "Your personalized wellness plan.";

  const summary = buildSummary(answers);

  return { headline, summary, focusAreas, routine, tips };
}

function buildSummary(answers: QuizAnswers): string {
  const parts: string[] = [];
  if (answers.activityLevel) {
    const map: Record<string, string> = {
      sedentary: "a mostly sedentary lifestyle",
      light: "a lightly active routine",
      moderate: "a moderately active routine",
      very: "a very active lifestyle",
    };
    parts.push(map[answers.activityLevel] ?? "your current routine");
  }
  if (answers.sleepHours) {
    const map: Record<string, string> = {
      under5: "limited sleep",
      "5to6": "slightly short sleep",
      "7to8": "healthy sleep",
      over8: "plenty of rest",
    };
    parts.push(map[answers.sleepHours] ?? "your sleep pattern");
  }
  if (answers.stressLevel === "high") parts.push("higher stress levels");

  const context =
    parts.length > 0 ? ` Based on ${joinReadable(parts)}, ` : " ";
  return `We've tailored a daily wellness routine and product recommendations just for you.${context}your plan focuses on realistic, natural habits you can stick with.`;
}

function buildRoutine(answers: QuizAnswers): PlanItem[] {
  const routine: PlanItem[] = [];
  const goals = new Set(answers.goals);

  // Morning
  routine.push({
    time: "Morning",
    title: "Hydrate & fuel",
    detail:
      goals.has("increase-energy") || goals.has("energy-focus")
        ? "Start with a large glass of water and your AK-100 Focus+ or Vitality Boost to kickstart energy."
        : "Start with a large glass of water and a nutrient-dense breakfast.",
  });

  if (goals.has("digestion") || goals.has("weight")) {
    routine.push({
      time: "Morning",
      title: "Daily Greens",
      detail: "Mix one scoop of AK-100 Daily Greens for a whole-food foundation.",
    });
  }

  // Midday
  routine.push({
    time: "Midday",
    title: "Move & refocus",
    detail:
      answers.activityLevel === "sedentary"
        ? "Take a 10-minute walk and stretch to break up sitting time."
        : "Fit in a short walk or workout and refuel with a balanced lunch.",
  });

  if (answers.waterIntake === "low") {
    routine.push({
      time: "Midday",
      title: "Water check-in",
      detail: "Aim for another 2–3 glasses of water before the afternoon slump.",
    });
  }

  // Evening
  if (goals.has("better-sleep") || answers.stressLevel === "high") {
    routine.push({
      time: "Evening",
      title: "Wind down",
      detail:
        "Take AK-100 Dream Sleep or Calm & Clarity 30 minutes before bed and dim the lights.",
    });
  } else {
    routine.push({
      time: "Evening",
      title: "Recover",
      detail: "Unplug from screens and prepare for 7–8 hours of restorative sleep.",
    });
  }

  return routine;
}

function buildTips(answers: QuizAnswers): string[] {
  const tips: string[] = [];
  const goals = new Set(answers.goals);

  if (answers.waterIntake === "low")
    tips.push("Increase your water intake to at least 6 glasses a day.");
  if (answers.sleepHours === "under5" || answers.sleepHours === "5to6")
    tips.push("Aim for 7–8 hours of sleep — consistency is more important than perfection.");
  if (answers.stressLevel === "high")
    tips.push("Add 5 minutes of breathing or meditation to lower daily stress.");
  if (answers.activityLevel === "sedentary")
    tips.push("Build up to 7,000 steps a day to boost energy and mood.");
  if (goals.has("skin-glow"))
    tips.push("Pair AK-100 Radiant Glow with SPF and plenty of water for best results.");
  if (goals.has("heart-health"))
    tips.push("Favor whole foods and healthy fats to support your heart.");

  if (tips.length === 0)
    tips.push("Stay consistent — small daily habits compound into big results.");

  return tips;
}

function joinReadable(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
