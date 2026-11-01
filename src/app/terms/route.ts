import { termsHtml } from "../../../neon/insights/legal";

export const dynamic = "force-dynamic";

export const GET = () => new Response(termsHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
