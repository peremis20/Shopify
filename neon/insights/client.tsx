import { createRoot } from "react-dom/client";
import { DashboardView } from "@/components/analytics/DashboardView";
import { installEmbeddedFetch } from "@/components/analytics/embedded-client";
import { ErrorBoundary, installErrorReporter } from "@/components/analytics/error-reporter";

// Browser entry for the dashboard when it runs as a Neon Function.
// Inside Shopify admin, API calls carry the Shopify session token.
installEmbeddedFetch();
// After the embedded fetch, so failed requests are seen with the session token already added.
installErrorReporter();
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <DashboardView />
  </ErrorBoundary>
);
