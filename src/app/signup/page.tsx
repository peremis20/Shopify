import { Suspense } from "react";
import AuthForm from "@/components/AuthForm";

export default function SignupPage() {
  return (
    <Suspense fallback={<div className="page-bg min-h-screen" />}>
      <AuthForm mode="signup" />
    </Suspense>
  );
}
