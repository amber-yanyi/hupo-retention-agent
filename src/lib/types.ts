// Shared domain types for the Retention & Cross-Sell agent.

export type Lang = "EN" | "ZH" | "MS" | "TA";

export interface Advisor {
  advisor_id: string;
  name: string;
  agency_unit: string;
  tenure_years: number;
  status: "active" | "departed";
  rnf_licence: "active" | "suspended" | "ceased";
  languages: Lang[];
  role: "Financial Consultant" | "Unit Manager";
}

export interface Policy {
  policy_id: string;
  client_id: string;
  writing_advisor_id: string;
  product_type: string;
  product_name: string;
  sum_assured_sgd: number;
  annual_premium_sgd: number;
  premium_frequency: string;
  payment_method: string;
  inception_date: string;
  next_anniversary_date: string;
  next_premium_due_date: string;
  status: string;
  days_past_due: number;
  missed_payments_12m: number;
  last_premium_paid_date: string;
  riders: string[];
  surrender_value_sgd: number;
  notes: string;
  // Derived
  days_to_lapse: number | null; // grace-period policies only
  lapse_date: string | null;
  status_unverified: boolean; // source status disagrees with due dates
  implied_days_past_due: number | null;
}

export interface Interaction {
  interaction_id: string;
  client_id: string;
  advisor_id: string;
  date: string;
  channel: string;
  interaction_type: string;
  outcome_notes: string;
}

export interface Client {
  client_id: string;
  full_name: string;
  dob: string;
  age: number;
  gender: string;
  marital_status: string;
  dependants: number;
  occupation: string;
  annual_income_band_sgd: string;
  smoker: boolean;
  preferred_language: Lang;
  marketing_consent: boolean;
  do_not_call: boolean;
  servicing_advisor_id: string | null;
  last_annual_review_date: string | null;
  life_event_note: string;
  client_status: "active" | "deceased";
  // Derived / merged
  merged_client_ids: string[]; // other records judged to be the same person
  policies: Policy[];
  interactions: Interaction[];
}

export interface DataIssue {
  id: string;
  severity: "high" | "medium" | "low";
  entity: string; // e.g. "C0119" or "P0035"
  issue: string;
  handling: string;
}

export interface Book {
  asOf: string;
  advisors: Advisor[];
  clients: Client[]; // after de-duplication
  issues: DataIssue[];
}

// ---------- Governance ----------

export type Tier = "autonomous" | "recommend" | "handoff";

export type ActionType =
  | "send_payment_reminder"
  | "create_advisor_task"
  | "flag_record"
  | "draft_retention_outreach"
  | "propose_cross_sell"
  | "escalate";

export type EscalationTarget =
  | "servicing_advisor"
  | "unit_manager"
  | "agency_ops"
  | "compliance"
  | "customer_care"
  | "claims"
  | "data_team";

export interface Guard {
  code: string;
  label: string;
  detail: string;
  blocks: ActionType[];
  requiresEscalation?: EscalationTarget;
}

export interface Signal {
  kind: "retention" | "cross_sell" | "servicing";
  code: string;
  label: string;
  detail: string;
  policy_id?: string;
}

export interface ReminderEligibility {
  policy_id: string;
  eligible: boolean;
  reason: string;
}

export interface Envelope {
  guards: Guard[];
  signals: Signal[];
  reminderEligibility: ReminderEligibility[];
  allowedActions: ActionType[];
  blockedActions: { type: ActionType; reasons: string[] }[];
  allowedChannels: string[];
  approver: { advisor_id: string; name: string } | null; // who approves recommendations
  premiumAtRisk: number;
}

export type ActionStatus =
  | "executed" // autonomous, done
  | "pending_approval"
  | "approved"
  | "rejected"
  | "open" // handoff awaiting a human
  | "acknowledged"
  | "blocked"; // model proposed it, guardrail refused

export interface AgentAction {
  id: string;
  run_id: string;
  client_id: string;
  client_name: string;
  type: ActionType;
  tier: Tier;
  origin: "model" | "rule";
  status: ActionStatus;
  policy_id: string | null;
  title: string;
  rationale: string;
  channel: string | null;
  language: Lang | null;
  message_native: string | null;
  message_english: string | null;
  talking_points: string[];
  escalate_to: EscalationTarget | null;
  due_date: string | null;
  blocked_reason?: string;
  endpoint?: string; // mock endpoint hit
  executed_at?: string;
}

export interface ClientDecision {
  client_id: string;
  client_name: string;
  priority: "critical" | "high" | "medium" | "low";
  summary: string;
  situation: string;
  envelope: Envelope;
  model_called: boolean;
  model_error?: string;
  latency_ms?: number;
}

export interface Run {
  id: string;
  scope: string; // advisor id, "UNASSIGNED" or "ALL"
  scope_label: string;
  model: string;
  started_at: string;
  finished_at?: string;
  decisions: ClientDecision[];
  actions: AgentAction[];
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
}

export interface MockCall {
  id: string;
  at: string;
  endpoint: string;
  payload: unknown;
}
