import { handle } from "../../../../core/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;
export async function GET(
  req: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return handle(req, (await context.params).path);
}
export async function POST(
  req: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return handle(req, (await context.params).path);
}
