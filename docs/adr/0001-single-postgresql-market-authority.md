# ADR 0001: one PostgreSQL market authority

- Status: accepted for v0.1
- Date: 2026-08-19

## Context

The case spans low-latency order entry, matching, resource checks, market data, reporting, recovery, and real-world regulation. A
small practice repository cannot honestly reproduce those domains. Its useful question is narrower: can one executable authority
make price-time order, reservation conservation, partial-fill settlement, cancellation ordering, replay, and stable reads visible?

## Decision

Use PostgreSQL 17 as the sole durable authority. Every write locks one `LABX` market row before other mutable rows. Submission
reserves resources, accepts the order, matches all compatible resting orders, settles synthetic assets, appends events/executions,
updates projections, stores replay result, and commits in one transaction.

Use one immutable execution per matched pair and one total market sequence for accepted events. Market-data publications copy a
sequence-bound cut. Audits replay immutable economic events and compare current projections without repair.

## Consequences

Positive:

- transaction commit is an unambiguous local boundary for order, reservation, execution, settlement, and replay result;
- one lock gives deterministic cancel/taker and maker selection without an unproved distributed sequencer;
- real PostgreSQL/process tests can falsify concurrency, response-loss, immutability, and recovery claims;
- the schema and event stream make cash/inventory/order conservation inspectable.

Negative:

- one symbol's writes serialize and cannot support the chapter's scale or microsecond target;
- database and host availability/durability are not proved;
- no independent matching, risk, wallet, clearing, market-data, or reporting failure domain exists;
- immediate in-transaction matching is not a blueprint for a production exchange;
- event replay is version-bound and does not solve schema/code evolution.

## Rejected alternatives

- **In-memory book plus `/dev/shm` event bus:** faster-looking but cannot provide the required durable commit and crash receipts.
- **Kafka or a custom sequencer with separate settlement database:** introduces dual-write, lag, fencing, and recovery protocols that
  exceed the bounded invariant target.
- **Mocks only:** cannot prove row locks, transaction rollback, restart, or commit-before-response replay.
- **Create multiple symbol/account shards now:** no current second authority consumer or cross-shard settlement requirement exists;
  it would add an unproved distributed transaction rather than strengthen v0.1.

## Revisit triggers

Revisit only with a concrete requirement and executable environment for at least one of: multiple hot symbols, independent risk or
clearing authority, measured latency target, tested leader failover, replay-version migration, or real market-data delivery. The
replacement ADR must preserve stable command identity, resource conservation, deterministic priority, fenced leadership, and exact
outcome boundaries.
