import { NextRequest } from "next/server";
import { mockCalls, recordMockCall } from "@/lib/store";


// Stand-ins for the insurer's CRM, messaging gateway, task queue and escalation queue.
export async function POST(req: NextRequest, { params }: { params: Promise<{ system: string }> }) {
  const { system } = await params;
  const payload = await req.json();
  const call = recordMockCall(`/api/mock/${system}`, payload);
  return Response.json({ ok: true, id: call.id });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ system: string }> }) {
  const { system } = await params;
  return Response.json({ calls: mockCalls().filter((c) => system === "all" || c.endpoint.endsWith(system)) });
}
