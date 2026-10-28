import { createRoot } from "react-dom/client";
import { DashboardView } from "@/components/analytics/DashboardView";

// Browser entry for the dashboard when it runs as a Neon Function.
createRoot(document.getElementById("root")!).render(<DashboardView />);
