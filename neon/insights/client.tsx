import { createRoot } from "react-dom/client";
import { DashboardView } from "@/components/analytics/DashboardView";
import { installEmbeddedFetch } from "@/components/analytics/embedded-client";

// Browser entry for the dashboard when it runs as a Neon Function.
// Inside Shopify admin, API calls carry the Shopify session token.
installEmbeddedFetch();
createRoot(document.getElementById("root")!).render(<DashboardView />);
