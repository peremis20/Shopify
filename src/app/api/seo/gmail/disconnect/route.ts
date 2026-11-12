import { gmailDisconnect } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => gmailDisconnect(req);
