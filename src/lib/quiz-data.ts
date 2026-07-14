import { GoalId, QuizOption } from "@/types";

export interface GoalCardData {
  id: GoalId;
  title: string;
  description: string;
  emoji: string;
  /** Tailwind classes for the round icon badge (matches reference palette). */
  badge: string;
  /** Tailwind gradient classes for the photo/visual area. */
  visual: string;
}

/** Step 1 — the eight health goals from the reference design. */
export const GOALS: GoalCardData[] = [
  {
    id: "energy-focus",
    title: "Boost Energy & Focus",
    description: "Stay sharp and productive all day.",
    emoji: "🧠",
    badge: "bg-amber-100 text-amber-600",
    visual: "from-amber-200 via-orange-100 to-rose-100",
  },
  {
    id: "increase-energy",
    title: "Increase Energy",
    description: "Feel more energized and active.",
    emoji: "⚡",
    badge: "bg-yellow-100 text-yellow-600",
    visual: "from-sky-200 via-blue-100 to-slate-100",
  },
  {
    id: "better-sleep",
    title: "Better Sleep & Recovery",
    description: "Sleep deeper and wake up refreshed.",
    emoji: "🌙",
    badge: "bg-indigo-100 text-indigo-500",
    visual: "from-indigo-200 via-violet-100 to-slate-100",
  },
  {
    id: "immunity",
    title: "Strengthen Immunity",
    description: "Support your body's natural defense.",
    emoji: "🛡️",
    badge: "bg-lime-100 text-lime-600",
    visual: "from-lime-200 via-green-100 to-emerald-100",
  },
  {
    id: "digestion",
    title: "Improve Digestion",
    description: "Feel lighter and more comfortable.",
    emoji: "🌿",
    badge: "bg-green-100 text-green-600",
    visual: "from-emerald-200 via-teal-100 to-lime-100",
  },
  {
    id: "heart-health",
    title: "Heart Health",
    description: "Support a strong and healthy heart.",
    emoji: "❤️",
    badge: "bg-rose-100 text-rose-500",
    visual: "from-rose-200 via-red-100 to-orange-100",
  },
  {
    id: "skin-glow",
    title: "Healthy Skin & Glow",
    description: "Look and feel your best naturally.",
    emoji: "✨",
    badge: "bg-pink-100 text-pink-500",
    visual: "from-pink-200 via-rose-100 to-amber-100",
  },
  {
    id: "weight",
    title: "Weight Management",
    description: "Stay balanced and reach your goals.",
    emoji: "⚖️",
    badge: "bg-teal-100 text-teal-600",
    visual: "from-teal-200 via-cyan-100 to-slate-100",
  },
];

export const STEP_TITLES = [
  "Your Goals",
  "Lifestyle",
  "Health",
  "Preferences",
  "Results",
];

// Step 2 — Lifestyle
export const ACTIVITY_LEVELS: QuizOption[] = [
  { id: "sedentary", label: "Mostly Sedentary", description: "Little to no exercise", emoji: "🛋️" },
  { id: "light", label: "Lightly Active", description: "1–2 workouts a week", emoji: "🚶" },
  { id: "moderate", label: "Moderately Active", description: "3–4 workouts a week", emoji: "🏃" },
  { id: "very", label: "Very Active", description: "5+ workouts a week", emoji: "🏋️" },
];

export const SLEEP_HOURS: QuizOption[] = [
  { id: "under5", label: "Under 5 hours", emoji: "😴" },
  { id: "5to6", label: "5–6 hours", emoji: "🥱" },
  { id: "7to8", label: "7–8 hours", emoji: "🙂" },
  { id: "over8", label: "8+ hours", emoji: "😃" },
];

export const STRESS_LEVELS: QuizOption[] = [
  { id: "low", label: "Low", description: "Calm and relaxed", emoji: "🧘" },
  { id: "moderate", label: "Moderate", description: "Manageable ups and downs", emoji: "😌" },
  { id: "high", label: "High", description: "Often stressed", emoji: "😰" },
];

export const WATER_INTAKE: QuizOption[] = [
  { id: "low", label: "1–3 glasses", emoji: "💧" },
  { id: "medium", label: "4–6 glasses", emoji: "💦" },
  { id: "high", label: "7+ glasses", emoji: "🌊" },
];

// Step 3 — Health
export const AGE_RANGES: QuizOption[] = [
  { id: "18-29", label: "18–29" },
  { id: "30-39", label: "30–39" },
  { id: "40-49", label: "40–49" },
  { id: "50-59", label: "50–59" },
  { id: "60plus", label: "60+" },
];

export const GENDERS: QuizOption[] = [
  { id: "female", label: "Female", emoji: "👩" },
  { id: "male", label: "Male", emoji: "👨" },
  { id: "nonbinary", label: "Non-binary", emoji: "🧑" },
  { id: "prefer-not", label: "Prefer not to say", emoji: "🤝" },
];

export const CONDITIONS: QuizOption[] = [
  { id: "none", label: "None", emoji: "✅" },
  { id: "low-energy", label: "Low energy / fatigue", emoji: "🔋" },
  { id: "poor-sleep", label: "Trouble sleeping", emoji: "🌙" },
  { id: "digestive", label: "Digestive issues", emoji: "🌀" },
  { id: "joint", label: "Joint discomfort", emoji: "🦴" },
  { id: "stress", label: "Stress / anxiety", emoji: "🌪️" },
  { id: "immune", label: "Frequent colds", emoji: "🤧" },
];

export const SUPPLEMENT_USE: QuizOption[] = [
  { id: "yes", label: "Yes, regularly", emoji: "💊" },
  { id: "sometimes", label: "Occasionally", emoji: "🤔" },
  { id: "no", label: "Not at all", emoji: "🚫" },
];

// Step 4 — Preferences
export const DIETS: QuizOption[] = [
  { id: "no-restriction", label: "No restrictions", emoji: "🍽️" },
  { id: "vegetarian", label: "Vegetarian", emoji: "🥗" },
  { id: "vegan", label: "Vegan", emoji: "🌱" },
  { id: "keto", label: "Keto / Low-carb", emoji: "🥑" },
  { id: "pescatarian", label: "Pescatarian", emoji: "🐟" },
];

export const PRODUCT_FORMS: QuizOption[] = [
  { id: "capsules", label: "Capsules", emoji: "💊" },
  { id: "gummies", label: "Gummies", emoji: "🐻" },
  { id: "powder", label: "Powder", emoji: "🥄" },
  { id: "liquid", label: "Liquid", emoji: "🧴" },
];

export const BUDGETS: QuizOption[] = [
  { id: "value", label: "Value", description: "Under $30 / month", emoji: "💵" },
  { id: "standard", label: "Standard", description: "$30–60 / month", emoji: "💳" },
  { id: "premium", label: "Premium", description: "$60+ / month", emoji: "💎" },
];

export const ALLERGIES: QuizOption[] = [
  { id: "none", label: "None", emoji: "✅" },
  { id: "gluten", label: "Gluten", emoji: "🌾" },
  { id: "dairy", label: "Dairy", emoji: "🥛" },
  { id: "soy", label: "Soy", emoji: "🫘" },
  { id: "nuts", label: "Nuts", emoji: "🥜" },
  { id: "shellfish", label: "Shellfish", emoji: "🦐" },
];
