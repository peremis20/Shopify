import { privacyHtml } from "../../../neon/insights/legal";

export const dynamic = "force-dynamic";

export const GET = () => new Response(privacyHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
