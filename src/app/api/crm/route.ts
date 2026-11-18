import { crmApi } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => crmApi(req);
export const POST = (req: Request) => crmApi(req);
