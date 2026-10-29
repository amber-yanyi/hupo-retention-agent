import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import type { Advisor, Book, Client, DataIssue, Interaction, Lang, Policy } from "./types";
import { AS_OF, GRACE_DAYS, addDays, daysBetween } from "./dates";

const RAW_DIR = path.join(process.cwd(), "data", "raw");

function readCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(path.join(RAW_DIR, file), "utf8");
  return parse(text, { columns: true, skip_empty_lines: true, trim: true });
}

const num = (v: string) => (v === "" || v == null ? 0 : Number(v));
const list = (v: string) => (v ? v.split(";").map((s) => s.trim()).filter(Boolean) : []);
const titleCase = (s: string) =>
  s
    .toLowerCase()
    .split(" ")
    .map((w) => (w === "bin" || w === "binti" ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/D'souza/g, "D'Souza");

let cached: Book | null = null;

export function loadBook(): Book {
  if (cached) return cached;
  const issues: DataIssue[] = [];
  const issue = (i: Omit<DataIssue, "id">) => issues.push({ id: `DQ${String(issues.length + 1).padStart(2, "0")}`, ...i });

  const advisors: Advisor[] = readCsv("advisors.csv").map((r) => ({
    advisor_id: r.advisor_id,
    name: r.name,
    agency_unit: r.agency_unit,
    tenure_years: num(r.tenure_years),
    status: r.status as Advisor["status"],
    rnf_licence: r.rnf_licence as Advisor["rnf_licence"],
    languages: list(r.languages) as Lang[],
    role: r.role as Advisor["role"],
  }));
  const advisorById = new Map(advisors.map((a) => [a.advisor_id, a]));

  for (const a of advisors) {
    if (a.rnf_licence !== "active" && a.status === "active")
      issue({ severity: "high", entity: a.advisor_id, issue: `${a.name} is active but RNF licence is ${a.rnf_licence}`, handling: "Advisor cannot give advice. Their clients still receive factual servicing reminders; every advisory action is routed to the Unit Manager." });
  }
  for (const unit of new Set(advisors.map((a) => a.agency_unit))) {
    if (!advisors.some((a) => a.agency_unit === unit && a.role === "Unit Manager" && a.status === "active"))
      issue({ severity: "medium", entity: unit, issue: `${unit} has no Unit Manager on record`, handling: "Escalations for this unit go to the Agency Ops queue (assumption — to confirm with the insurer)." });
  }

  const interactions: Interaction[] = readCsv("interactions.csv").map((r) => ({
    interaction_id: r.interaction_id,
    client_id: r.client_id,
    advisor_id: r.advisor_id,
    date: r.date,
    channel: r.channel,
    interaction_type: r.interaction_type,
    outcome_notes: r.outcome_notes,
  }));

  const policies: Policy[] = readCsv("policies.csv").map((r) => {
    const dpd = num(r.days_past_due);
    const due = r.next_premium_due_date;
    let status_unverified = false;
    let implied: number | null = null;
    // Source says in force but the due date has passed. If no payment since the due date, it may
    // really be overdue; if paid after it, the due date likely just wasn't rolled forward.
    if (r.status === "inforce" && due && due < AS_OF) {
      status_unverified = true;
      if (!r.last_premium_paid_date || r.last_premium_paid_date < due) implied = daysBetween(due, AS_OF);
    }
    if (/mismatch/i.test(r.notes)) status_unverified = true;
    const inGrace = r.status === "grace_period";
    return {
      policy_id: r.policy_id,
      client_id: r.client_id,
      writing_advisor_id: r.writing_advisor_id,
      product_type: r.product_type,
      product_name: r.product_name,
      sum_assured_sgd: num(r.sum_assured_sgd),
      annual_premium_sgd: num(r.annual_premium_sgd),
      premium_frequency: r.premium_frequency,
      payment_method: r.payment_method,
      inception_date: r.inception_date,
      next_anniversary_date: r.next_anniversary_date,
      next_premium_due_date: due,
      status: r.status,
      days_past_due: dpd,
      missed_payments_12m: num(r.missed_payments_12m),
      last_premium_paid_date: r.last_premium_paid_date,
      riders: list(r.riders),
      surrender_value_sgd: num(r.surrender_value_sgd),
      notes: r.notes,
      // Grace is 30 days; the policy lapses on day 31.
      days_to_lapse: inGrace ? GRACE_DAYS + 1 - dpd : null,
      lapse_date: inGrace && due ? addDays(due, GRACE_DAYS + 1) : null,
      status_unverified,
      implied_days_past_due: implied,
    };
  });

  for (const p of policies) {
    if (p.status_unverified)
      issue(
        p.implied_days_past_due != null
          ? { severity: "high", entity: p.policy_id, issue: `Status 'inforce' but premium due ${p.next_premium_due_date} unpaid for ${p.implied_days_past_due} days`, handling: "Counted as premium at risk. No automated client contact; advisor verifies with policy admin today." }
          : { severity: "medium", entity: p.policy_id, issue: `Next due date ${p.next_premium_due_date || "—"} not rolled forward after payment on ${p.last_premium_paid_date} (source flags a sync mismatch)`, handling: "Likely current. No automated client contact until policy admin confirms; flagged to data team." },
      );
    if (p.status === "lapsed" && p.days_past_due <= GRACE_DAYS)
      issue({ severity: "low", entity: p.policy_id, issue: `Lapsed at ${p.days_past_due} days past due, inside the grace window`, handling: "Treated as lapsed per source system." });
  }

  const rawClients = readCsv("clients.csv");
  const clients: Client[] = rawClients.map((r) => {
    const name = titleCase(r.full_name);
    if (name !== r.full_name)
      issue({ severity: "low", entity: r.client_id, issue: `Name casing '${r.full_name}'`, handling: `Normalised to '${name}'.` });
    if (r.servicing_advisor_id && !advisorById.has(r.servicing_advisor_id))
      issue({ severity: "high", entity: r.client_id, issue: `Unknown servicing advisor ${r.servicing_advisor_id}`, handling: "Treated as unassigned." });
    return {
      client_id: r.client_id,
      full_name: name,
      dob: r.dob,
      age: Math.floor(daysBetween(r.dob, AS_OF) / 365.25),
      gender: r.gender,
      marital_status: r.marital_status,
      dependants: num(r.dependants),
      occupation: r.occupation,
      annual_income_band_sgd: r.annual_income_band_sgd,
      smoker: r.smoker === "Y",
      preferred_language: r.preferred_language as Lang,
      marketing_consent: r.marketing_consent === "Y",
      do_not_call: r.do_not_call === "Y",
      servicing_advisor_id: r.servicing_advisor_id && advisorById.has(r.servicing_advisor_id) ? r.servicing_advisor_id : null,
      last_annual_review_date: r.last_annual_review_date || null,
      life_event_note: r.life_event_note,
      client_status: r.client_status as Client["client_status"],
      merged_client_ids: [],
      policies: policies.filter((p) => p.client_id === r.client_id),
      interactions: interactions.filter((i) => i.client_id === r.client_id).sort((a, b) => a.date.localeCompare(b.date)),
    };
  });

  // De-duplicate: same normalised name + DOB is treated as the same person.
  // Most restrictive consent wins; policies and interactions are combined under the lower ID.
  const byKey = new Map<string, Client>();
  const deduped: Client[] = [];
  for (const c of clients) {
    const key = `${c.full_name.toLowerCase()}|${c.dob}`;
    const primary = byKey.get(key);
    if (!primary) {
      byKey.set(key, c);
      deduped.push(c);
      continue;
    }
    primary.merged_client_ids.push(c.client_id);
    const consentConflict = primary.marketing_consent !== c.marketing_consent || primary.do_not_call !== c.do_not_call;
    primary.marketing_consent = primary.marketing_consent && c.marketing_consent;
    primary.do_not_call = primary.do_not_call || c.do_not_call;
    primary.policies.push(...c.policies);
    primary.interactions.push(...c.interactions);
    primary.interactions.sort((a, b) => a.date.localeCompare(b.date));
    issue({
      severity: "high",
      entity: `${primary.client_id} / ${c.client_id}`,
      issue: `Duplicate client record (same name and DOB)${consentConflict ? " with conflicting consent flags" : ""}`,
      handling: `Merged under ${primary.client_id} for decisioning; most restrictive consent applied (marketing consent ${primary.marketing_consent ? "Y" : "N"}). Flagged to data team to merge at source.`,
    });
  }

  for (const c of deduped) {
    if (c.client_status === "deceased" && c.policies.some((p) => ["inforce", "grace_period"].includes(p.status)))
      issue({ severity: "high", entity: c.client_id, issue: "Deceased client still has policies showing in force / in grace", handling: "All outreach suppressed. Handed to Claims & Servicing to close out remaining policies." });
    if (/^(Lawyer|Doctor)$/.test(c.occupation) && c.annual_income_band_sgd === "<30k")
      issue({ severity: "medium", entity: c.client_id, issue: `Income band <30k looks inconsistent with occupation '${c.occupation}'`, handling: "Income treated as unreliable. Any cross-sell requires a refreshed fact-find first." });
    if (c.last_annual_review_date && c.last_annual_review_date > AS_OF)
      issue({ severity: "low", entity: c.client_id, issue: "Annual review date is in the future", handling: "Ignored." });
  }

  cached = { asOf: AS_OF, advisors, clients: deduped, issues };
  return cached;
}

export function advisorName(book: Book, id: string | null) {
  return id ? book.advisors.find((a) => a.advisor_id === id)?.name ?? id : "Unassigned";
}

export function clientsInScope(book: Book, scope: string): Client[] {
  if (scope === "ALL") return book.clients;
  if (scope === "UNASSIGNED") return book.clients.filter((c) => !c.servicing_advisor_id);
  return book.clients.filter((c) => c.servicing_advisor_id === scope);
}

export function lastInteractionWithin(c: Client, types: string[], days: number) {
  return [...c.interactions].reverse().find((i) => types.includes(i.interaction_type) && daysBetween(i.date, AS_OF) <= days);
}

export { addDays };
