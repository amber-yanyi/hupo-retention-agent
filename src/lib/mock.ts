// Mock downstream systems. Each executed action POSTs here exactly as it would to the
// insurer's CRM / messaging gateway / task queue. Handlers just record the call.
import { recordMockCall } from "./store";
import type { AgentAction } from "./types";

export const ENDPOINT: Record<AgentAction["type"], string> = {
  send_payment_reminder: "/api/mock/outreach",
  draft_retention_outreach: "/api/mock/outreach",
  create_advisor_task: "/api/mock/tasks",
  flag_record: "/api/mock/crm",
  propose_cross_sell: "/api/mock/tasks",
  escalate: "/api/mock/escalations",
};

export async function dispatch(origin: string, action: AgentAction, actor: string) {
  const endpoint = ENDPOINT[action.type];
  if (process.env.AGENT_DRY_RUN) return endpoint; // eval runs: decide, don't execute
  const payload = {
    action_id: action.id,
    actor,
    client_id: action.client_id,
    policy_id: action.policy_id,
    type: action.type,
    title: action.title,
    channel: action.channel,
    language: action.language,
    message: action.message_native,
    escalate_to: action.escalate_to,
    due_date: action.due_date,
  };
  try {
    const res = await fetch(new URL(endpoint, origin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`${res.status}`);
  } catch {
    // Dev server can't reach itself (e.g. scripts): record directly.
    recordMockCall(endpoint, payload);
  }
  return endpoint;
}
