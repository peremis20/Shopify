import { conversionApi } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => conversionApi(req);
export const POST = (req: Request) => conversionApi(req);
