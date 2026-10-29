# Data notes

The raw extract in `data/raw/` is left untouched. All cleaning happens at load time in `src/lib/data.ts`, and every finding shows up in the app's **Data quality** tab, so the corrections can be audited and reversed.

## What I changed and why

| Finding | Records | Handling | Why |
|---|---|---|---|
| Duplicate client with conflicting consent | C0045 / C0119 (Koh Mei Ling, same DOB) | Merged under C0045. **Most restrictive consent applied** (marketing consent N). Flagged to the data team. | Contacting someone who withdrew consent on one record is a PDPA breach. Merging also gives the agent the full policy picture. |
| Name casing | C0119 "Koh MEI LING" | Normalised to title case | Display only. It also exposed the duplicate. |
| Status `inforce` but the due date has passed (source flags a "sync mismatch") | P0107 (no payment since 1 Sep, 10 days) | Marked *status unverified* and counted as premium at risk. No automated client contact. Advisor verifies with policy admin today. | If it's really unpaid it lapses in about 3 weeks. If the source is right, a reminder would be wrong. A human checks first. |
| Same mismatch, but a payment was received after the due date | P0035, P0055, P0115, P0258, P0263 | Treated as likely current (next due date not rolled forward). No automated contact until confirmed. Flagged to the data team. | Sending a "you missed a payment" message to someone who paid damages trust. |
| Deceased client with live policies | C0018 (P0038, P0039 in grace) | All outreach suppressed. Handed to Claims & Servicing. | Chasing a deceased client's family for premiums is the worst failure this agent could have. |
| Advisor active but licence suspended | A06 Kevin Goh (12 clients) | Clients still get factual reminders. Retention drafts route to the Unit Manager (A05). No cross-sell. | Retention shouldn't stop because of an advisor's licensing problem, but advice must. |
| Unit without a Unit Manager | Alpha Unit | Escalations go to an "Agency Ops" queue | Assumption, to confirm with the insurer. |
| Unassigned clients | 18 clients, mostly the departed A07's book | Factual reminders only. Every one is routed to Agency Ops for assignment. | No licensed person to approve drafts. |
| Income inconsistent with occupation | C0002, C0057, C0077 (Lawyer, <30k) | Flagged. Any needs conversation starts with a refreshed fact-find. | Stale income makes suitability checks meaningless. |
| Premiums high relative to the stated income band | Many (synthetic bands are loose) | Soft signal only (`FACT_FIND_STALE`), not a block | Blocking on a stale field would kill every conversation. The insurer's own flag (`Premium ~23% of stated income`, P0270–P0272) **is** a hard block and goes to Compliance. |
| Health information in `life_event_note` | "Diagnosed with hypertension" (4 clients) | Excluded from cross-sell triggers | Health data is not a sales trigger, and using it to target CI sales is a fair-dealing and PDPA risk. |

## Fields I would add

1. **Payment failure reason** (insufficient funds, GIRO mandate expired, card expired). The remedy differs: a GIRO mandate needs a form, an expired card needs new details. Today the agent sees only "GIRO deduction failed".
2. **Non-forfeiture options**: automatic premium loan, premium holiday eligibility (ILP), reduced paid-up option. Many whole-life and ILP policies don't actually lapse on day 31. That changes urgency and the right conversation.
3. **Reinstatement terms per product**: window and whether a health declaration is needed. This decides whether a lapsed policy is a servicing task or a new-underwriting conversation.
4. **Per-channel, per-purpose consent and DNC check date**. A single Y/N can't tell "no marketing calls" from "no WhatsApp at all", and DNC checks expire.
5. **Contact log across all channels** (call centre, app, insurer emails), not just advisor interactions. Needed for a real frequency cap.
6. **Vulnerable-customer indicators and CKA/CAR status** (MAS fair dealing; needed before any ILP conversation).
7. **Policy owner vs life assured, and nominee**. The extract conflates them, but premium reminders go to the payer.
8. **Fact-find / FNA date and coverage held elsewhere**. A cross-sell brief without the client's coverage at other insurers is guesswork.
9. **Endowment and term maturity / expiry dates**: the most natural re-engagement moment, and missing from the extract.
10. **Outcome fields** (paid after reminder? reinstated? brief accepted?), so the agent can be evaluated on results, not just compliance.
