# Requirements

## Goal

Build one executable, clean-room, single-symbol market slice that makes these questions falsifiable:

1. Can concurrent limit orders reserve no more synthetic cash/inventory than accounts own?
2. Does matching always choose a compatible best-priced, earliest accepted maker?
3. Do partial fills, price improvement, cancellation, and retries conserve both assets?
4. Can a reader obtain one immutable market-data cut while the live book changes?
5. Can immutable events replay to the same orders, balances, reservations, and positions after restart?

## Functional requirements

### Market and accounts

- Initialize exactly one `LABX/LAB` market in `open` generation 1.
- Create generated accounts with explicit non-negative synthetic cash and inventory endowments.
- Halt, resume, or close the market with a stable command and expected generation.
- Disable an account only when it has no open order or reserved resource.

### Orders

- Accept displayed limit buy/sell orders with stable request and order identities.
- Validate symbol, side, positive bounded integer price/quantity, expected market/account generations, and checked notional.
- Reserve the entire buy limit notional or sell inventory atomically before the order becomes live.
- Reject insufficient resources or a same-account cross without leaving an order, event, or reservation.
- Immediately match all compatible resting liquidity in best-price then acceptance-sequence order.
- Execute at the resting maker limit, append one immutable execution per maker/taker pair, settle both assets, and leave any incoming
  remainder open with its reservation.
- Cancel only an open remainder, release it exactly once, retain executions, and replay an identical cancel response.

### Reads and audit

- Publish an immutable order-book/execution cut through one authority sequence.
- Serve stable book or execution pages whose cursor is bound to publication identity and digest.
- Return order evidence that separates accepted, executed, canceled, externally settled, and accepted-by-user facts.
- Replay immutable economic events through an authority cut and compare them with materialized accounts/orders/executions.
- Report mismatches without mutating or repairing source/projection state.

## Non-functional requirements for the lab

- Real PostgreSQL 17 integration is mandatory; an in-memory fake cannot satisfy the completion gate.
- Every state-changing route is bounded by one market authority row and one database transaction.
- Request replay, generation conflict, insufficient resources, self-cross, stale cancel, publication corruption, and audit mismatch are
  typed outcomes.
- Tests and scripts have finite account/order/execution/page/body limits and fail rather than silently skip missing infrastructure.
- Ordinary logs and errors never include account/order/execution identities, price, quantity, balances, positions, digests,
  credentials, database URLs, or raw database errors.
- Public CI runs Node 22, 24, and 26 against PostgreSQL 17 with no skipped integration test and no high/critical production
  dependency finding.

## Acceptance criteria

- Pure tests prove canonical digest/cursor stability, matching order, arithmetic bounds, model conservation, and error redaction.
- Real database tests prove replay/conflict, concurrent reservation, price-time/maker price, partial multi-fill, cancel versus taker,
  halt/generation fence, immutable events, stable publication, tamper detection, and restart.
- Independent child processes are killed with `SIGKILL` after account, market-state, order/settlement, cancel, publication, and audit
  commits but before responses; retries recover the stored results.
- Smoke and benchmark report exact synthetic counts, runtime/database versions, raw batch timings, and explicit exclusions.
- Documentation records fixed source hashes/receipts, source corrections, architecture, API, operations, threat model, and an ADR.

## Explicitly unproved

Real securities/cash/ownership, broker or venue connectivity, FIX/OUCH/ITCH compatibility, risk/compliance, KYC/AML, surveillance,
auctions, hidden liquidity, replace semantics, routing, fees, margin, clearing/netting/settlement, custody, reporting, subscriber
delivery, fair access, HA/failover, multi-region, backup/restore, production latency/capacity/SLA, user consumption, and external
acceptance.
