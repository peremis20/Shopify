import { QuizAnswers } from "@/types";

const KEY = "yoyo-quiz-answers";

export const EMPTY_ANSWERS: QuizAnswers = {
  goals: [],
  activityLevel: "",
  sleepHours: "",
  stressLevel: "",
  waterIntake: "",
  ageRange: "",
  gender: "",
  conditions: [],
  takesSupplements: "",
  diet: "",
  productForms: [],
  budget: "",
  allergies: [],
};

/** Persist in-progress / completed answers so they survive the sign-up hop. */
export function saveAnswersLocal(answers: QuizAnswers): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(answers));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

export function loadAnswersLocal(): QuizAnswers | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    return { ...EMPTY_ANSWERS, ...(JSON.parse(raw) as QuizAnswers) };
  } catch {
    return null;
  }
}

export function clearAnswersLocal(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
