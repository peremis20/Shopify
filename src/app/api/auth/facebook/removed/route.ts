import { facebookRemoved } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => facebookRemoved(req);
