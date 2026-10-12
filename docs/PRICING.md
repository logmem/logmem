# LogMem pricing (proposal, 2026-10-12)

Status: proposed by Mikey and claude-code, not published. It replaces the flat $49/$99/$199 draft in the LogMem
Cloud PRD. Hosted plans need hosted spaces, quotas and billing (GAPS D4, P4), and the public release waits on the
trademark knockout (Oct 15). Until both land, the only live offer is open source on your own Redis, plus a hosted waitlist.

## What we sell

LogMem is the shared log for a team of agents: who did what, handoffs, approvals from a human, and recaps, every
write attributed. Memory products (Mem0, Zep, Supermemory, Cognee) sell recall for one agent. We copy their pricing
structure, not their unit. The competitor scan from 2026-10-12 is the source for every outside price below.

Three rules:

1. **One meter: entries written per month.** Reads, Briefs, recall and the admin app are not metered.
2. **Audit trail and approvals on every plan.** Competitors gate audit logs behind Enterprise. For LogMem they are
   the product.
3. **Never drop a write silently.** Agents coordinate through LogMem, so a lost entry looks like LogMem lost their
   work (see "Caps" below).

## Plans

| | Open source | Free | **Dev** | **Pro** | **Team** | **Agency** | Enterprise |
|---|---|---|---|---|---|---|---|
| Price / month | $0 | $0 | **$19** | **$49** | **$99** | **$199** | Contact sales |
| Hosting | your Redis | hosted | hosted | hosted | hosted | hosted | hosted, BYOC or on-prem |
| Spaces | unlimited | 1 | 1 | 3 | 10 | 30 client spaces | custom |
| Agents | unlimited | 3 | 5 | 25 | unlimited | unlimited | unlimited |
| Entries / month | unlimited | 10k | 50k | 150k | 500k | 1.5M | custom |
| History | yours | 7 days | 30 days | 90 days | 1 year | 1 year | custom |
| Human approvers | yes | owner only | owner only | 3 seats | 10 seats | 25 seats | unlimited |
| Webhooks, Slack / Mattermost approvals | yes | no | no | yes | yes | yes | yes |
| Export, audit download | yes | no | no | yes | yes | yes | yes |
| Per-client scorecards, white-label | no | no | no | no | no | yes | yes |
| Overage | n/a | none | none (upgrade) | ~$2 / 10k | ~$2 / 10k | ~$1.50 / 10k | contract |
| Support | community | community | email | email | priority | priority | SLA |
| SSO, SOC2-ready logs, HIPAA | no | no | no | no | no | no | yes |

Annual billing: about 17% off on Dev, Pro and Team (matches Zep's published toggle). Almost nobody else publishes
annual prices, so we do.

## Why each step exists

- **Free → Dev ($19).** $19-20 is the market's first paid price (Mem0 Starter $19, Supermemory Pro $19, Letta Pro
  $20). It gives a solo developer an easy first payment. Free keeps only 7 days of history so that people who use
  it seriously move up.
- **Dev → Pro ($49).** Dev is for side projects. A real production app outgrows it on three things a side project
  never needs: a second human approver, alerts when an agent is stuck or waiting, and audit history past 30 days.
  That fence works without a "non-commercial" rule we couldn't enforce.
- **Pro → Team ($99).** Many spaces and unlimited agents for a team running several projects. It sits in the empty
  gap between Mem0 $19 and Mem0 $249, and under Zep Flex $125.
- **Team → Agency ($199).** One space per client, with per-client scorecards and audit export. It is under Mem0 Pro
  ($249) and Supermemory Scale ($399).
- **Enterprise.** Somewhere to put SSO, BYOC/on-prem and compliance deals, as every competitor does.

## Caps

When a Free or Dev space reaches its monthly entry cap:

1. Writes keep landing for a 10% grace margin.
2. The agent's Brief and the admin app show an "at cap" warning, and the owner gets an email.
3. Past the grace margin, writes are refused with a clear `upgrade_required` error. Nothing is dropped silently.
4. Reads, Briefs and recall keep working.

On paid plans the overage is billed and nothing is refused.

## Open questions for Mikey

1. Approve this ladder, or keep the PRD's flat $49/$99/$199.
2. Whether the open-source tier ships under Apache-2.0 or MIT. Every competitor uses one of the two.
3. Whether the Agency tier launches with v1, or after the first agency customer.
