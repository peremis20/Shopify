"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import Logo from "./Logo";
import { useAuth } from "@/lib/auth-context";
import { loadAnswersLocal } from "@/lib/quiz-storage";
import { saveUserQuiz } from "@/lib/firestore";

export default function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";
  const { signIn, signUp, signInWithGoogle, configured } = useAuth();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isSignup = mode === "signup";

  async function afterAuth() {
    // If the user just finished the quiz, persist those answers now.
    const stored = loadAnswersLocal();
    const { auth } = await import("@/lib/firebase");
    if (stored && stored.goals.length > 0 && auth?.currentUser) {
      try {
        await saveUserQuiz(auth.currentUser, stored);
      } catch {
        /* dashboard will still render; ignore save error here */
      }
    }
    router.push(next);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (isSignup) {
        await signUp(email, password, name);
      } else {
        await signIn(email, password);
      }
      await afterAuth();
    } catch (err) {
      setError(humanError(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogle() {
    setError(null);
    setLoading(true);
    try {
      await signInWithGoogle();
      await afterAuth();
    } catch (err) {
      setError(humanError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page-bg flex min-h-screen items-center justify-center px-5 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>

        <div className="card px-8 py-8">
          <h1 className="text-2xl font-extrabold text-brand-green">
            {isSignup ? "Create your account" : "Welcome back"}
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            {isSignup
              ? "Save your personalized plan and unlock your dashboard."
              : "Sign in to view your health dashboard."}
          </p>

          {!configured && (
            <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
              Firebase isn&apos;t configured yet. Add your keys to{" "}
              <code>.env.local</code> to enable sign-in.
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            {isSignup && (
              <Field
                label="Name"
                type="text"
                value={name}
                onChange={setName}
                placeholder="Jane Doe"
              />
            )}
            <Field
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
              required
            />
            <Field
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              placeholder="••••••••"
              required
            />

            {error && <p className="text-sm text-red-500">{error}</p>}

            <button
              type="submit"
              disabled={loading || !configured}
              className="btn-primary w-full"
            >
              {loading
                ? "Please wait…"
                : isSignup
                ? "Create account"
                : "Sign in"}
            </button>
          </form>

          <div className="my-5 flex items-center gap-3 text-xs text-ink-muted">
            <span className="h-px flex-1 bg-cream-200" />
            or
            <span className="h-px flex-1 bg-cream-200" />
          </div>

          <button
            onClick={handleGoogle}
            disabled={loading || !configured}
            className="btn-secondary w-full"
          >
            <span className="text-lg">🔵</span> Continue with Google
          </button>

          <p className="mt-6 text-center text-sm text-ink-muted">
            {isSignup ? "Already have an account? " : "New to YoYo AK-100? "}
            <Link
              href={isSignup ? `/login?next=${next}` : `/signup?next=${next}`}
              className="font-semibold text-brand-orange hover:underline"
            >
              {isSignup ? "Sign in" : "Create one"}
            </Link>
          </p>
        </div>

        <p className="mt-6 text-center text-sm text-ink-muted">
          <Link href="/" className="hover:text-brand-orange">
            ← Back to home
          </Link>
        </p>
      </div>
    </main>
  );
}

function Field({
  label,
  type,
  value,
  onChange,
  placeholder,
  required,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold text-brand-green">
        {label}
      </span>
      <input
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border-2 border-cream-200 bg-cream-50 px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-brand-orange"
      />
    </label>
  );
}

function humanError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  const map: Record<string, string> = {
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/user-not-found": "No account found with that email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/email-already-in-use": "An account with that email already exists.",
    "auth/weak-password": "Password should be at least 6 characters.",
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/popup-closed-by-user": "Sign-in was cancelled.",
  };
  return (
    map[code] ||
    (err instanceof Error ? err.message : "Something went wrong. Please try again.")
  );
}
