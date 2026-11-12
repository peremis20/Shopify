import { gmailSendEmail } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = (req: Request) => gmailSendEmail(req);
