import { platformOwners } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => platformOwners(req);
export const POST = (req: Request) => platformOwners(req);
