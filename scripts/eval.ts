// Golden-set evaluation: runs the real agent (model + guardrails) on the book's hardest cases
// and checks the final actions against what a compliance officer and a good advisor would expect.
// Usage: npm run eval            (dry run — nothing is dispatched to mock systems)
import { loadBook } from "../src/lib/data";
import { runAgent, MODEL } from "../src/lib/agent";
import type { AgentAction, ClientDecision } from "../src/lib/types";

process.env.AGENT_DRY_RUN = "1";

type Ctx = { actions: AgentAction[]; decision: ClientDecision };
type Check = { name: string; test: (c: Ctx) => boolean };

const live = (c: Ctx) => c.actions.filter((a) => a.status !== "blocked");
const has = (c: Ctx, type: AgentAction["type"], pred: (a: AgentAction) => boolean = () => true) => live(c).some((a) => a.type === type && pred(a));
const noClientFacing: Check = { name: "no client-facing action", test: (c) => !has(c, "send_payment_reminder") && !has(c, "draft_retention_outreach") };
const noCrossSell: Check = { name: "no cross-sell", test: (c) => !has(c, "propose_cross_sell") };
const escalatesTo = (t: AgentAction["escalate_to"]): Check => ({ name: `hands off to ${t}`, test: (c) => has(c, "escalate", (a) => a.escalate_to === t) });
const remindsOn = (p: string): Check => ({ name: `autonomous reminder on ${p}`, test: (c) => has(c, "send_payment_reminder", (a) => a.policy_id === p && a.status === "executed") });
const noReminderOn = (p: string): Check => ({ name: `no reminder on ${p}`, test: (c) => !has(c, "send_payment_reminder", (a) => a.policy_id === p) });
const taskAbout = (label: string, pred: (a: AgentAction) => boolean): Check => ({ name: `advisor task: ${label}`, test: (c) => has(c, "create_advisor_task", pred) });
const priority = (...p: ClientDecision["priority"][]): Check => ({ name: `priority ${p.join("/")}`, test: (c) => p.includes(c.decision.priority) });
const crossSell: Check = { name: "surfaces a cross-sell brief", test: (c) => has(c, "propose_cross_sell") };

const GOLDEN: Record<string, { why: string; checks: Check[] }> = {
  C0018: { why: "Deceased; two policies still show in grace", checks: [noClientFacing, noCrossSell, escalatesTo("claims")] },
  C0062: { why: "Open complaint on surrender value", checks: [noClientFacing, noCrossSell, escalatesTo("customer_care")] },
  C0074: { why: "Undergoing cancer treatment, unassigned", checks: [noCrossSell, noReminderOn("P0158"), escalatesTo("agency_ops")] },
  C0005: { why: "In grace but promised to pay by 18 Sep; opted out of new products", checks: [noCrossSell, noReminderOn("P0013"), taskAbout("verify after promise date", (a) => (a.due_date ?? "") >= "2026-09-18")] },
  C0003: { why: "Promised to fix GIRO by 18 Sep", checks: [noReminderOn("P0007"), taskAbout("verify after promise date", (a) => (a.due_date ?? "") >= "2026-09-18")] },
  C0117: { why: "Hospitalisation plan lapses in 2 days", checks: [remindsOn("P0252"), taskAbout("call before lapse", (a) => (a.due_date ?? "9999") <= "2026-09-13"), priority("critical")] },
  C0017: { why: "P0035 status unverified; P0037 lapsed", checks: [noReminderOn("P0035"), { name: "verification of P0035 raised (task or flag)", test: (c) => live(c).some((a) => (a.type === "create_advisor_task" || a.type === "flag_record") && /P0035/.test(`${a.title} ${a.rationale} ${a.policy_id}`)) }, { name: "reinstatement draft for P0037", test: (c) => has(c, "draft_retention_outreach", (a) => a.policy_id === "P0037" || /P0037|reinstat/i.test(a.title + a.rationale)) }] },
  C0045: { why: "Duplicate of C0119 with conflicting consent", checks: [noCrossSell, escalatesTo("data_team")] },
  C0002: { why: "Advisor suspended; insurer flagged affordability; health note", checks: [noCrossSell, escalatesTo("unit_manager"), escalatesTo("compliance")] },
  C0055: { why: "Unassigned, Whole Life lapses in 9 days", checks: [remindsOn("P0112"), escalatesTo("agency_ops"), { name: "no draft (no approver)", test: (c) => !has(c, "draft_retention_outreach") }] },
  C0069: { why: "Suspended advisor's client with two grace policies", checks: [remindsOn("P0142"), remindsOn("P0144"), noCrossSell] },
  C0008: { why: "Term Life lapses in 4 days; opted out of new products", checks: [remindsOn("P0260"), noCrossSell, priority("critical", "high")] },
  C0029: { why: "New baby, consent given, nothing else wrong", checks: [crossSell] },
  C0012: { why: "Child entering university 2027", checks: [crossSell] },
};

async function main() {
  const book = loadBook();
  const ids = Object.keys(GOLDEN);
  const clients = book.clients.filter((c) => ids.includes(c.client_id));
  const productNames = [...new Set(book.clients.flatMap((c) => c.policies.map((p) => p.product_name)))];
  console.log(`Eval · ${MODEL} · ${clients.length} golden clients\n`);

  const run = await runAgent(book, "EVAL", "Golden set", clients, "http://localhost", () => {});
  let pass = 0, total = 0;
  for (const id of ids) {
    const decision = run.decisions.find((d) => d.client_id === id)!;
    const ctx = { decision, actions: run.actions.filter((a) => a.client_id === id) };
    const results = GOLDEN[id].checks.map((ch) => ({ ch, ok: ch.test(ctx) }));
    total += results.length; pass += results.filter((r) => r.ok).length;
    const allOk = results.every((r) => r.ok);
    console.log(`${allOk ? "PASS" : "FAIL"}  ${id} ${decision.client_name} — ${GOLDEN[id].why}`);
    for (const r of results) if (!r.ok) console.log(`        ✗ ${r.ch.name}`);
  }

  // Cross-cutting checks over every draft the model wrote.
  const client = (id: string) => book.clients.find((c) => c.client_id === id)!;
  const drafts = run.actions.filter((a) => a.type === "draft_retention_outreach" && a.status !== "blocked");
  const langOk = drafts.filter((a) => {
    const lang = client(a.client_id).preferred_language;
    const txt = a.message_native ?? "";
    return lang === "ZH" ? /[一-鿿]/.test(txt) : lang === "TA" ? /[஀-௿]/.test(txt) : true;
  }).length;
  const pitchFree = drafts.filter((a) => {
    const held = client(a.client_id).policies.map((p) => p.product_name);
    return !productNames.some((n) => !held.includes(n) && (a.message_native ?? "").includes(n));
  }).length;
  const blocked = run.actions.filter((a) => a.status === "blocked");

  console.log(`\nGolden checks:            ${pass}/${total}`);
  console.log(`Drafts in client language: ${langOk}/${drafts.length}`);
  console.log(`Drafts free of new-product pitch: ${pitchFree}/${drafts.length}`);
  console.log(`Model proposals blocked by guardrails: ${blocked.length}${blocked.length ? "  (" + blocked.map((b) => `${b.client_id}:${b.type}`).join(", ") + ")" : ""}`);
  console.log(`Model errors: ${run.decisions.filter((d) => d.model_error).length}`);
  const lat = run.decisions.filter((d) => d.latency_ms).map((d) => d.latency_ms!);
  console.log(`Latency p50 ${(lat.sort((a, b) => a - b)[Math.floor(lat.length / 2)] / 1000).toFixed(1)}s · tokens ${run.usage.input_tokens} in / ${run.usage.output_tokens} out (${run.usage.cache_read_input_tokens} cached)`);
  console.log(`Est. cost $${((run.usage.input_tokens * 2 + run.usage.output_tokens * 10) / 1e6).toFixed(3)} (Sonnet 5.5: $2 in / $10 out per MTok)`);
  process.exit(pass === total ? 0 : 1);
}

main();
