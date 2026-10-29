// Governance policy as code. These rules run BEFORE the model and are re-checked AFTER it.
// The model may choose fewer or more conservative actions than the envelope allows — never more.

import type { ActionType, Book, Client, Envelope, EscalationTarget, Guard, ReminderEligibility, Signal, Tier } from "./types";
import { AS_OF, daysBetween } from "./dates";
import { lastInteractionWithin } from "./data";

export const ACTION_CATALOG: Record<ActionType, { tier: Tier; label: string; clientFacing: boolean; description: string }> = {
  send_payment_reminder: {
    tier: "autonomous",
    label: "Payment reminder (approved template)",
    clientFacing: true,
    description: "Factual grace-period reminder using a compliance-approved template. No product content, no advice. Sent as the insurer, advisor copied.",
  },
  create_advisor_task: {
    tier: "autonomous",
    label: "Advisor task",
    clientFacing: false,
    description: "Internal task in the advisor's CRM queue with due date and context.",
  },
  flag_record: {
    tier: "autonomous",
    label: "CRM flag / note",
    clientFacing: false,
    description: "Internal flag or note on the client record (e.g. data-quality issue, contact snooze).",
  },
  draft_retention_outreach: {
    tier: "recommend",
    label: "Retention outreach draft",
    clientFacing: true,
    description: "Personalised message or call script drafted for the advisor. Sent only after the advisor approves it.",
  },
  propose_cross_sell: {
    tier: "recommend",
    label: "Cross-sell opportunity",
    clientFacing: false,
    description: "Advisor-only brief on a needs-based conversation to have. The agent never recommends a product to a client — that is regulated advice.",
  },
  escalate: {
    tier: "handoff",
    label: "Hand to a human",
    clientFacing: false,
    description: "The agent steps back. A named human owns the next step; the agent takes no client-facing action.",
  },
};

export const ESCALATION_LABEL: Record<EscalationTarget, string> = {
  servicing_advisor: "Servicing advisor (personal handling)",
  unit_manager: "Unit Manager",
  agency_ops: "Agency Ops",
  compliance: "Compliance",
  customer_care: "Customer Care",
  claims: "Claims & Servicing",
  data_team: "CRM data team",
};

const ALL_CLIENT_FACING: ActionType[] = ["send_payment_reminder", "draft_retention_outreach"];
const ADVISORY: ActionType[] = ["draft_retention_outreach", "propose_cross_sell"];

// Rule catalogue, shown verbatim in the Guardrails tab.
export const RULES: { code: string; label: string; when: string; effect: string }[] = [
  { code: "DECEASED", label: "Client deceased", when: "client_status = deceased", effect: "No client contact of any kind. Hand to Claims & Servicing." },
  { code: "OPEN_COMPLAINT", label: "Open complaint", when: "Complaint interaction marked OPEN", effect: "Freeze all outreach and cross-sell. Hand to Customer Care." },
  { code: "SENSITIVE", label: "Sensitive circumstances", when: "Recent CI/death claim or 'handle with care' note", effect: "No automated contact, no cross-sell. Servicing advisor handles personally." },
  { code: "ADVISOR_UNLICENSED", label: "Advisor not licensed", when: "Servicing advisor RNF ≠ active", effect: "Factual reminders still go. Retention drafts are approved by the Unit Manager; no cross-sell until the client is reassigned." },
  { code: "UNASSIGNED", label: "No servicing advisor", when: "servicing_advisor_id blank", effect: "Nobody can approve drafts. Factual reminders still go. Agency Ops assigns an advisor." },
  { code: "NO_MARKETING_CONSENT", label: "No marketing consent (PDPA)", when: "marketing_consent = N", effect: "No cross-sell. Servicing messages only." },
  { code: "DNC", label: "Do-not-call", when: "do_not_call = Y", effect: "No phone channel. No marketing. Written servicing messages only." },
  { code: "PRODUCT_OPT_OUT", label: "Asked not to be approached", when: "Interaction notes an opt-out from new products", effect: "No cross-sell until the stated date. Retention still allowed." },
  { code: "AFFORDABILITY", label: "Affordability concern", when: "Insurer flagged premium vs income in policy notes", effect: "No cross-sell. Suitability review by Compliance." },
  { code: "PROMISE_TO_PAY", label: "Client already committed to pay", when: "Recent lapse follow-up with a promised date before the lapse date", effect: "No reminder before the promised date. Task to verify on the day after." },
  { code: "RECENTLY_REMINDED", label: "Contact frequency cap", when: "Payment reminder or lapse follow-up in the last 7 days", effect: "No further automated reminder." },
  { code: "STATUS_UNVERIFIED", label: "Policy status unverified", when: "Status in force but due date passed with no payment", effect: "No automated contact on that policy. Advisor verifies with policy admin." },
  { code: "DUPLICATE_RECORD", label: "Duplicate client record", when: "Same name + DOB on two IDs", effect: "Most restrictive consent applies. Data team merges at source." },
];

const INCOME_MID: Record<string, number> = { "<30k": 25000, "30-60k": 45000, "60-100k": 80000, "100-150k": 125000, "150-250k": 200000, ">250k": 300000 };

export function buildEnvelope(book: Book, c: Client): Envelope {
  const guards: Guard[] = [];
  const signals: Signal[] = [];
  const advisor = book.advisors.find((a) => a.advisor_id === c.servicing_advisor_id) ?? null;

  // ---- Guards (hard constraints) ----
  if (c.client_status === "deceased")
    guards.push({ code: "DECEASED", label: "Client deceased", detail: c.life_event_note || "Recorded as deceased", blocks: [...ALL_CLIENT_FACING, "propose_cross_sell"], requiresEscalation: "claims" });

  const complaint = c.interactions.find((i) => i.interaction_type === "complaint" && /OPEN/i.test(i.outcome_notes));
  if (complaint)
    guards.push({ code: "OPEN_COMPLAINT", label: "Open complaint", detail: `${complaint.date}: ${complaint.outcome_notes}`, blocks: [...ALL_CLIENT_FACING, "propose_cross_sell"], requiresEscalation: "customer_care" });

  const sensitive = c.interactions.find((i) => /handle with care/i.test(i.outcome_notes)) ||
    (c.client_status === "active" && c.policies.find((p) => p.status === "claim_paid" && p.notes && daysBetween(p.notes.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "2000-01-01", AS_OF) <= 180));
  if (sensitive && c.client_status !== "deceased")
    guards.push({ code: "SENSITIVE", label: "Sensitive circumstances", detail: "outcome_notes" in sensitive ? sensitive.outcome_notes : `Recent claim on ${sensitive.policy_id}: ${sensitive.notes}`, blocks: ["send_payment_reminder", "propose_cross_sell"], requiresEscalation: c.servicing_advisor_id ? "servicing_advisor" : "agency_ops" });

  if (advisor && advisor.rnf_licence !== "active")
    guards.push({ code: "ADVISOR_UNLICENSED", label: "Advisor not licensed", detail: `${advisor.name}'s RNF licence is ${advisor.rnf_licence}; retention drafts go to the Unit Manager for approval, cross-sell waits for reassignment`, blocks: ["propose_cross_sell"], requiresEscalation: "unit_manager" });

  if (!c.servicing_advisor_id)
    guards.push({ code: "UNASSIGNED", label: "No servicing advisor", detail: "Client has no servicing advisor on record", blocks: ADVISORY, requiresEscalation: "agency_ops" });

  if (!c.marketing_consent)
    guards.push({ code: "NO_MARKETING_CONSENT", label: "No marketing consent", detail: "PDPA marketing consent = N", blocks: ["propose_cross_sell"] });

  if (c.do_not_call)
    guards.push({ code: "DNC", label: "Do-not-call", detail: "On DNC registry or asked not to be called", blocks: ["propose_cross_sell"] });

  const optOut = c.interactions.find((i) => /not to be approached about new products until (\d{4})/i.test(i.outcome_notes));
  if (optOut) {
    const until = optOut.outcome_notes.match(/until (\d{4})/i)![1];
    if (AS_OF < `${until}-01-01`)
      guards.push({ code: "PRODUCT_OPT_OUT", label: `No new products until ${until}`, detail: `${optOut.date}: ${optOut.outcome_notes}`, blocks: ["propose_cross_sell"] });
  }

  const activePremium = c.policies.filter((p) => ["inforce", "grace_period"].includes(p.status)).reduce((s, p) => s + p.annual_premium_sgd, 0);
  const incomeMid = INCOME_MID[c.annual_income_band_sgd];
  const ratio = incomeMid ? activePremium / incomeMid : 0;
  // Hard guard only on the insurer's own suitability flag; a high ratio against a (possibly stale)
  // income band is a signal that the fact-find must be refreshed before any needs conversation.
  const affordabilityNote = c.policies.find((p) => /% of stated income/i.test(p.notes));
  if (affordabilityNote)
    guards.push({
      code: "AFFORDABILITY",
      label: "Affordability concern",
      detail: `${affordabilityNote.policy_id}: ${affordabilityNote.notes} (active premiums SGD ${activePremium.toLocaleString()} vs income band ${c.annual_income_band_sgd})`,
      blocks: ["propose_cross_sell"],
      requiresEscalation: "compliance",
    });

  if (c.merged_client_ids.length)
    guards.push({ code: "DUPLICATE_RECORD", label: "Duplicate record merged", detail: `Same person as ${c.merged_client_ids.join(", ")}; most restrictive consent applied`, blocks: [], requiresEscalation: "data_team" });

  // ---- Reminder eligibility per grace-period policy ----
  const reminded = lastInteractionWithin(c, ["payment_reminder", "lapse_follow_up"], 7);
  const reminderEligibility: ReminderEligibility[] = [];
  for (const p of c.policies) {
    if (p.status !== "grace_period" && !p.status_unverified) continue;
    const blockedBy = guards.filter((g) => g.blocks.includes("send_payment_reminder")).map((g) => g.label);
    let reason = "";
    if (blockedBy.length) reason = `Blocked: ${blockedBy.join(", ")}`;
    else if (p.status_unverified) reason = "Blocked: policy status unverified (STATUS_UNVERIFIED)";
    else {
      const promise = c.interactions.find((i) => i.interaction_type === "lapse_follow_up" && i.outcome_notes.includes(p.policy_id) && /by (\d{4}-\d{2}-\d{2})/.test(i.outcome_notes));
      const promisedBy = promise?.outcome_notes.match(/by (\d{4}-\d{2}-\d{2})/)?.[1];
      if (promisedBy && promisedBy >= AS_OF && p.lapse_date && promisedBy < p.lapse_date)
        reason = `Snoozed: client committed on ${promise!.date} to fix payment by ${promisedBy} (lapse ${p.lapse_date}) (PROMISE_TO_PAY)`;
      else if (reminded) reason = `Snoozed: ${reminded.interaction_type.replace(/_/g, " ")} on ${reminded.date} (RECENTLY_REMINDED)`;
    }
    reminderEligibility.push({ policy_id: p.policy_id, eligible: !reason, reason: reason || "Eligible: in grace, no blocking guard, not recently contacted" });
  }

  // ---- Signals (opportunities) ----
  for (const p of c.policies) {
    if (p.status === "grace_period")
      signals.push({ kind: "retention", code: "IN_GRACE", policy_id: p.policy_id, label: `${p.product_type} in grace — lapses in ${p.days_to_lapse}d`, detail: `${p.days_past_due} days past due (due ${p.next_premium_due_date}), lapses ${p.lapse_date}. SGD ${p.annual_premium_sgd.toLocaleString()}/yr via ${p.payment_method}. ${p.missed_payments_12m} missed in 12m. ${p.notes}`.trim() });
    else if (p.status === "lapsed")
      signals.push({ kind: "retention", code: "LAPSED", policy_id: p.policy_id, label: `${p.product_type} lapsed ${p.days_past_due - 30}d ago`, detail: `Lapsed after ${p.next_premium_due_date} due date. SGD ${p.annual_premium_sgd.toLocaleString()}/yr. Reinstatement may need fresh health declaration — advisor-led.` });
    else if (p.status_unverified)
      signals.push(p.implied_days_past_due != null
        ? { kind: "retention", code: "STATUS_UNVERIFIED", policy_id: p.policy_id, label: `${p.product_type} may be overdue`, detail: `Shows in force, but premium due ${p.next_premium_due_date} has no payment since (${p.implied_days_past_due}d). If truly unpaid it lapses ~${31 - p.implied_days_past_due}d from now.` }
        : { kind: "servicing", code: "STATUS_UNVERIFIED", policy_id: p.policy_id, label: `${p.product_type}: source status mismatch`, detail: `Paid ${p.last_premium_paid_date} but next due still shows ${p.next_premium_due_date}. Likely current; verify before any contact. ${p.notes}` });
    else if (p.status === "inforce" && p.missed_payments_12m >= 2)
      signals.push({ kind: "retention", code: "PAYMENT_PATTERN", policy_id: p.policy_id, label: `${p.product_type}: ${p.missed_payments_12m} missed payments in 12m`, detail: `Pays by ${p.payment_method}; next due ${p.next_premium_due_date}. ${p.notes}`.trim() });
  }

  const life = c.life_event_note && !/reassigned|death claim|CI claim/i.test(c.life_event_note) ? c.life_event_note : "";
  if (life && /diagnos/i.test(life))
    signals.push({ kind: "servicing", code: "HEALTH_NOTE", label: "Health information on file", detail: `${life}. Health data is not a sales trigger; it affects underwriting and must not be used for marketing.` });
  else if (life) signals.push({ kind: "cross_sell", code: "LIFE_EVENT", label: "Life event", detail: life });
  if (c.client_status === "active" && ratio >= 0.25 && !affordabilityNote)
    signals.push({ kind: "servicing", code: "FACT_FIND_STALE", label: `Premiums ~${Math.round(ratio * 100)}% of stated income`, detail: `Active premiums SGD ${activePremium.toLocaleString()} vs income band ${c.annual_income_band_sgd}. Income on file may be stale — refresh fact-find before any needs conversation.` });
  if (/reassigned from departed advisor/i.test(c.life_event_note))
    signals.push({ kind: "servicing", code: "INHERITED_CLIENT", label: "Inherited from departed advisor", detail: c.life_event_note });

  const active = c.policies.filter((p) => ["inforce", "grace_period"].includes(p.status));
  const has = (t: string) => active.some((p) => p.product_type === t);
  if (c.client_status === "active") {
    if (!has("Hospitalisation (IP)")) signals.push({ kind: "cross_sell", code: "GAP_HOSPITAL", label: "No active hospitalisation plan", detail: c.policies.some((p) => p.product_type === "Hospitalisation (IP)" && p.status === "lapsed") ? "Hospitalisation plan has lapsed" : "No Integrated Shield plan on record" });
    if (c.dependants > 0 && !has("Term Life") && !has("Whole Life")) signals.push({ kind: "cross_sell", code: "GAP_LIFE", label: "Dependants but no life cover", detail: `${c.dependants} dependant(s)` });
    if (!has("Critical Illness") && !active.some((p) => p.riders.some((r) => /CI/.test(r)))) signals.push({ kind: "cross_sell", code: "GAP_CI", label: "No critical-illness protection", detail: "No CI plan or CI rider" });
    const lastReview = c.last_annual_review_date;
    if (!lastReview || daysBetween(lastReview, AS_OF) > 365)
      signals.push({ kind: "servicing", code: "REVIEW_OVERDUE", label: "Annual review overdue", detail: lastReview ? `Last review ${lastReview}` : "No review on record" });
    if (advisor && !advisor.languages.includes(c.preferred_language))
      signals.push({ kind: "servicing", code: "LANGUAGE_MISMATCH", label: `Prefers ${c.preferred_language}; advisor speaks ${advisor.languages.join("/")}`, detail: "Consider a co-servicing colleague or translated materials" });
    if (/relocat/i.test(c.life_event_note)) signals.push({ kind: "servicing", code: "RELOCATION", label: "Relocating overseas", detail: c.life_event_note });
  }

  // ---- Envelope ----
  const um = advisor ? book.advisors.find((a) => a.agency_unit === advisor.agency_unit && a.role === "Unit Manager" && a.status === "active") : null;
  const approver = advisor && advisor.rnf_licence === "active" && advisor.status === "active" ? { advisor_id: advisor.advisor_id, name: advisor.name } : um ? { advisor_id: um.advisor_id, name: `${um.name} (Unit Manager)` } : null;

  const blocked = new Map<ActionType, string[]>();
  for (const g of guards) for (const a of g.blocks) blocked.set(a, [...(blocked.get(a) ?? []), g.label]);
  if (!approver) for (const a of ADVISORY) blocked.set(a, [...(blocked.get(a) ?? []), "No licensed advisor to approve"]);
  if (!reminderEligibility.some((r) => r.eligible) && !blocked.has("send_payment_reminder"))
    blocked.set("send_payment_reminder", ["No grace-period policy eligible for an automated reminder"]);
  const allowedActions = (Object.keys(ACTION_CATALOG) as ActionType[]).filter((a) => !blocked.has(a));

  const premiumAtRisk = c.policies
    .filter((p) => (p.status === "grace_period" || p.implied_days_past_due != null) && c.client_status === "active")
    .reduce((s, p) => s + p.annual_premium_sgd, 0);

  return {
    guards,
    signals,
    reminderEligibility,
    allowedActions,
    blockedActions: [...blocked].map(([type, reasons]) => ({ type, reasons })),
    allowedChannels: c.do_not_call ? ["whatsapp", "email"] : ["whatsapp", "email", "phone"],
    approver,
    premiumAtRisk,
  };
}

// Escalation target for a unit: the active UM, else Agency Ops.
export function unitManagerFor(book: Book, advisorId: string | null) {
  const adv = book.advisors.find((a) => a.advisor_id === advisorId);
  return adv ? book.advisors.find((a) => a.agency_unit === adv.agency_unit && a.role === "Unit Manager" && a.status === "active") ?? null : null;
}
