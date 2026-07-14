export type GoalId =
  | "energy-focus"
  | "increase-energy"
  | "better-sleep"
  | "immunity"
  | "digestion"
  | "heart-health"
  | "skin-glow"
  | "weight";

export interface QuizOption {
  id: string;
  label: string;
  description?: string;
  emoji?: string;
}

/** The full set of answers a user provides across the 5 quiz steps. */
export interface QuizAnswers {
  // Step 1 — Your Goals (multi-select)
  goals: GoalId[];

  // Step 2 — Lifestyle (single-select each)
  activityLevel: string;
  sleepHours: string;
  stressLevel: string;
  waterIntake: string;

  // Step 3 — Health
  ageRange: string;
  gender: string;
  conditions: string[];
  takesSupplements: string;

  // Step 4 — Preferences
  diet: string;
  productForms: string[];
  budget: string;
  allergies: string[];
}

export interface Product {
  id: string;
  name: string;
  tagline: string;
  description: string;
  price: number;
  emoji: string;
  color: string; // tailwind gradient classes for the product tile
  goals: GoalId[];
  form: string;
  benefits: string[];
}

export interface PlanItem {
  time: "Morning" | "Midday" | "Evening";
  title: string;
  detail: string;
}

export interface HealthPlan {
  headline: string;
  summary: string;
  focusAreas: string[];
  routine: PlanItem[];
  tips: string[];
}

/** The document stored in Firestore at `users/{uid}`. */
export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  answers: QuizAnswers;
  plan: HealthPlan;
  recommendedProductIds: string[];
  createdAt: number;
  updatedAt: number;
}
