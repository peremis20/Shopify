import { teamMembers } from "@/lib/analytics/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => teamMembers(req);
export const POST = (req: Request) => teamMembers(req);
