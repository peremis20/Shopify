import { speedApi } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => speedApi(req);
export const POST = (req: Request) => speedApi(req);
