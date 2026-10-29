# Retention & Cross-Sell Agent

A prototype of the decisioning agent behind Hupo's Retention & Cross-Sell capability. It works a financial consultant's book of business, flags policies at risk of lapsing, surfaces cross-sell opportunities, decides what to do about each, and does it inside boundaries that a compliance officer can read.

See [`MEMO.md`](MEMO.md) for the product reasoning and [`DATA_NOTES.md`](DATA_NOTES.md) for what was corrected in the data and which fields I would add.

## Run it

```bash
npm install
cp .env.example .env.local      # add your OPENROUTER_API_KEY
npm run dev                     # http://localhost:3000
```

Requires Node 22+. The model is Claude Sonnet 5.5 via OpenRouter, at low reasoning effort for speed. To call the Anthropic API directly instead, set `ANTHROPIC_API_KEY` and leave `OPENROUTER_API_KEY` empty.

```bash
npm run eval                    # golden-set evaluation on the 14 hardest clients (real model calls, nothing dispatched)
npm run inspect -- C0018 C0062  # print the deterministic governance envelope for clients (no model calls)
```

## Using it

1. **Pick a book.** The selector lists every active advisor plus the unassigned-clients queue. The product is advisor-agnostic; Tan Wei Ling (A01) has the largest and messiest book, so it makes the best demo.
2. **Run agent.** Each client streams through the loop live: rules → model decision → guardrail check → execution.
3. **Work the queue.** Three columns show exactly who did what:
   - **Done autonomously**: template payment reminders, advisor tasks, CRM flags. Already sent to the mock endpoints.
   - **Needs your approval**: retention drafts in the client's language (editable) and advisor-only cross-sell briefs. Nothing reaches a client until you approve.
   - **Handed to a human**: deceased, complaints, sensitive claims, licensing, unassigned clients, suitability flags. The agent takes no client action.
4. Click any card for the agent's reasoning, the guards and signals it saw, and the message. Approve, edit, reject or acknowledge.
5. The **Guardrails** tab shows the autonomy matrix, the rules, and every model proposal the harness blocked this run. **Audit log** lists every action and the endpoint it hit. **Data quality** lists the issues found in the extract.

Try **Kevin Goh (A06)**, whose licence is suspended, to see the same agent change behaviour for a whole book.

## How it works

```
CSV extract ──► data.ts        clean, de-duplicate, flag data issues
            ──► governance.ts  deterministic rules → per-client envelope
                               (guards, signals, reminder eligibility, allowed actions)
            ──► agent.ts       Sonnet 5.5 decides inside the envelope (structured output)
                               enforce(): re-check every proposal; block what's not allowed,
                               add rule-mandated hand-offs the model missed
            ──► mock.ts        execute autonomous actions against /api/mock/* endpoints
            ──► dashboard.tsx  three-lane queue, approvals, audit
```

The model never writes the autonomous client message: reminders use a pre-approved template (`templates.ts`). The model can be more conservative than the rules, never less. If the model fails or refuses, the client goes to a human and nothing reaches the client.

Storage is a local JSON file (`.data/store.json`). The mock endpoints only record what they receive.
