# Retention & Cross-Sell Agent: one-page memo

**User:** the financial consultant who owns the book. Escalations go to their Unit Manager, Agency Ops or Compliance. **Book:** a Singapore agency extract, as of 11 Sep 2026.

## What I built, and why this first

An agent that works one advisor's book end to end: **rules → model decision → guardrail re-check → execute → queue → hand off**. The work queue shows every outcome in one of three lanes: *done autonomously*, *needs your approval*, or *handed to a human*.

**Retention runs the full loop; cross-sell stops at a recommendation.** Retention comes first because the money is already on the books, the deadline is hard (lapse on day 31), and the work is *servicing* rather than *advice*, so the agent can safely act on its own. On this book that means SGD 91k of annual premium in grace for A01 alone, and one policy lapsing in two days. Cross-sell is regulated advice in Singapore, so the agent only writes an advisor-only brief, and only when there is a concrete trigger (a life event, or dependants with no life cover). A coverage gap alone describes most clients, so it doesn't count. That rule took A01's approval queue from 40 items to 6. The advisor's attention is the scarcest resource, so I chose precision over volume.

## Where the autonomy lines are, and how I'd defend them

| The agent does on its own | The agent drafts; a human approves | The agent hands off and does nothing client-facing |
|---|---|---|
| Grace-period reminders from a **pre-approved template**. The model decides *whether* to send, never *what* it says. Advisor tasks and CRM flags. | Reinstatement messages in the client's language. Cross-sell briefs (never sent to the client). | Deceased, open complaint, recent CI claim, advisor licence suspended, unassigned client, insurer suitability flag, duplicate record. |

The defence to a compliance officer rests on three properties:
1. **Rules, not prompts, are the boundary.** Thirteen deterministic rules (PDPA consent, DNC, opt-outs, RNF licence, promise-to-pay, frequency caps…) build each client's envelope before the model sees it. Every proposal is re-checked afterwards. The model can be more conservative than the rules, never less, and every refusal is logged.
2. **No free text reaches a client without a licensed human.** The only autonomous message is a factual template, sent as the insurer with the advisor copied.
3. **Fail closed.** A model error, a refusal or invalid output routes the client to a human with zero client contact. A suspended advisor doesn't stop retention: drafts go to the Unit Manager. Advice stops.

## How I'd evaluate before a live client

- **Golden set (built, `npm run eval`).** 14 of the book's hardest cases, 36 checks: no contact with the deceased, no chasing a client who promised to pay by the 18th, a critical-priority call before a 2-day lapse, no cross-sell to an opted-out client, and so on. **36/36 on four consecutive runs.** Drafts were 100% in the client's language with no new-product names, and the model made 0 proposals the guardrails had to block. Each client takes about 8s; a 34-client book costs about $0.45 on Sonnet 5.5.
- **Before go-live:** expand the golden set with the insurer's compliance team (target 200 cases, with red-team prompts hidden in notes). Then run in **shadow mode** for 4 weeks: the agent decides, advisors act as normal, and we compare. Release gates: **zero hard-rule breaches**, ≥90% advisor acceptance on drafts, and a measured lift in grace-period recovery against a holdout group.
- **In production:** sample 5% of autonomous actions for weekly QA, and treat every guardrail block as an incident to triage.

## What I'd need from engineering

The harness should enforce the envelope outside the model, with a versioned rule config per client. On top of that:
- Read access to the policy-admin and CRM systems, including **payment-failure reason codes** and non-forfeiture options (automatic premium loan, premium holiday), which change whether "day 31" is real.
- A messaging gateway that holds template IDs and enforces consent and DNC at send time.
- An append-only audit store and an approval inbox in the advisor's existing tool, not a new app.
- Retries and rate limits on model calls, and a cross-channel contact log for frequency caps.

**Reusable for the next insurer:** the loop, the action catalogue and tiers, the rule engine, the fail-closed design, and the eval harness. **Specific to this book:** the rule thresholds (grace days, contact cap), the templates and their certified translations, the escalation map (Alpha Unit has no Unit Manager), the jurisdiction's regulation (MAS, PDPA and DNC become HK IA / PDPO or MY BNM / PDPA), and the data cleaning for this extract (see `DATA_NOTES.md`).

**Assumptions to confirm with the insurer:** reminders count as servicing rather than marketing; the allowed channels and sender identity; who receives Alpha Unit escalations; and whether reinstatement needs fresh underwriting.
