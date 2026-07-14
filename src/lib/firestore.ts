import { doc, getDoc, setDoc } from "firebase/firestore";
import { User } from "firebase/auth";
import { db } from "./firebase";
import { QuizAnswers, UserProfile } from "@/types";
import { buildPlan, recommendProducts } from "./recommendations";

/**
 * Persist a completed quiz for a signed-in user. Computes the plan and product
 * recommendations from the answers and stores everything at `users/{uid}`.
 */
export async function saveUserQuiz(
  user: User,
  answers: QuizAnswers
): Promise<UserProfile> {
  if (!db) throw new Error("Firebase is not configured.");

  const plan = buildPlan(answers);
  const recommendedProductIds = recommendProducts(answers).map((p) => p.id);
  const now = Date.now();

  const ref = doc(db, "users", user.uid);
  const existing = await getDoc(ref);

  const profile: UserProfile = {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    answers,
    plan,
    recommendedProductIds,
    createdAt: existing.exists()
      ? (existing.data() as UserProfile).createdAt ?? now
      : now,
    updatedAt: now,
  };

  await setDoc(ref, profile, { merge: true });
  return profile;
}

export async function getUserProfile(
  uid: string
): Promise<UserProfile | null> {
  if (!db) return null;
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  return snap.exists() ? (snap.data() as UserProfile) : null;
}
