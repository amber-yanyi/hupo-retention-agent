// Local JSON persistence for the prototype. Production: CRM + append-only audit store.
import fs from "node:fs";
import path from "node:path";
import type { AgentAction, MockCall, Run } from "./types";

interface Store {
  runs: Run[];
  mockCalls: MockCall[];
}

const FILE = path.join(process.cwd(), ".data", "store.json");
const g = globalThis as unknown as { __store?: Store };

function load(): Store {
  if (g.__store) return g.__store;
  try {
    g.__store = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    g.__store = { runs: [], mockCalls: [] };
  }
  return g.__store!;
}

export function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(load(), null, 1));
}

export function addRun(run: Run) {
  const s = load();
  s.runs = [run, ...s.runs.filter((r) => r.id !== run.id)].slice(0, 20);
  save();
}

export function latestRun(scope: string) {
  return load().runs.find((r) => r.scope === scope && r.finished_at) ?? null;
}

export function findAction(id: string): { run: Run; action: AgentAction } | null {
  for (const run of load().runs) {
    const action = run.actions.find((a) => a.id === id);
    if (action) return { run, action };
  }
  return null;
}

export function recordMockCall(endpoint: string, payload: unknown) {
  const s = load();
  const call: MockCall = { id: `M${Date.now()}${Math.floor(Math.random() * 1000)}`, at: new Date().toISOString(), endpoint, payload };
  s.mockCalls = [call, ...s.mockCalls].slice(0, 500);
  save();
  return call;
}

export function mockCalls() {
  return load().mockCalls;
}

// Reminders the agent already sent (or an advisor approved) in the last 7 days, by policy.
export function recentAgentReminders(): Map<string, string> {
  const cutoff = Date.now() - 7 * 86_400_000;
  const out = new Map<string, string>();
  for (const run of load().runs)
    for (const a of run.actions)
      if (a.type === "send_payment_reminder" && a.policy_id && a.executed_at && Date.parse(a.executed_at) > cutoff && !out.has(a.policy_id))
        out.set(a.policy_id, new Date(a.executed_at).toLocaleString("en-SG"));
  return out;
}
