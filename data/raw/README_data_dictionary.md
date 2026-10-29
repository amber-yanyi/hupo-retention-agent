# Starter Book of Business — Data Dictionary

Synthetic data for a Singapore-based life insurer's agency channel. **As-of date: 2026-09-11.** All names, people and figures are fictional. Four tables, joined on `client_id`, `advisor_id` and `policy_id`. The data is deliberately imperfect — treat it the way you would a real CRM extract.

## advisors.csv (8 rows)
| field | meaning |
|---|---|
| advisor_id | Primary key (A01–A08) |
| name, agency_unit, role | Unit Managers supervise Financial Consultants in their unit |
| tenure_years | Years with the agency |
| status | `active` / `departed` |
| rnf_licence | MAS Representative Notification Framework status: `active` / `suspended` / `ceased` |
| languages | Semicolon-separated (EN, ZH, MS, TA) |

## clients.csv (119 rows)
| field | meaning |
|---|---|
| client_id | Primary key |
| full_name, dob, gender, marital_status, dependants | Demographics |
| occupation, annual_income_band_sgd, smoker | As stated at last fact-find |
| preferred_language | EN / ZH / MS / TA |
| marketing_consent | PDPA consent to receive marketing (`Y`/`N`) |
| do_not_call | Client is on the DNC registry or has asked not to be called (`Y`/`N`) |
| servicing_advisor_id | Advisor currently responsible for servicing the client. **Blank = unassigned.** |
| last_annual_review_date | Date of last documented review; blank if none on record |
| life_event_note | Free-text note from servicing (sparse) |
| client_status | `active` / `deceased` |

## policies.csv (260 rows)
| field | meaning |
|---|---|
| policy_id | Primary key |
| client_id | Life assured / policyholder |
| writing_advisor_id | Advisor who sold the policy (may differ from the client's current servicing advisor) |
| product_type | Term Life, Whole Life, Critical Illness, Hospitalisation (IP), Endowment, ILP, Retirement Annuity, Personal Accident |
| product_name | Fictional product |
| sum_assured_sgd | 0 for Hospitalisation plans |
| annual_premium_sgd | Annualised premium; 0 for paid-up policies |
| premium_frequency | monthly / quarterly / annual |
| payment_method | GIRO / credit_card / manual_paynow |
| inception_date, next_anniversary_date | Policy dates |
| next_premium_due_date | Next (or most recently missed) premium due date; blank where no premium is due |
| status | `inforce` / `grace_period` / `lapsed` / `paid_up` / `surrendered` / `claim_paid` / `claim_paid_death` |
| days_past_due | Days since the missed premium due date (0 if current) |
| missed_payments_12m | Count of premiums missed in the last 12 months, including ones later recovered |
| last_premium_paid_date | Most recent premium receipt |
| riders | Semicolon-separated |
| surrender_value_sgd | Indicative; 0 where not applicable |
| notes | Free-text from the policy admin system |

## interactions.csv (160 rows)
| field | meaning |
|---|---|
| interaction_id | Primary key |
| client_id, advisor_id | Who was contacted, by whom |
| date, channel | phone / whatsapp / in_person / email |
| interaction_type | servicing_call, annual_review, claim_assistance, policy_change, birthday_greeting, payment_reminder, lapse_follow_up, complaint |
| outcome_notes | Free text |

## Notes
- The grace period for missed premiums is 30 days; a policy lapses on day 31.
- Any recommendation of a new product or change to coverage is regulated financial advice in Singapore and must be made by a licensed representative.
- You may add, remove or correct data. Tell us what you changed and why.
