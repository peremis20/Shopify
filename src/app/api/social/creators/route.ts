import { creatorsApi } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => creatorsApi(req);
export const POST = (req: Request) => creatorsApi(req);
