# Operations

## Local modes

### Pure gate

Runs formatting/static repository checks and model/property tests without infrastructure. It proves algorithms and validation only;
it cannot prove PostgreSQL locking, transactions, restart, or process-crash recovery.

### Full gate

Requires a disposable PostgreSQL 17 database through `DATABASE_URL`. The test runner resets the lab schema and must never point at a
shared or production database. Missing or wrong infrastructure fails; it is not skipped.

## Planned commands

```bash
npm ci --ignore-scripts
npm run check
DATABASE_URL=postgres://... npm run check:ci
DATABASE_URL=postgres://... npm run smoke:infra
DATABASE_URL=postgres://... npm run benchmark:infra
```

Exact commands become authoritative only after implementation and public CI reproduce them.

## Recovery runbook

1. Treat a lost/timeout response as unknown, not rejected or failed.
2. Retry with the exact operation, request key, and intent. A changed intent must conflict.
3. Inspect the stored local evidence receipt. Do not resubmit under a new identity merely to obtain success.
4. After process restart, reopen PostgreSQL and replay the same command. Confirm identical order/execution/sequence/result digests.
5. Publish a new market-data cut only after authority state is healthy; never mutate an old publication.
6. Run a current-cut audit. On mismatch, stop writes and preserve evidence; the lab deliberately has no auto-repair.

## Crash matrix

Independent child processes will commit and then wait before response for account create, market state, order plus settlement,
cancel, publication, and audit. The harness sends real `SIGKILL`, restarts a fresh process, and requires exact-result replay or
verified immutable readback. A killed PID is not evidence by itself; the committed identity and effect counts are.

## Observability boundary

Allowed ordinary metrics: route/result class, bounded latency bucket, retry/conflict count, market-state label, open-order count,
execution count, audit pass/mismatch count, and infrastructure health. Logs must not contain request/account/order/execution/
publication/audit IDs, price, quantity, balances, positions, hashes, database URLs, credentials, endpoints, SQL, or raw errors.

## Stop conditions

- Any invariant mismatch or immutable-row mutation attempt.
- Ambiguous database outcome that cannot be resolved by the stable request receipt.
- PostgreSQL version/configuration outside the tested envelope.
- Attempt to use real participant, security, cash, order, credential, endpoint, or production data.
- Request to extrapolate fixture timings into exchange capacity, latency, fairness, availability, durability, or SLA.
