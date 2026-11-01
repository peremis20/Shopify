import { backlinkEmail } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = (req: Request) => backlinkEmail(req);
