// Prints the deterministic governance envelope for a set of clients (no model calls).
import { loadBook } from "../src/lib/data";
import { buildEnvelope } from "../src/lib/governance";

const book = loadBook();
const ids = process.argv.slice(2);
console.log(`Data issues: ${book.issues.length}`);
for (const c of book.clients.filter((c) => !ids.length || ids.includes(c.client_id))) {
  const e = buildEnvelope(book, c);
  console.log(`\n${c.client_id} ${c.full_name} [${c.servicing_advisor_id ?? "—"}] approver=${e.approver?.name ?? "none"} atRisk=${e.premiumAtRisk}`);
  e.guards.forEach((g) => console.log(`  GUARD ${g.code}: ${g.detail}${g.requiresEscalation ? ` -> ${g.requiresEscalation}` : ""}`));
  e.signals.forEach((s) => console.log(`  ${s.kind.toUpperCase()} ${s.code}: ${s.label}`));
  e.reminderEligibility.forEach((r) => console.log(`  REMIND ${r.policy_id}: ${r.reason}`));
  console.log(`  blocked: ${e.blockedActions.map((b) => b.type).join(", ") || "—"}`);
}
