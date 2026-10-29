import { loadBook, clientsInScope } from "@/lib/data";
import { ACTION_CATALOG, ESCALATION_LABEL, RULES } from "@/lib/governance";
import { MODEL } from "@/lib/agent";
import { Dashboard, type Scope } from "@/components/dashboard";

export default function Page() {
  const book = loadBook();
  const scopes: Scope[] = [
    ...book.advisors
      .filter((a) => a.status === "active")
      .map((a) => ({
        id: a.advisor_id,
        label: a.name,
        sub: `${a.role} · ${a.agency_unit}`,
        clients: clientsInScope(book, a.advisor_id).length,
        advisor: a,
      })),
    { id: "UNASSIGNED", label: "Unassigned clients", sub: "Agency Ops queue", clients: clientsInScope(book, "UNASSIGNED").length, advisor: null },
  ];
  return (
    <Dashboard
      asOf={book.asOf}
      model={MODEL}
      scopes={scopes}
      issues={book.issues}
      rules={RULES}
      catalog={ACTION_CATALOG}
      escalationLabels={ESCALATION_LABEL}
    />
  );
}
