# Closed-book contract: a conserved synthetic price-time market

## Reading boundary

This contract was written from the case title alone, before reading the fixed `system-design-notes` chapter. “Stock Exchange” names
a large problem family, not a market structure, asset class, order vocabulary, priority rule, clearing model, regulatory regime,
scale, latency target, or availability promise. Accounts, a synthetic instrument, limit orders, reservations, one matching
authority, immutable executions, atomic synthetic settlement, market-data publications, and replay audits are hypotheses for this
lab—not facts about a real exchange. Later research must record confirmations, conflicts, omissions, and changes instead of
silently rewriting this baseline.

## Users and core behavior

### Synthetic market operator

1. The bounded lab creates one instrument, `LABX`, with integer price ticks and integer quantities. It creates explicit synthetic
   cash and inventory endowments; user accounts do not silently mint either asset.
2. The operator opens, halts, resumes, and closes the market through monotone market generations. An order names the generation it
   expects, so a halt/resume permanently fences stale commands.
3. One database authority allocates a total market sequence for accepted state transitions. Sequence is commit order inside this
   lab, not wall-clock order, geographic fairness, regulatory time, or a real venue timestamp.

### Synthetic trader caller

1. A caller submits a stable command/order identity, account, side, positive integer limit price, positive integer quantity, symbol,
   and expected account/market generations.
2. Exact retry returns the original acceptance or terminal result. Reusing a command or order identity with changed intent is a
   typed conflict.
3. Acceptance atomically reserves `limit price × quantity` synthetic cash for a buy or quantity units of synthetic inventory for a
   sell. Insufficient available resources reject without a live order or partial reservation.
4. Only limit orders exist in v0.1. An accepted order may remain open, fill partially, fill completely, or later cancel. Amendment is
   not an in-place mutation; it is out of scope unless expressed as a separately ordered cancel plus new order.

### Matching and settlement authority

1. For one symbol, the highest-priced buy and lowest-priced sell are best. Within one price, lower acceptance sequence wins. A final
   opaque order-ID tie-breaker makes corrupted/equal test input deterministic but does not replace the unique sequence contract.
2. Orders cross only when best buy price is at least best sell price. Execution quantity is the smaller remaining quantity.
3. The resting order is maker; execution price is the maker limit. This is a lab rule to make replay deterministic, not a claim
   about every exchange.
4. Each match appends an immutable execution and atomically updates both order remainders, reservations, cash, inventory, and market
   sequence. No order fills beyond its accepted quantity.
5. For a buy, reserved cash decreases by `buy limit × executed quantity`; seller available cash increases by `execution price ×
   quantity`; price improvement returns to buyer available cash. For a sell, reserved inventory decreases and buyer available
   inventory increases. Total synthetic cash and `LABX` supply remain conserved.
6. Cancel and match serialize under the same market authority. Whichever receives the next sequence wins; cancellation releases
   only the still-open reservation and never erases prior executions.
7. Losing a response after accept, match, settle, or cancel replays the stored result. It cannot reserve, trade, settle, or release
   twice.

### Market-data reader and audit operator

1. A publication request selects an authority sequence, then stores an immutable ordered view of open price levels and executions
   through that cut.
2. Pages and cursors bind the publication identity, sequence, generation, ordering contract, and digest. Later orders cannot drift
   an existing page series.
3. A bounded audit replays immutable accepted-order commands, executions, cancellations, and endowments through one sequence, then
   compares reconstructed orders, reservations, balances, positions, and published digests with materialized projections.
4. A matching, publication, or audit receipt proves only internal synthetic state. It does not prove a real order reached a venue,
   a security changed ownership, funds cleared, a participant read market data, or an external party accepted an outcome.

## Non-goals for v0.1

- real traders, customers, brokers, venues, securities, cash, positions, orders, executions, market data, credentials, endpoints,
  notifications, statements, support cases, or operational data;
- market/stop/stop-limit/iceberg/peg/post-only/fill-or-kill/immediate-or-cancel/day/GTC orders, replace, cancel-all, baskets,
  derivatives, options, futures, short selling, margin, leverage, borrow, lending, fees, tax, FX, dividends, or corporate actions;
- opening/closing/call auctions, crossed-market uncrossing, price bands, collars, volatility pauses, circuit breakers, tick-table
  changes, lot rules, self-trade prevention, routing, smart order routing, dark pools, multiple venues, or consolidated feeds;
- real pre-trade risk, beneficial ownership, authentication, authorization, KYC/AML, sanctions, fraud, manipulation/surveillance,
  regulatory reporting, best execution, fairness certification, clock synchronization, or legal advice;
- custody, deposits/withdrawals, banking rails, clearing members, central counterparty, netting, T+ settlement, settlement failure,
  reconciliation with an external ledger, finality, or asset transfer outside this database;
- public ingress, TLS/PKI, multi-tenant isolation, encryption/KMS, secret management, billing, deletion compliance, or regulated-data
  handling;
- unbounded accounts/orders/executions/publications/pages/audits/receipts or retention;
- distributed sequencers, partitioned books, active-active matching, consensus, PostgreSQL HA, multi-region authority, disaster
  recovery, backup/restore, production deployment, latency/SLA, real-world fairness, user consumption, or external acceptance.

## Hypothetical scale envelope

These numbers choose pressure points; they are not sourced requirements:

- 100 million commands/day is about 1,157/s average and about 115,741/s at a 100× burst;
- one popular symbol can carry most traffic, so symbol partitioning does not remove a hot-book serialization limit;
- an order producing 100 partial executions creates far more write and publication work than one command count suggests;
- a 0.02% commit-response-loss rate would still create 20,000 replay decisions/day;
- one market-data snapshot every 100 ms yields 864,000 publications/day before pages, depth variants, or regional copies;
- retention must outlive every supported command retry, publication cursor, replay audit, and investigation horizon.

The runnable lab will use at most 32 accounts, one symbol, 2,048 orders, 4,096 executions, 128 publications, 512 pages, and 32
audits in one PostgreSQL database. Prices are positive integers no greater than 1,000,000 ticks; quantities and each synthetic
endowment are bounded so multiplication fits the chosen integer representation. The lab will not extrapolate the fixture into real
market capacity or latency.

## Candidate data and state model

```text
market -> symbol + state + generation + authority_sequence
account -> generation + cash_available/reserved + LABX_available/reserved
request_key + operation -> immutable intent_digest + original result
order_id -> account + side + limit_price + original/remaining_quantity + state + accepted_sequence
execution_id -> maker/taker/buy/sell order + price + quantity + authority_sequence
market_event -> sequence + kind + immutable subject/result digest
publication_id -> market_generation + as_of_sequence + ordered book/trade digest
publication_page_receipt -> publication + cursor/limit + immutable result digest
audit_id -> as_of_sequence + replay/materialized digests + mismatch counts
```

Opaque generated IDs are identifiers, not secrets or authorization grants. Sequence is one database authority order, not proof of
network arrival order or fairness outside the lab.

## Core invariants

1. **Stable intent.** One request/order identity binds account, symbol, side, price, quantity, and expected generations. Exact retry
   replays; changed intent conflicts.
2. **Integer arithmetic.** Price, quantity, cash, and inventory use bounded integers with checked multiplication/addition. No binary
   float, implicit rounding, decimal currency, fractional security, or real-value claim exists.
3. **Explicit genesis.** Every synthetic cash and inventory unit begins in a declared endowment; order submission cannot mint either.
4. **Reservation before eligibility.** An accepted order and its full initial reservation commit atomically. A visible live order
   never lacks its required cash or inventory.
5. **No overcommit.** Available cash/inventory cannot become negative. Concurrent orders from one account reserve at most its current
   available resources.
6. **Generation fences.** Account and market generation are rechecked while locked. Halt/close or account disable racing submission
   has one authority winner.
7. **Total acceptance order.** Each accepted order receives one unique monotone sequence. Same-price priority follows this sequence,
   not a caller timestamp or process-local clock.
8. **Price compatibility.** An execution exists only when buy limit is at least sell limit. Its price equals the earlier resting
   maker's limit under the v0.1 rule.
9. **Price-time priority.** Matching always chooses highest buy, lowest sell, then lowest acceptance sequence. A later worse order
   cannot jump a better open order.
10. **Quantity conservation.** For every order, remaining quantity plus executed quantity plus canceled quantity equals accepted
    quantity; all terms are non-negative.
11. **One immutable execution.** An execution has stable maker/taker/buy/sell identities, price, quantity, and sequence. Retry never
    duplicates it and cancellation never edits it.
12. **Atomic settlement.** Execution, both order remainders/states, cash reservation/availability, inventory reservation/availability,
    market event, and stored result commit together or none is called executed.
13. **Cash conservation.** Across every account, available plus reserved synthetic cash remains equal to genesis cash after every
    accept, execution, cancel, response replay, and restart.
14. **Inventory conservation.** Across every account, available plus reserved `LABX` remains equal to genesis inventory after every
    transition.
15. **Price improvement is released.** When a buy executes below its limit, the unused reserved difference returns exactly once to
    buyer available cash; later cancellation releases only reservation for the remaining quantity.
16. **Cancel/match is ordered.** Both use the same market authority. A canceled remainder cannot later execute; an already executed
    quantity cannot be released by cancel.
17. **Response loss is replayable.** Market/account state, submit, match, cancel, publication/page, and audit commit-before-response
    return stored results rather than repeat effects.
18. **Projection is accountable.** Materialized orders, accounts, book levels, balances, and positions can be reconstructed from
    genesis plus immutable events/executions through an authority cut; mismatch is typed and never auto-hidden.
19. **Publications bind one cut.** Book levels, trade order, counts, sequence, generation, and digest belong to one as-of sequence;
    later commands do not drift existing pages.
20. **Publication order is total.** Bid levels order by price descending, asks by price ascending, orders by acceptance sequence,
    and executions by authority sequence; cursors name that order and cut.
21. **Retention outlives recovery.** Requests, orders, events, executions, publications, page receipts, and audits survive every
    supported retry/page/replay horizon. Pruning is an explicit beyond-horizon result.
22. **Backpressure is visible.** Account/order/execution/publication/page/audit/body limits reject with typed receipts; timeout or
    drop is never called accepted, executed, settled, canceled, published, or externally accepted.
23. **Ordinary telemetry is market-data bounded.** Logs/metrics omit account/request/order/execution/publication/audit identities,
    balances, positions, prices, quantities, digests, credentials, endpoints, and raw errors.
24. **Internal consistency is not market outcome.** A deterministic conserved book does not prove real venue delivery, ownership,
    clearing, settlement finality, fairness, compliance, production behavior, participant consumption, or external acceptance.

## Initial API sketch

Market/account routes:

- `POST /v1/markets/LABX/open`, `/halt`, `/resume`, and `/close` with stable request and expected state/generation;
- `POST /v1/accounts` with generated account identity and explicit synthetic cash/inventory endowment;
- `POST /v1/accounts/{id}/disable` with stable request and expected generation;
- `GET /v1/operation-receipts/{id}` for response-loss recovery.

Order and matching routes:

- `POST /v1/orders` with stable command/order identity, side, integer price/quantity, and expected generations;
- `POST /v1/matches` with stable command identity and an explicit maximum execution count;
- `POST /v1/orders/{id}/cancel` with stable command identity and expected current order version;
- `GET /v1/orders/{id}/evidence` for immutable intent, reservation, executions, cancel result, and outcome boundaries.

Read and operator routes:

- `POST /v1/publications` with stable publication identity and explicit/current authority sequence;
- `GET /v1/publications/{id}/pages?...` bound to immutable cursor/limit receipts;
- `POST /v1/audits` with stable request/audit identity and explicit/current sequence;
- `GET /v1/state` for low-cardinality account/order/execution/supply/publication/audit/invariant counts.

Exact schema, transaction/lock order, sequence allocator, state vocabulary, maker selection, batch boundary, event schema, replay
algorithm, publication format, retention, authentication, error vocabulary, and limits remain hypotheses until primary sources are
reviewed.

## Failure matrix

| Failure window | Required result |
|---|---|
| caller loses response after account/market transition | exact request returns the one committed generation/result |
| same request/order arrives with changed side/price/quantity | typed conflict; no second reservation or order |
| two buy orders race for final cash | locked account authority accepts at most the affordable set |
| order commit succeeds before response | retry returns the original order, reservation, and acceptance sequence |
| matcher dies before transaction commit | no execution, settlement, or half-updated order is visible |
| matcher dies after execution commit before response | retry/restart returns the same executions and sequence; no duplicate fill |
| cancel races matching | one authority sequence wins for each remaining unit |
| better price arrives during a match batch | every committed execution obeys the locked authority cut; later work reselects best |
| one order fills against several makers | aggregate filled quantity never exceeds accepted quantity; every execution has one price |
| buy executes below its limit | seller receives execution value and buyer gets the exact reservation difference once |
| publication races new orders/executions | existing publication remains bound to its as-of sequence |
| materialized account/book row is tampered | audit reports mismatch; service does not call replay equivalent or conserved |

## Required executable evidence before v0.1 completion

1. A clean-room README, source comparison, requirements, architecture, API, operations, threat model, and at least one ADR.
2. Exact market/account/order/match/cancel/publication/page/audit validation, canonical digests, typed errors, and sensitive-data scans.
3. Generated/property tests for price compatibility, price-time priority, partial fills, no overfill, stable intent, cash/inventory
   conservation, reservation release, total ordering, pages, and replay decisions.
4. Real PostgreSQL tests for concurrent reservation, same-price FIFO, crossed-price/maker-price behavior, multi-fill settlement,
   cancel/match race, generation fence, response-loss replay, stable publication, tamper detection, and restart.
5. True-process crashes covering account/market state, submit, execution settlement, cancel, publication, and audit commits.
6. A bounded benchmark with exact accounts/orders/executions/publications/pages/audits, runtime/database versions, exclusions, and raw
   observations—without exchange throughput, fairness, compliance, SLA, or production extrapolation.
7. Public multi-runtime CI with pinned actions/services, dependency audit, zero skipped infrastructure tests, and exact commit/run
   receipts.
8. Evidence scans that reject realistic trader/account/security/order/credential data and exchange/clearing/external claims without
   matching receipt classes.

## Initial design choices to challenge after source review

- Is the case about order entry, one matching engine, market-data distribution, risk, clearing/settlement, or an entire exchange?
- Is price-time priority required, and how are same-price ties ordered without trusting client clocks?
- Does execution occur at maker price, taker price, another rule, or through an auction?
- Which action reserves resources, and what releases price improvement or canceled remainder without double release?
- Can order acceptance, matching, and settlement share one database transaction in the bounded slice, and where would a real system
  separate them?
- How do cancel, halt, matcher lease loss, and response loss fence stale workers and duplicate commands?
- Can a market-data cursor bind one immutable sequence while the live book changes?
- What event/version/code/schema inputs are required for deterministic replay, beyond retaining execution rows?
- Are order acceptance, execution, clearing, settlement finality, participant receipt, and external acceptance kept distinct?
