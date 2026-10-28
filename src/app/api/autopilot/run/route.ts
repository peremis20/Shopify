import { runAutopilotNow } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = () => runAutopilotNow();
