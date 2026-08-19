# Verification

## Current conclusion

The v0.1 gate is green locally on Node `v26.7.0` with PostgreSQL `17.11 (Homebrew)` and publicly on Node `22.23.2`, `24.19.0`, and
`26.7.0` with PostgreSQL `17.11`. It proves the disclosed single-database synthetic slice only.

## Commands and local results

```bash
npm ci --ignore-scripts
npm run check
DATABASE_URL=postgres://... npm run test:infra
DATABASE_URL=postgres://... npm run test:crash
DATABASE_URL=postgres://... npm run smoke:infra
DATABASE_URL=postgres://... npm run benchmark:infra
```

Observed on 2026-08-19:

- repository/static scan: all required files, pinned actions/image, source anchors, immutable schema patterns, secret/media/trailer
  checks, and zero skipped-test markers;
- pure tests: 15 passed, 0 failed/skipped/todo;
- PostgreSQL integration: 10 groups passed, 0 failed/skipped/todo;
- process crash: 6 independent children ended by real `SIGKILL` after commit and before response; account, market state,
  order/settlement, cancel, publication, and audit each replayed one stored authority effect;
- smoke: 3 accounts, 4 orders, 2 executions, 1 open order, 1 cancellation, 1 publication, 1 page read, and 1 passing audit; real
  order, clearing, and external acceptance flags remained false;
- `npm audit --audit-level=high`: 0 high/critical production dependency findings.

## Public implementation receipt

Implementation commit: [`6bf37632af8ce0794d7e27874af870f9e8434010`](https://github.com/estelledc/system-design-28-stock-exchange/commit/6bf37632af8ce0794d7e27874af870f9e8434010).

CI run [`32219493671`](https://github.com/estelledc/system-design-28-stock-exchange/actions/runs/32219493671):

| Runtime | Job | Result |
|---|---|---|
| Node 22.23.2 + PostgreSQL 17.11 | [95967193245](https://github.com/estelledc/system-design-28-stock-exchange/actions/runs/32219493671/job/95967193245) | success |
| Node 24.19.0 + PostgreSQL 17.11 | [95967193506](https://github.com/estelledc/system-design-28-stock-exchange/actions/runs/32219493671/job/95967193506) | success |
| Node 26.7.0 + PostgreSQL 17.11 | [95967193288](https://github.com/estelledc/system-design-28-stock-exchange/actions/runs/32219493671/job/95967193288) | success |

Every job reported 15 pure tests, 10 real PostgreSQL groups, 6 true `SIGKILL` processes, the exact smoke/benchmark fixtures, zero
failed/skipped/todo tests, and zero high/critical production dependency findings.

## Database cases

The ten groups cover:

1. account/order exact replay, changed-intent conflict, and explicit endowment;
2. concurrent final-cash reservation;
3. best price, same-price FIFO, maker price, three-maker partial fill, and remaining reservation;
4. cancellation release and exact retry;
5. cancel versus compatible taker serialization;
6. halt/resume market-generation fence;
7. same-account cross rejection and disable/reservation fence;
8. immutable sequence-bound publication pagination after live-book change;
9. immutable history, event replay audit, projection tamper detection, and fresh-process readback;
10. real loopback HTTP command/read boundary with external outcomes false.

## Failure history

The first real PostgreSQL run passed 8 of 10 groups. It exposed two implementation defects rather than infrastructure failures:

- audit selected `sequence::text` and then ordered by the aliased text value, producing `1, 10, 11, 2...`; a multi-fill replay saw
  executions before their accounts/orders. The query now orders by the underlying numeric `market_events.sequence`.
- Node PostgreSQL encoded JavaScript arrays as PostgreSQL arrays when inserting publication JSONB. Book and execution manifests are
  now explicitly serialized as JSON.

The unchanged ten-group suite then passed. No price, FIFO, conservation, cancellation, publication, replay, or outcome assertion was
removed or weakened.

## Bounded benchmark

One sequential local runner used exactly 16 accounts, 144 orders, 64 executions, 16 cancellations, 8 publications plus first-page
reads, 4 replay audits, and 16 order-evidence reads. Raw batch observations:

| Batch | Local milliseconds |
|---|---:|
| create 16 accounts | 37.292 |
| rest 64 maker orders | 121.529 |
| cross 64 taker orders | 158.700 |
| submit and cancel 16 orders | 43.317 |
| create 8 publications and pages | 19.887 |
| run 4 replay audits | 22.962 |
| read 16 order evidence records | 3.061 |

The three public jobs observed these whole-batch ranges for the same fixture: account creation `65.820–224.064 ms`, 64 maker orders
`408.420–1,443.638 ms`, 64 crossing takers `453.681–919.307 ms`, 16 submit/cancels `121.463–256.912 ms`, 8 publication/pages
`46.360–142.444 ms`, 4 audits `47.210–74.980 ms`, and 16 evidence reads `19.433–22.940 ms`.

Both local and public values are whole-batch observations, not per-operation latency, QPS, runtime comparison, capacity, fairness,
availability, durability, or SLA. Shared-runner variation is retained rather than normalized away.

## Not covered

- real participants, securities, cash, beneficial ownership, venue delivery, clearing, settlement finality, or external acceptance;
- FIX/OUCH/ITCH compatibility, venue priority exceptions, replace, hidden liquidity, auctions, routing, price bands, risk,
  surveillance, reporting, or compliance;
- independent matching/risk/wallet/clearing services, distributed sequencer, leader fencing, PostgreSQL/host HA, power loss,
  backup/restore, multi-region, or replay across code/schema versions;
- public ingress, authentication, authorization, encryption/KMS, privacy controls, production deployment, participant consumption,
  latency distribution, capacity, fairness, availability, or SLA.
