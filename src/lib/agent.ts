import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { ACTION_CATALOG, ESCALATION_LABEL, RULES, buildEnvelope, unitManagerFor } from "./governance";
import { renderReminder, TEMPLATE_ID } from "./templates";
import { dispatch } from "./mock";
import { AS_OF, addDays } from "./dates";
import type { ActionType, AgentAction, Book, Client, ClientDecision, Envelope, EscalationTarget, Run } from "./types";

// Provider: OpenRouter when OPENROUTER_API_KEY is set, otherwise the Anthropic API directly.
const USE_OPENROUTER = !!process.env.OPENROUTER_API_KEY;
export const MODEL = process.env.AGENT_MODEL ?? (USE_OPENROUTER ? "anthropic/claude-sonnet-5.5" : "claude-sonnet-5-5");
// Decisions are short and well-specified; low effort keeps a 34-client run fast.
const EFFORT = (process.env.AGENT_EFFORT ?? "low") as "low" | "medium" | "high";
const CONCURRENCY = 6;

const ACTION_TYPES = Object.keys(ACTION_CATALOG) as [ActionType, ...ActionType[]];
const TARGETS = Object.keys(ESCALATION_LABEL) as [EscalationTarget, ...EscalationTarget[]];

const ProposedAction = z.object({
  type: z.enum(ACTION_TYPES),
  policy_id: z.string().nullable(),
  title: z.string().describe("Short imperative, e.g. 'Call before P0252 lapses on 13 Sep'"),
  rationale: z.string().describe("1-2 sentences: why this action, referencing guard/signal codes"),
  channel: z.enum(["whatsapp", "email", "phone", "in_person"]).nullable(),
  message_native: z.string().nullable().describe("draft_retention_outreach only: message in the client's preferred language"),
  message_english: z.string().nullable().describe("draft_retention_outreach only: English version for the advisor"),
  talking_points: z.array(z.string()).describe("For tasks / cross-sell briefs: 2-4 concise points. Empty otherwise."),
  escalate_to: z.enum(TARGETS).nullable(),
  due_date: z.string().nullable().describe("YYYY-MM-DD for tasks and escalations"),
});

const Decision = z.object({
  priority: z.enum(["critical", "high", "medium", "low"]),
  summary: z.string().describe("One line (<=110 chars) for the advisor's board"),
  situation: z.string().describe("2-4 sentences explaining your judgment"),
  actions: z.array(ProposedAction),
});

const SYSTEM = `You are the decisioning engine of Hupo's Retention & Cross-Sell agent. You work one client at a time from a financial consultant's book at a Singapore life insurer (agency channel). The book's as-of date is ${AS_OF}; treat that as today.

For each client you receive their profile, policies, recent interactions, and a GOVERNANCE ENVELOPE computed by deterministic rules: guards (hard constraints), signals (opportunities), per-policy reminder eligibility, and the allowed/blocked action types. Decide what, if anything, to do.

ACTIONS
${Object.entries(ACTION_CATALOG).map(([k, v]) => `- ${k} [${v.tier}]: ${v.description}`).join("\n")}

GOVERNANCE (enforced by the harness after you respond; violations are blocked and logged against you)
${RULES.map((r) => `- ${r.code}: ${r.effect}`).join("\n")}
- Use only allowedActions. send_payment_reminder only for policies whose reminder eligibility is true, at most one per policy. Leave its message fields null — the approved template is rendered by the system.
- Client-facing text never recommends, names or prices a new product or a change in coverage — that is regulated financial advice reserved for a licensed representative. Retention drafts are limited to payment, reinstatement and booking a conversation/review.
- Cross-sell goes only in propose_cross_sell: an advisor-only brief framed as a needs-based conversation (the need, the evidence, what to fact-find), never a product pitch. One brief per client at most, and only when a signal genuinely supports it.
- If the servicing advisor is not the approver, address drafts and tasks to the approver named in the envelope.
- Respect allowedChannels. Prefer WhatsApp for drafts unless the client's history suggests otherwise.

JUDGMENT
- Retention first: money about to be lost beats new money. A grace-period policy lapsing within ~7 days warrants an advisor task to call (if phone allowed) in addition to any reminder.
- Lapsed policies: draft a reinstatement outreach for the advisor (reinstatement may require a health declaration — say so in talking points, don't promise reinstatement).
- When a client has already committed to pay by a date (PROMISE_TO_PAY), do not chase; create a task dated the day after the promised date to verify.
- Status-unverified policies: task the advisor to verify with policy admin today; no client contact.
- Escalate when a guard requires it, or when you see something a human must judge.
- The approval queue is the advisor's scarcest resource — precision over volume. draft_retention_outreach is for retention only: reinstating a lapsed policy, or a high-value at-risk premium where a personal note adds what the template can't. Inherited clients and overdue reviews get ONE create_advisor_task ("Introduce yourself / book review") with talking points — not a draft.
- Generic coverage gaps (GAP_HOSPITAL, GAP_CI) are talking points for a review task, never a cross-sell brief on their own.
- Drafts: short, warm, WhatsApp-length, in the client's preferred language with an English version, signed with the approver's first name. No pressure tactics, no guarantees.
- Be economical: 0-4 actions, one task can cover several items. Empty actions is fine when nothing is worth doing.
- priority: critical = lapse (or possible lapse) within 3 days; high = premium at risk within 14 days or lapsed; medium = review/cross-sell opportunity; low = nothing material.`;

let anthropic: Anthropic | null = null;

// Strict JSON schema for OpenRouter's structured outputs: every object closed.
function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) if (k !== "$schema") out[k] = strictSchema(v);
  if (out.type === "object") out.additionalProperties = false;
  return out;
}
const DECISION_SCHEMA = strictSchema(z.toJSONSchema(Decision));

function contextFor(book: Book, c: Client, env: Envelope) {
  const advisor = book.advisors.find((a) => a.advisor_id === c.servicing_advisor_id);
  return {
    client: {
      id: c.client_id, name: c.full_name, age: c.age, gender: c.gender, marital_status: c.marital_status, dependants: c.dependants,
      occupation: c.occupation, income_band_sgd: c.annual_income_band_sgd, smoker: c.smoker, preferred_language: c.preferred_language,
      marketing_consent: c.marketing_consent, do_not_call: c.do_not_call, status: c.client_status,
      last_annual_review: c.last_annual_review_date, life_event_note: c.life_event_note || null, merged_records: c.merged_client_ids,
    },
    servicing_advisor: advisor ? { id: advisor.advisor_id, name: advisor.name, unit: advisor.agency_unit, rnf_licence: advisor.rnf_licence, languages: advisor.languages } : null,
    approver: env.approver,
    policies: c.policies.map((p) => ({
      id: p.policy_id, type: p.product_type, product: p.product_name, status: p.status, sum_assured: p.sum_assured_sgd, annual_premium: p.annual_premium_sgd,
      frequency: p.premium_frequency, payment_method: p.payment_method, next_due: p.next_premium_due_date || null, days_past_due: p.days_past_due,
      days_to_lapse: p.days_to_lapse, lapse_date: p.lapse_date, missed_12m: p.missed_payments_12m, riders: p.riders, notes: p.notes || null,
      status_unverified: p.status_unverified || undefined,
    })),
    recent_interactions: c.interactions.slice(-6).map((i) => `${i.date} ${i.interaction_type} via ${i.channel} (${i.advisor_id}): ${i.outcome_notes}`),
    envelope: {
      guards: env.guards.map((g) => ({ code: g.code, detail: g.detail, blocks: g.blocks, requires_escalation_to: g.requiresEscalation ?? null })),
      signals: env.signals.map((s) => ({ kind: s.kind, code: s.code, policy_id: s.policy_id ?? null, detail: `${s.label}. ${s.detail}` })),
      reminder_eligibility: env.reminderEligibility,
      allowedActions: env.allowedActions,
      blockedActions: env.blockedActions,
      allowedChannels: env.allowedChannels,
    },
  };
}

type Usage = Run["usage"];

async function decide(book: Book, c: Client, env: Envelope, usage: Usage): Promise<z.infer<typeof Decision>> {
  const user = JSON.stringify(contextFor(book, c, env));
  if (USE_OPENROUTER) return decideOpenRouter(user, usage);
  anthropic ??= new Anthropic();
  const response = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
    output_config: { effort: EFFORT, format: zodOutputFormat(Decision) },
  });
  usage.input_tokens += response.usage.input_tokens;
  usage.output_tokens += response.usage.output_tokens;
  usage.cache_read_input_tokens += response.usage.cache_read_input_tokens ?? 0;
  if (response.stop_reason === "refusal") throw new Error("Model declined to decide");
  if (!response.parsed_output) throw new Error(`No parseable decision (stop_reason ${response.stop_reason})`);
  return response.parsed_output;
}

// Retry transient failures (network drops, 429, 5xx) with backoff; anything else surfaces.
async function fetchWithRetry(url: string, init: RequestInit, attempts = 4): Promise<Response> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, init);
      if ((res.status === 429 || res.status >= 500) && i < attempts) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      if (i >= attempts) throw new Error(`${err instanceof Error ? err.message : err}${cause ? ` (${cause})` : ""} after ${attempts} attempts`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

async function decideOpenRouter(user: string, usage: Usage) {
  const res = await fetchWithRetry("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "x-title": "Hupo Retention Agent",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      reasoning: { effort: EFFORT },
      messages: [
        { role: "system", content: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }] },
        { role: "user", content: user },
      ],
      response_format: { type: "json_schema", json_schema: { name: "decision", strict: true, schema: DECISION_SCHEMA } },
    }),
  });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(`OpenRouter ${res.status}: ${body.error?.message ?? "request failed"}`);
  usage.input_tokens += body.usage?.prompt_tokens ?? 0;
  usage.output_tokens += body.usage?.completion_tokens ?? 0;
  usage.cache_read_input_tokens += body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const choice = body.choices?.[0];
  if (choice?.finish_reason === "refusal" || choice?.native_finish_reason === "refusal") throw new Error("Model declined to decide");
  const parsed = Decision.safeParse(JSON.parse(choice?.message?.content ?? "null"));
  if (!parsed.success) throw new Error(`No valid decision (finish_reason ${choice?.finish_reason})`);
  return parsed.data;
}

let seq = 0;
const newId = (runId: string) => `${runId}-${String(++seq).padStart(4, "0")}`;

// Guardrail: turn the model's proposals into actions the harness will actually allow.
function enforce(book: Book, run: Run, c: Client, env: Envelope, proposed: z.infer<typeof ProposedAction>[]): AgentAction[] {
  const out: AgentAction[] = [];
  const reminded = new Set<string>();
  const base = (p: z.infer<typeof ProposedAction>, origin: AgentAction["origin"]): AgentAction => ({
    id: newId(run.id), run_id: run.id, client_id: c.client_id, client_name: c.full_name, type: p.type, tier: ACTION_CATALOG[p.type].tier,
    origin, status: "pending_approval", policy_id: p.policy_id, title: p.title, rationale: p.rationale, channel: p.channel,
    language: null, message_native: p.message_native, message_english: p.message_english, talking_points: p.talking_points,
    escalate_to: p.escalate_to, due_date: p.due_date,
  });
  const block = (a: AgentAction, reason: string) => out.push({ ...a, status: "blocked", blocked_reason: reason });

  for (const p of proposed) {
    const a = base(p, "model");
    const blocked = env.blockedActions.find((b) => b.type === p.type);
    if (blocked) { block(a, `${ACTION_CATALOG[p.type].label} not permitted: ${blocked.reasons.join("; ")}`); continue; }

    if (p.type === "send_payment_reminder") {
      const elig = env.reminderEligibility.find((r) => r.policy_id === p.policy_id);
      const policy = c.policies.find((x) => x.policy_id === p.policy_id);
      if (!elig?.eligible || !policy) { block(a, elig ? elig.reason : `No reminder eligibility for ${p.policy_id ?? "unspecified policy"}`); continue; }
      if (reminded.has(policy.policy_id)) continue;
      reminded.add(policy.policy_id);
      const msg = renderReminder(c, policy);
      out.push({ ...a, channel: c.do_not_call ? "email" : "whatsapp", language: c.preferred_language, message_native: msg.native, message_english: msg.english, talking_points: [`Template ${TEMPLATE_ID}`], status: "executed" });
      continue;
    }
    if (p.type === "draft_retention_outreach") {
      if (p.channel && !env.allowedChannels.includes(p.channel)) { block(a, `Channel '${p.channel}' not permitted (DNC)`); continue; }
      if (!p.message_native) { block(a, "Draft has no message"); continue; }
      out.push({ ...a, language: c.preferred_language, status: "pending_approval" });
      continue;
    }
    if (p.type === "escalate") {
      out.push({ ...a, escalate_to: p.escalate_to ?? "servicing_advisor", status: "open" });
      continue;
    }
    if (p.type === "propose_cross_sell") { out.push({ ...a, status: "pending_approval" }); continue; }
    out.push({ ...a, status: "executed" }); // create_advisor_task, flag_record
  }

  // Rule-mandated hand-offs the model didn't raise itself.
  for (const g of env.guards) {
    if (!g.requiresEscalation) continue;
    if (out.some((a) => a.type === "escalate" && a.escalate_to === g.requiresEscalation && a.status !== "blocked")) continue;
    const um = g.requiresEscalation === "unit_manager" ? unitManagerFor(book, c.servicing_advisor_id) : null;
    out.push({
      ...base({ type: "escalate", policy_id: null, title: `${g.label} — ${ESCALATION_LABEL[g.requiresEscalation]}${um ? ` (${um.name})` : ""}`, rationale: `Required by rule ${g.code}: ${g.detail}`, channel: null, message_native: null, message_english: null, talking_points: [], escalate_to: g.requiresEscalation, due_date: addDays(AS_OF, 2) }, "rule"),
      status: "open",
    });
  }
  return out;
}

export type RunEvent =
  | { type: "run_started"; run: Pick<Run, "id" | "scope" | "scope_label" | "model">; total: number }
  | { type: "client_started"; client_id: string; client_name: string }
  | { type: "client_done"; decision: ClientDecision; actions: AgentAction[] }
  | { type: "run_finished"; run: Run }
  | { type: "error"; message: string };

export async function runAgent(book: Book, scope: string, scopeLabel: string, clients: Client[], origin: string, emit: (e: RunEvent) => void): Promise<Run> {
  const run: Run = {
    id: `R${Date.now().toString(36).toUpperCase()}`, scope, scope_label: scopeLabel, model: MODEL, started_at: new Date().toISOString(),
    decisions: [], actions: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
  };
  emit({ type: "run_started", run: { id: run.id, scope, scope_label: scopeLabel, model: MODEL }, total: clients.length });

  const queue = [...clients];
  const deferred: Client[] = [];
  async function worker(final = false) {
    const source = final ? deferred : queue;
    for (let c = source.shift(); c; c = source.shift()) {
      emit({ type: "client_started", client_id: c.client_id, client_name: c.full_name });
      const env = buildEnvelope(book, c);
      const t0 = Date.now();
      let decision: ClientDecision;
      let actions: AgentAction[];
      const hasWork = env.guards.length > 0 || env.signals.some((s) => s.kind === "retention" || s.code === "LIFE_EVENT" || s.code === "INHERITED_CLIENT" || s.code === "REVIEW_OVERDUE");
      if (!hasWork) {
        decision = { client_id: c.client_id, client_name: c.full_name, priority: "low", summary: "Nothing material — no model call needed", situation: "No guards, no retention risk, review current. Skipped the model to save cost and noise.", envelope: env, model_called: false };
        actions = [];
      } else {
        try {
          const d = await decide(book, c, env, run.usage);
          decision = { client_id: c.client_id, client_name: c.full_name, priority: d.priority, summary: d.summary, situation: d.situation, envelope: env, model_called: true, latency_ms: Date.now() - t0 };
          actions = enforce(book, run, c, env, d.actions);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Network drops under concurrency: retry once more at the end, one at a time.
          if (!final && /fetch failed|ECONNRESET|HTTP 5\d\d|HTTP 429/.test(message)) { deferred.push(c); continue; }
          // Fail safe: if the model can't decide, nothing goes to the client; a human reviews.
          decision = { client_id: c.client_id, client_name: c.full_name, priority: "high", summary: "Agent could not decide — routed for manual review", situation: message, envelope: env, model_called: true, model_error: message, latency_ms: Date.now() - t0 };
          actions = enforce(book, run, c, env, [{ type: "escalate", policy_id: null, title: "Manual review — agent decision failed", rationale: message, channel: null, message_native: null, message_english: null, talking_points: [], escalate_to: "servicing_advisor", due_date: AS_OF }]);
        }
      }
      for (const a of actions) {
        if (a.status === "executed" || a.status === "open") {
          a.endpoint = await dispatch(origin, a, "agent");
          a.executed_at = new Date().toISOString();
        }
      }
      run.decisions.push(decision);
      run.actions.push(...actions);
      emit({ type: "client_done", decision, actions });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await worker(true);
  run.finished_at = new Date().toISOString();
  emit({ type: "run_finished", run });
  return run;
}
