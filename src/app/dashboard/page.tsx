import { Suspense } from "react";
import Dashboard from "@/components/Dashboard";

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="page-bg min-h-screen" />}>
      <Dashboard />
    </Suspense>
  );
}
