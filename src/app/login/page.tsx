import { Suspense } from "react";
import AuthForm from "@/components/AuthForm";

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="page-bg min-h-screen" />}>
      <AuthForm mode="login" />
    </Suspense>
  );
}
