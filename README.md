# Stock Exchange Lab

This clean-room system-design practice starts with one question: can a bounded synthetic market accept, match, settle, cancel,
publish, and replay limit orders without violating price-time priority or creating cash and inventory?

The prompt title is “Stock Exchange.” This repository does not copy a source chapter, exchange API, order-book format, diagram,
benchmark, market rulebook, or proprietary system. The initial contract is frozen from the title alone before the fixed secondary
chapter is read.

## Current status

The implementation now exercises one PostgreSQL 17 authority that reserves resources, matches immediately, settles synthetic
assets, publishes immutable cuts, and replays complete economic events. Local pure, real-database, process-crash, smoke, benchmark,
and dependency gates pass. Public multi-runtime CI is still pending, so no remote acceptance claim exists yet.

## Intended runnable slice

```text
stable command
    -> immutable limit-order intent
    -> atomic cash/inventory reservation
    -> one-symbol price-time matching authority
    -> immutable executions + atomic synthetic settlement
    -> sequence-bound market-data publication
    -> deterministic replay and audit receipt
```

Only generated accounts, one synthetic `LABX` instrument, integer price ticks, integer quantities, and synthetic `LAB` cash are
allowed. A passing lab will not establish compatibility with a real venue, broker, security, asset, clearing system, regulator, or
production workload.

## Local evidence

Against Node `v26.7.0` and PostgreSQL `17.11 (Homebrew)`:

- 15 pure tests and 10 real PostgreSQL integration groups: 0 failed, skipped, or todo;
- 6 independent child processes killed with `SIGKILL` after commit and before response;
- smoke: 3 accounts, 4 orders, 2 executions, 1 cancellation, 1 publication/page, and 1 passing replay audit;
- bounded benchmark: 16 accounts, 144 orders, 64 executions, 16 cancellations, 8 publications/pages, 4 audits, and 16 evidence
  reads;
- production dependency audit: 0 high/critical findings.

See [verification](docs/verification.md) for commands, raw batch timings, failure history, and exclusions.

## Run locally

```bash
npm ci --ignore-scripts
npm run check
DATABASE_URL=postgres://... npm run check:ci
```

`check:ci` resets the lab schema. It must point only at a disposable PostgreSQL 17 database, never a shared or production database.

## Read first

- [Closed-book contract](docs/closed-book-contract.md)
- [Research log](docs/research-log.md)
- [Source comparison](docs/source-comparison.md)
- [Requirements](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [API contract](docs/api.md)
- [Operations](docs/operations.md)
- [Threat model](docs/threat-model.md)
- [ADR 0001: one PostgreSQL market authority](docs/adr/0001-single-postgresql-market-authority.md)
- [Verification](docs/verification.md)
- [Security policy](SECURITY.md)

## Evidence boundary

Command received, order accepted, funds or inventory reserved, execution recorded, synthetic settlement committed, market data
published, a real trade placed, clearing completed, and external acceptance are different facts. The implementation may claim only
the boundaries its executable receipts reach.

## License

MIT. Third-party study material and real trader, account, order, credential, endpoint, or internal data are not included.
