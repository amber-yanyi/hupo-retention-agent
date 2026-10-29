import { NextRequest } from "next/server";
import { findAction, save } from "@/lib/store";
import { dispatch } from "@/lib/mock";


// Human decisions on recommendations and hand-offs. Every decision is recorded on the action.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { decision, message_native, actor = "advisor" } = await req.json();
  const found = findAction(id);
  if (!found) return Response.json({ error: "not found" }, { status: 404 });
  const { action } = found;

  if (decision === "approve" && action.status === "pending_approval") {
    if (typeof message_native === "string" && message_native !== action.message_native) {
      action.talking_points = [...action.talking_points, "Edited by advisor before sending"];
      action.message_native = message_native;
    }
    action.status = "approved";
    action.endpoint = await dispatch(req.nextUrl.origin, action, actor);
    action.executed_at = new Date().toISOString();
  } else if (decision === "reject" && action.status === "pending_approval") {
    action.status = "rejected";
  } else if (decision === "acknowledge" && action.status === "open") {
    action.status = "acknowledged";
  } else {
    return Response.json({ error: `cannot ${decision} an action that is ${action.status}` }, { status: 409 });
  }
  save();
  return Response.json({ action });
}
