import { storeAuditApi } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => storeAuditApi(req);
export const POST = (req: Request) => storeAuditApi(req);
