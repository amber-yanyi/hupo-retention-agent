"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Ban, Bot, CheckCircle2, ClipboardList, Flag, Loader2, MessageSquareText, Play, Send, ShieldAlert,
  ShieldCheck, Sparkles, UserRound, ArrowRight, CircleDot, Languages,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { ActionType, Advisor, AgentAction, ClientDecision, DataIssue, EscalationTarget, Run, Tier } from "@/lib/types";
import type { RunEvent } from "@/lib/agent";

export interface Scope { id: string; label: string; sub: string; clients: number; advisor: Advisor | null }

interface Props {
  asOf: string;
  model: string;
  scopes: Scope[];
  issues: DataIssue[];
  rules: { code: string; label: string; when: string; effect: string }[];
  catalog: Record<ActionType, { tier: Tier; label: string; clientFacing: boolean; description: string }>;
  escalationLabels: Record<EscalationTarget, string>;
}

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;
const PRIORITY_STYLE: Record<string, string> = {
  critical: "bg-red-50 text-red-700 ring-red-600/20",
  high: "bg-orange-50 text-orange-700 ring-orange-600/20",
  medium: "bg-sky-50 text-sky-700 ring-sky-600/20",
  low: "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
};
const TYPE_META: Record<ActionType, { icon: typeof Send; verb: string }> = {
  send_payment_reminder: { icon: Send, verb: "Reminder sent" },
  create_advisor_task: { icon: ClipboardList, verb: "Task created" },
  flag_record: { icon: Flag, verb: "CRM flagged" },
  draft_retention_outreach: { icon: MessageSquareText, verb: "Outreach draft" },
  propose_cross_sell: { icon: Sparkles, verb: "Cross-sell brief" },
  escalate: { icon: UserRound, verb: "Hand-off" },
};
const TIER_META: Record<Tier, { title: string; sub: string; accent: string; dot: string; icon: typeof Bot }> = {
  autonomous: { title: "Done autonomously", sub: "Within pre-approved boundaries. Logged, reversible.", accent: "border-t-emerald-500", dot: "bg-emerald-500", icon: Bot },
  recommend: { title: "Needs your approval", sub: "Drafted by the agent. Nothing reaches the client until you approve.", accent: "border-t-amber-500", dot: "bg-amber-500", icon: CircleDot },
  handoff: { title: "Handed to a human", sub: "The agent stepped back. A named person owns the next step.", accent: "border-t-rose-500", dot: "bg-rose-500", icon: UserRound },
};
const STATUS_LABEL: Record<AgentAction["status"], string> = {
  executed: "Done", pending_approval: "Awaiting approval", approved: "Approved & sent", rejected: "Rejected",
  open: "Open", acknowledged: "Acknowledged", blocked: "Blocked",
};

const sgd = (n: number) => `SGD ${Math.round(n).toLocaleString("en-SG")}`;
const fmtDate = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

interface Live { running: boolean; total: number; done: number; inFlight: string[]; feed: { id: number; text: string; tone: "info" | "ok" | "warn" }[] }

export function Dashboard({ asOf, model, scopes, issues, rules, catalog, escalationLabels }: Props) {
  const [scope, setScope] = useState("A01");
  const [run, setRun] = useState<Run | null>(null);
  const [decisions, setDecisions] = useState<ClientDecision[]>([]);
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [live, setLive] = useState<Live>({ running: false, total: 0, done: 0, inFlight: [], feed: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const feedId = useRef(0);

  const current = scopes.find((s) => s.id === scope)!;

  useEffect(() => {
    let cancelled = false;
    setRun(null); setDecisions([]); setActions([]); setError(null);
    fetch(`/api/run?scope=${scope}`).then((r) => r.json()).then(({ run }: { run: Run | null }) => {
      if (cancelled || !run) return;
      setRun(run); setDecisions(run.decisions); setActions(run.actions);
    });
    return () => { cancelled = true; };
  }, [scope]);

  const pushFeed = (text: string, tone: Live["feed"][number]["tone"] = "info") =>
    setLive((l) => ({ ...l, feed: [{ id: ++feedId.current, text, tone }, ...l.feed].slice(0, 60) }));

  const start = useCallback(async () => {
    setError(null); setRun(null); setDecisions([]); setActions([]);
    setLive({ running: true, total: 0, done: 0, inFlight: [], feed: [] });
    try {
      const res = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope }) });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines.filter(Boolean)) {
          const e = JSON.parse(line) as RunEvent;
          if (e.type === "run_started") {
            setLive((l) => ({ ...l, total: e.total }));
            pushFeed(`Run ${e.run.id} started — ${e.total} clients in ${e.run.scope_label}'s book · ${e.run.model}`);
          } else if (e.type === "client_started") {
            setLive((l) => ({ ...l, inFlight: [...l.inFlight, e.client_name] }));
          } else if (e.type === "client_done") {
            setLive((l) => ({ ...l, done: l.done + 1, inFlight: l.inFlight.filter((n) => n !== e.decision.client_name) }));
            setDecisions((d) => [...d, e.decision]);
            setActions((a) => [...a, ...e.actions]);
            const blocked = e.actions.filter((a) => a.status === "blocked").length;
            const n = e.actions.length - blocked;
            pushFeed(
              `${e.decision.client_name}: ${e.decision.model_called ? e.decision.summary : "no signals — skipped model"}${n ? ` · ${n} action${n > 1 ? "s" : ""}` : ""}${blocked ? ` · ${blocked} blocked by guardrail` : ""}`,
              blocked || e.decision.model_error ? "warn" : n ? "ok" : "info",
            );
          } else if (e.type === "run_finished") {
            setRun(e.run); setDecisions(e.run.decisions); setActions(e.run.actions);
            pushFeed(`Run complete · ${e.run.usage.input_tokens.toLocaleString()} in / ${e.run.usage.output_tokens.toLocaleString()} out tokens`, "ok");
          } else if (e.type === "error") {
            setError(e.message);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLive((l) => ({ ...l, running: false, inFlight: [] }));
    }
  }, [scope]);

  const decide = async (id: string, decision: "approve" | "reject" | "acknowledge", message_native?: string) => {
    const res = await fetch(`/api/actions/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, message_native, actor: current.label }) });
    const body = await res.json();
    if (body.action) setActions((all) => all.map((a) => (a.id === id ? body.action : a)));
  };

  const byClient = useMemo(() => new Map(decisions.map((d) => [d.client_id, d])), [decisions]);
  const rank = (a: AgentAction) => PRIORITY_RANK[byClient.get(a.client_id)?.priority ?? "low"];
  const visible = actions.filter((a) => a.status !== "blocked").sort((a, b) => rank(a) - rank(b) || (a.due_date ?? "").localeCompare(b.due_date ?? ""));
  const blocked = actions.filter((a) => a.status === "blocked");
  const col = (t: Tier) => visible.filter((a) => a.tier === t);
  const premiumAtRisk = decisions.reduce((s, d) => s + d.envelope.premiumAtRisk, 0);
  const selectedAction = actions.find((a) => a.id === selected) ?? null;
  const hasData = decisions.length > 0;

  return (
    <div className="flex flex-1 flex-col">
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-4 px-6 py-3">
          <div className="flex items-center gap-2.5">
            <div className="grid size-8 place-items-center rounded-lg bg-zinc-900 text-sm font-semibold text-white">h</div>
            <div className="leading-tight">
              <div className="text-sm font-semibold">Retention &amp; Cross-Sell Agent</div>
              <div className="text-xs text-zinc-500">Agentic Sales Suite · Book as of {fmtDate(asOf)}</div>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <label className="text-xs text-zinc-500">Book</label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              disabled={live.running}
              className="h-8 rounded-md border border-zinc-200 bg-white px-2 text-sm shadow-xs outline-none focus:ring-2 focus:ring-zinc-300"
            >
              {scopes.map((s) => (
                <option key={s.id} value={s.id}>{s.label} — {s.sub} ({s.clients})</option>
              ))}
            </select>
            <Button onClick={start} disabled={live.running} className="h-8 gap-1.5 px-3">
              {live.running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              {live.running ? "Agent running…" : hasData ? "Re-run agent" : "Run agent"}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1500px] flex-1 space-y-5 px-6 py-5">
        <PersonaBanner scope={current} />

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">
            <AlertTriangle className="size-4" /> {error}
          </div>
        )}

        {/* KPIs */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Kpi label="Clients reviewed" value={hasData ? `${decisions.length}` : "—"} sub={hasData ? `${decisions.filter((d) => d.model_called).length} needed the model` : `${current.clients} in book`} />
          <Kpi label="Annual premium at risk" value={hasData ? sgd(premiumAtRisk) : "—"} sub="In grace or status unverified" tone="red" />
          <Kpi label="Done autonomously" value={hasData ? `${col("autonomous").length}` : "—"} sub="Reminders, tasks, flags" tone="emerald" />
          <Kpi label="Awaiting approval" value={hasData ? `${col("recommend").filter((a) => a.status === "pending_approval").length}` : "—"} sub="Drafts & cross-sell briefs" tone="amber" />
          <Kpi label="Handed to a human" value={hasData ? `${col("handoff").length}` : "—"} sub="Agent took no client action" tone="rose" />
          <Kpi label="Blocked by guardrails" value={hasData ? `${blocked.length}` : "—"} sub="Model proposals refused" tone="zinc" />
        </div>

        {(live.running || live.feed.length > 0) && <LivePanel live={live} />}

        {!hasData && !live.running ? (
          <EmptyState scope={current} onRun={start} model={model} />
        ) : (
          <Tabs defaultValue="queue" className="gap-4">
            <TabsList>
              <TabsTrigger value="queue">Work queue</TabsTrigger>
              <TabsTrigger value="clients">Clients ({decisions.length})</TabsTrigger>
              <TabsTrigger value="guardrails">Guardrails{blocked.length ? ` · ${blocked.length} blocked` : ""}</TabsTrigger>
              <TabsTrigger value="audit">Audit log</TabsTrigger>
              <TabsTrigger value="data">Data quality ({issues.length})</TabsTrigger>
            </TabsList>

            <TabsContent value="queue">
              <div className="grid gap-4 lg:grid-cols-3">
                {(["autonomous", "recommend", "handoff"] as Tier[]).map((t) => (
                  <Column key={t} tier={t} actions={col(t)} byClient={byClient} onOpen={setSelected} />
                ))}
              </div>
            </TabsContent>

            <TabsContent value="clients">
              <ClientsTable decisions={decisions} actions={actions} onOpen={setSelected} />
            </TabsContent>

            <TabsContent value="guardrails">
              <Guardrails rules={rules} catalog={catalog} blocked={blocked} onOpen={setSelected} />
            </TabsContent>

            <TabsContent value="audit">
              <AuditLog actions={actions} run={run} escalationLabels={escalationLabels} />
            </TabsContent>

            <TabsContent value="data">
              <DataQuality issues={issues} />
            </TabsContent>
          </Tabs>
        )}
      </main>

      <DetailSheet
        action={selectedAction}
        decision={selectedAction ? byClient.get(selectedAction.client_id) ?? null : null}
        related={selectedAction ? actions.filter((a) => a.client_id === selectedAction.client_id && a.id !== selectedAction.id) : []}
        escalationLabels={escalationLabels}
        onClose={() => setSelected(null)}
        onOpen={setSelected}
        onDecide={decide}
      />
    </div>
  );
}

function PersonaBanner({ scope }: { scope: Scope }) {
  const a = scope.advisor;
  if (!a)
    return (
      <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <ShieldAlert className="size-4 shrink-0" />
        <span><b>Unassigned clients.</b> No servicing advisor means nobody can approve drafts. The agent sends only factual reminders and routes every client to Agency Ops for assignment.</span>
      </div>
    );
  const suspended = a.rnf_licence !== "active";
  return (
    <div className={`flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border px-4 py-3 text-sm ${suspended ? "border-red-200 bg-red-50 text-red-900" : "border-zinc-200 bg-white"}`}>
      <div className="flex items-center gap-3">
        <div className="grid size-9 place-items-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-700">
          {a.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
        </div>
        <div>
          <div className="font-medium">{a.name}</div>
          <div className="text-xs text-zinc-500">{a.role} · {a.agency_unit} · {a.tenure_years} yrs</div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-xs">
        {suspended ? <ShieldAlert className="size-3.5 text-red-600" /> : <ShieldCheck className="size-3.5 text-emerald-600" />}
        MAS RNF licence: <b className={suspended ? "text-red-700" : "text-emerald-700"}>{a.rnf_licence}</b>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-zinc-600"><Languages className="size-3.5" /> {a.languages.join(" · ")}</div>
      <div className="text-xs text-zinc-600">{scope.clients} clients serviced</div>
      {suspended && (
        <div className="basis-full text-xs">
          Licence suspended: this advisor cannot give advice. Factual reminders still go out, retention drafts route to the Unit Manager for approval, and no cross-sell happens until clients are reassigned.
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, tone = "zinc" }: { label: string; value: string; sub: string; tone?: "zinc" | "red" | "emerald" | "amber" | "rose" }) {
  const bar = { zinc: "bg-zinc-300", red: "bg-red-500", emerald: "bg-emerald-500", amber: "bg-amber-500", rose: "bg-rose-500" }[tone];
  return (
    <div className="relative overflow-hidden rounded-xl border border-zinc-200 bg-white px-4 py-3">
      <div className={`absolute inset-y-0 left-0 w-1 ${bar}`} />
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums tracking-tight">{value}</div>
      <div className="text-[11px] text-zinc-400">{sub}</div>
    </div>
  );
}

function LivePanel({ live }: { live: Live }) {
  const pct = live.total ? Math.round((live.done / live.total) * 100) : 0;
  return (
    <div className="rounded-xl border border-zinc-200 bg-white">
      <div className="flex items-center gap-3 border-b border-zinc-100 px-4 py-2.5">
        <Bot className="size-4 text-zinc-500" />
        <span className="text-sm font-medium">Agent loop</span>
        <span className="text-xs text-zinc-500">{live.running ? `Working ${live.done}/${live.total}` : `Finished ${live.done}/${live.total}`}</span>
        <div className="ml-auto w-48"><Progress value={pct} /></div>
      </div>
      {live.inFlight.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-100 px-4 py-2 text-xs text-zinc-500">
          <Loader2 className="size-3 animate-spin" /> Deciding:
          {live.inFlight.map((n) => <span key={n} className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-700">{n}</span>)}
        </div>
      )}
      <div className="max-h-40 overflow-y-auto px-4 py-2 font-mono text-[11.5px] leading-5">
        {live.feed.map((f) => (
          <div key={f.id} className={f.tone === "warn" ? "text-amber-700" : f.tone === "ok" ? "text-zinc-800" : "text-zinc-500"}>
            <span className="mr-2 text-zinc-300">›</span>{f.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState({ scope, onRun, model }: { scope: Scope; onRun: () => void; model: string }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-14 text-center">
      <Bot className="mx-auto size-8 text-zinc-400" />
      <h2 className="mt-3 text-base font-semibold">Work {scope.label}&apos;s book</h2>
      <p className="mx-auto mt-1 max-w-xl text-sm text-zinc-500">
        The agent checks each of {scope.clients} clients against the governance rules, asks <code className="text-xs">{model}</code> to decide what to do inside those
        boundaries, executes what it&apos;s allowed to, and queues the rest for you or hands it to a human.
      </p>
      <Button onClick={onRun} className="mt-5 gap-1.5"><Play className="size-4" /> Run agent</Button>
    </div>
  );
}

function Column({ tier, actions, byClient, onOpen }: { tier: Tier; actions: AgentAction[]; byClient: Map<string, ClientDecision>; onOpen: (id: string) => void }) {
  const m = TIER_META[tier];
  return (
    <section className={`flex min-h-[300px] flex-col rounded-xl border border-t-4 border-zinc-200 bg-zinc-100/60 ${m.accent}`}>
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${m.dot}`} />
          <h3 className="text-sm font-semibold">{m.title}</h3>
          <span className="ml-auto rounded-full bg-white px-2 py-0.5 text-xs font-medium tabular-nums text-zinc-600 ring-1 ring-zinc-200">{actions.length}</span>
        </div>
        <p className="mt-0.5 text-xs text-zinc-500">{m.sub}</p>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-3" style={{ maxHeight: "calc(100vh - 330px)" }}>
        {actions.map((a) => <ActionCard key={a.id} action={a} decision={byClient.get(a.client_id)} onOpen={onOpen} />)}
        {!actions.length && <div className="py-10 text-center text-xs text-zinc-400">Nothing here yet</div>}
      </div>
    </section>
  );
}

function ActionCard({ action: a, decision, onOpen }: { action: AgentAction; decision?: ClientDecision; onOpen: (id: string) => void }) {
  const Icon = TYPE_META[a.type].icon;
  const done = ["approved", "rejected", "acknowledged"].includes(a.status);
  return (
    <button
      onClick={() => onOpen(a.id)}
      className={`group w-full rounded-lg border border-zinc-200 bg-white p-3 text-left shadow-xs transition hover:border-zinc-300 hover:shadow-sm ${done ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-2 text-[11px] text-zinc-500">
        <Icon className="size-3.5" />
        <span>{TYPE_META[a.type].verb}</span>
        {a.origin === "rule" && <span className="rounded bg-zinc-100 px-1 text-[10px] uppercase tracking-wide text-zinc-500">rule</span>}
        {decision && <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase ring-1 ring-inset ${PRIORITY_STYLE[decision.priority]}`}>{decision.priority}</span>}
      </div>
      <div className="mt-1.5 text-sm font-medium leading-snug">{a.title}</div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
        <span className="font-medium text-zinc-700">{a.client_name}</span>
        <span>{a.client_id}</span>
        {a.policy_id && <span className="font-mono">{a.policy_id}</span>}
        {a.channel && <span>· {a.channel}</span>}
        {a.language && a.language !== "EN" && <span>· {a.language}</span>}
        {a.due_date && <span>· due {fmtDate(a.due_date)}</span>}
        {done && <span className="ml-auto font-medium text-zinc-700">{STATUS_LABEL[a.status]}</span>}
      </div>
    </button>
  );
}

function GuardChips({ decision }: { decision: ClientDecision }) {
  return (
    <div className="flex flex-wrap gap-1">
      {decision.envelope.guards.map((g) => (
        <span key={g.code} className="rounded bg-rose-50 px-1.5 py-0.5 text-[10.5px] font-medium text-rose-700 ring-1 ring-inset ring-rose-600/15">{g.label}</span>
      ))}
    </div>
  );
}

function DetailSheet({ action, decision, related, escalationLabels, onClose, onOpen, onDecide }: {
  action: AgentAction | null; decision: ClientDecision | null; related: AgentAction[]; escalationLabels: Record<EscalationTarget, string>;
  onClose: () => void; onOpen: (id: string) => void; onDecide: (id: string, d: "approve" | "reject" | "acknowledge", msg?: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(action?.message_native ?? ""), [action?.id, action?.message_native]);
  const act = async (d: "approve" | "reject" | "acknowledge") => {
    if (!action) return;
    setBusy(true);
    await onDecide(action.id, d, d === "approve" ? draft : undefined);
    setBusy(false);
  };
  const a = action;
  return (
    <Sheet open={!!a} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {a && (
          <>
            <SheetHeader className="border-b border-zinc-100 pb-4">
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <span className={`size-2 rounded-full ${TIER_META[a.tier].dot}`} />
                {TIER_META[a.tier].title} · {TYPE_META[a.type].verb}
                <Badge variant="outline" className="ml-1">{STATUS_LABEL[a.status]}</Badge>
              </div>
              <SheetTitle className="text-base leading-snug">{a.title}</SheetTitle>
              <SheetDescription>
                {a.client_name} · {a.client_id}{a.policy_id ? ` · ${a.policy_id}` : ""}{a.escalate_to ? ` · → ${escalationLabels[a.escalate_to]}` : ""}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-5 px-4 pb-6 text-sm">
              {a.status === "blocked" && (
                <div className="flex gap-2 rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-zinc-800">
                  <Ban className="mt-0.5 size-4 shrink-0" />
                  <div><b>Guardrail blocked this proposal.</b> {a.blocked_reason}</div>
                </div>
              )}

              <Section title="Why">
                <p className="text-zinc-700">{a.rationale}</p>
                {a.origin === "rule" && <p className="mt-1 text-xs text-zinc-500">Added by a governance rule — not a model decision.</p>}
              </Section>

              {a.talking_points.length > 0 && (
                <Section title={a.type === "propose_cross_sell" ? "Advisor brief (not for the client)" : "Talking points"}>
                  <ul className="list-disc space-y-1 pl-4 text-zinc-700">{a.talking_points.map((t, i) => <li key={i}>{t}</li>)}</ul>
                </Section>
              )}

              {a.message_native && (
                <Section title={`Message · ${a.channel ?? ""} · ${a.language ?? ""}${a.type === "send_payment_reminder" ? " · approved template" : ""}`}>
                  {a.status === "pending_approval" ? (
                    <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={6} className="text-sm" />
                  ) : (
                    <div className="whitespace-pre-wrap rounded-lg bg-emerald-50/60 p-3 text-zinc-800 ring-1 ring-emerald-600/10">{a.message_native}</div>
                  )}
                  {a.message_english && a.language !== "EN" && (
                    <div className="mt-2 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600"><div className="mb-1 font-medium text-zinc-500">English</div>{a.message_english}</div>
                  )}
                </Section>
              )}

              {a.endpoint && (
                <div className="flex items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2 font-mono text-xs text-zinc-600">
                  <CheckCircle2 className="size-3.5 text-emerald-600" /> POST {a.endpoint}
                  <span className="ml-auto">{a.executed_at && new Date(a.executed_at).toLocaleTimeString()}</span>
                </div>
              )}

              {a.status === "pending_approval" && (
                <div className="flex gap-2">
                  <Button disabled={busy} onClick={() => act("approve")} className="gap-1.5">
                    <Send className="size-4" /> {a.type === "propose_cross_sell" ? "Accept & add to my tasks" : "Approve & send"}
                  </Button>
                  <Button disabled={busy} variant="outline" onClick={() => act("reject")}>Reject</Button>
                </div>
              )}
              {a.status === "open" && (
                <Button disabled={busy} variant="outline" onClick={() => act("acknowledge")} className="gap-1.5"><CheckCircle2 className="size-4" /> Acknowledge hand-off</Button>
              )}

              {decision && (
                <Section title="Agent's read of this client">
                  <p className="text-zinc-700">{decision.situation}</p>
                  {decision.envelope.guards.length > 0 && <div className="mt-2"><GuardChips decision={decision} /></div>}
                  <div className="mt-3 space-y-1">
                    {decision.envelope.signals.map((s, i) => (
                      <div key={i} className="flex gap-2 text-xs">
                        <span className={`mt-1 size-1.5 shrink-0 rounded-full ${s.kind === "retention" ? "bg-red-500" : s.kind === "cross_sell" ? "bg-sky-500" : "bg-zinc-400"}`} />
                        <span><b className="font-medium text-zinc-800">{s.label}.</b> <span className="text-zinc-500">{s.detail}</span></span>
                      </div>
                    ))}
                  </div>
                  {decision.envelope.reminderEligibility.length > 0 && (
                    <div className="mt-3 space-y-1 rounded-lg bg-zinc-50 p-2.5 text-xs">
                      {decision.envelope.reminderEligibility.map((r) => (
                        <div key={r.policy_id} className="flex gap-2"><span className="font-mono">{r.policy_id}</span><span className={r.eligible ? "text-emerald-700" : "text-zinc-600"}>{r.reason}</span></div>
                      ))}
                    </div>
                  )}
                  {decision.envelope.approver && <p className="mt-2 text-xs text-zinc-500">Approver for drafts: {decision.envelope.approver.name}</p>}
                </Section>
              )}

              {related.length > 0 && (
                <Section title="Other actions for this client">
                  <div className="space-y-1">
                    {related.map((r) => (
                      <button key={r.id} onClick={() => onOpen(r.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-zinc-50">
                        <span className={`size-1.5 rounded-full ${r.status === "blocked" ? "bg-zinc-400" : TIER_META[r.tier].dot}`} />
                        <span className="text-zinc-500">{r.status === "blocked" ? "Blocked" : TYPE_META[r.type].verb}</span>
                        <span className="truncate text-zinc-800">{r.title}</span>
                        <ArrowRight className="ml-auto size-3 text-zinc-400" />
                      </button>
                    ))}
                  </div>
                </Section>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{title}</div>
      {children}
    </div>
  );
}

function ClientsTable({ decisions, actions, onOpen }: { decisions: ClientDecision[]; actions: AgentAction[]; onOpen: (id: string) => void }) {
  const rows = [...decisions].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.envelope.premiumAtRisk - a.envelope.premiumAtRisk);
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
          <tr><th className="px-4 py-2 font-medium">Client</th><th className="px-2 py-2 font-medium">Priority</th><th className="px-2 py-2 font-medium">Agent summary</th><th className="px-2 py-2 font-medium">Guards</th><th className="px-2 py-2 text-right font-medium">At risk</th><th className="px-4 py-2 font-medium">Actions</th></tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {rows.map((d) => {
            const own = actions.filter((a) => a.client_id === d.client_id);
            return (
              <tr key={d.client_id} className="align-top hover:bg-zinc-50/70">
                <td className="px-4 py-2.5"><div className="font-medium">{d.client_name}</div><div className="text-xs text-zinc-500">{d.client_id}</div></td>
                <td className="px-2 py-2.5"><span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase ring-1 ring-inset ${PRIORITY_STYLE[d.priority]}`}>{d.priority}</span></td>
                <td className="max-w-md px-2 py-2.5 text-zinc-700">{d.summary}{!d.model_called && <span className="ml-1 text-xs text-zinc-400">(rules only)</span>}</td>
                <td className="px-2 py-2.5"><GuardChips decision={d} /></td>
                <td className="px-2 py-2.5 text-right tabular-nums">{d.envelope.premiumAtRisk ? sgd(d.envelope.premiumAtRisk) : "—"}</td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {own.map((a) => {
                      const Icon = a.status === "blocked" ? Ban : TYPE_META[a.type].icon;
                      return (
                        <button key={a.id} onClick={() => onOpen(a.id)} title={a.title} className="grid size-6 place-items-center rounded-md ring-1 ring-zinc-200 hover:bg-zinc-100">
                          <Icon className={`size-3.5 ${a.status === "blocked" ? "text-zinc-400" : a.tier === "autonomous" ? "text-emerald-600" : a.tier === "recommend" ? "text-amber-600" : "text-rose-600"}`} />
                        </button>
                      );
                    })}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Guardrails({ rules, catalog, blocked, onOpen }: { rules: Props["rules"]; catalog: Props["catalog"]; blocked: AgentAction[]; onOpen: (id: string) => void }) {
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <div className="space-y-4 lg:col-span-3">
        <div className="rounded-xl border border-zinc-200 bg-white">
          <div className="border-b border-zinc-100 px-4 py-3"><h3 className="text-sm font-semibold">Autonomy matrix</h3><p className="text-xs text-zinc-500">What the agent may do on its own. Enforced in code after every model decision.</p></div>
          <div className="divide-y divide-zinc-100">
            {(Object.entries(catalog) as [ActionType, Props["catalog"][ActionType]][]).map(([k, v]) => {
              const Icon = TYPE_META[k].icon;
              return (
                <div key={k} className="flex gap-3 px-4 py-2.5">
                  <Icon className="mt-0.5 size-4 shrink-0 text-zinc-400" />
                  <div className="flex-1"><div className="text-sm font-medium">{v.label}</div><div className="text-xs text-zinc-500">{v.description}</div></div>
                  <span className={`h-fit shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${v.tier === "autonomous" ? "bg-emerald-50 text-emerald-700" : v.tier === "recommend" ? "bg-amber-50 text-amber-700" : "bg-rose-50 text-rose-700"}`}>{TIER_META[v.tier].title}</span>
                </div>
              );
            })}
            <div className="flex gap-3 bg-zinc-50/60 px-4 py-2.5">
              <Ban className="mt-0.5 size-4 shrink-0 text-zinc-400" />
              <div className="flex-1"><div className="text-sm font-medium">Never</div><div className="text-xs text-zinc-500">Recommend or price a product to a client · change coverage · free-text messages without approval · contact deceased, complaint or DNC-by-phone clients · act on unverified policy status</div></div>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white">
          <div className="border-b border-zinc-100 px-4 py-3"><h3 className="text-sm font-semibold">Governance rules</h3><p className="text-xs text-zinc-500">Deterministic. Evaluated before the model sees the client; the model cannot override them.</p></div>
          <table className="w-full text-xs">
            <tbody className="divide-y divide-zinc-100">
              {rules.map((r) => (
                <tr key={r.code} className="align-top"><td className="px-4 py-2 font-mono text-[11px] text-zinc-500">{r.code}</td><td className="px-2 py-2 text-zinc-600">{r.when}</td><td className="px-4 py-2 text-zinc-800">{r.effect}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="lg:col-span-2">
        <div className="rounded-xl border border-zinc-200 bg-white">
          <div className="border-b border-zinc-100 px-4 py-3"><h3 className="text-sm font-semibold">Blocked this run ({blocked.length})</h3><p className="text-xs text-zinc-500">Model proposals the harness refused. Each one is an eval signal.</p></div>
          <div className="divide-y divide-zinc-100">
            {blocked.map((a) => (
              <button key={a.id} onClick={() => onOpen(a.id)} className="block w-full px-4 py-2.5 text-left hover:bg-zinc-50">
                <div className="flex items-center gap-2 text-xs text-zinc-500"><Ban className="size-3.5" /> {TYPE_META[a.type].verb} · {a.client_name}</div>
                <div className="mt-0.5 text-sm">{a.title}</div>
                <div className="mt-0.5 text-xs text-zinc-500">{a.blocked_reason}</div>
              </button>
            ))}
            {!blocked.length && <div className="px-4 py-8 text-center text-xs text-zinc-400">The model stayed inside the envelope on every client.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function AuditLog({ actions, run, escalationLabels }: { actions: AgentAction[]; run: Run | null; escalationLabels: Record<EscalationTarget, string> }) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      {run && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-zinc-100 px-4 py-2.5 text-xs text-zinc-500">
          <span>Run <b className="font-mono text-zinc-700">{run.id}</b></span>
          <span>Model <b className="text-zinc-700">{run.model}</b></span>
          <span>Started {new Date(run.started_at).toLocaleString()}</span>
          <span>Tokens {run.usage.input_tokens.toLocaleString()} in · {run.usage.output_tokens.toLocaleString()} out · {run.usage.cache_read_input_tokens.toLocaleString()} cached</span>
        </div>
      )}
      <table className="w-full text-xs">
        <thead className="bg-zinc-50 text-left text-zinc-500">
          <tr><th className="px-4 py-2 font-medium">Action</th><th className="px-2 py-2 font-medium">Client</th><th className="px-2 py-2 font-medium">Type</th><th className="px-2 py-2 font-medium">Origin</th><th className="px-2 py-2 font-medium">Status</th><th className="px-4 py-2 font-medium">Endpoint / target</th></tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 font-mono text-[11px]">
          {actions.map((a) => (
            <tr key={a.id}>
              <td className="px-4 py-1.5 text-zinc-500">{a.id}</td>
              <td className="px-2 py-1.5">{a.client_id}{a.policy_id ? ` / ${a.policy_id}` : ""}</td>
              <td className="px-2 py-1.5">{a.type}</td>
              <td className="px-2 py-1.5">{a.origin}</td>
              <td className={`px-2 py-1.5 ${a.status === "blocked" ? "text-zinc-400" : ""}`}>{a.status}</td>
              <td className="px-4 py-1.5 text-zinc-500">{a.endpoint ?? (a.escalate_to ? escalationLabels[a.escalate_to] : a.blocked_reason ?? "—")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DataQuality({ issues }: { issues: DataIssue[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="border-b border-zinc-100 px-4 py-3"><h3 className="text-sm font-semibold">Data quality findings</h3><p className="text-xs text-zinc-500">Found while loading the book. Each one changes what the agent is allowed to do.</p></div>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-zinc-100">
          {issues.map((i) => (
            <tr key={i.id} className="align-top">
              <td className="px-4 py-2.5"><span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${i.severity === "high" ? "bg-red-50 text-red-700" : i.severity === "medium" ? "bg-amber-50 text-amber-700" : "bg-zinc-100 text-zinc-600"}`}>{i.severity}</span></td>
              <td className="px-2 py-2.5 font-mono text-xs text-zinc-600">{i.entity}</td>
              <td className="px-2 py-2.5 text-zinc-800">{i.issue}</td>
              <td className="px-4 py-2.5 text-xs text-zinc-600">{i.handling}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
