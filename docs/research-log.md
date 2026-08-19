# Research log

## Scope and method

- Case: chapter 28, “Stock Exchange,” at upstream commit `9d8388721e7231442763ad37398b8d82224aa68f`.
- Closed-book baseline: commit `e2af2047c01673e79b75a857609e0d5f28ec0acc`, written before the chapter was read.
- Source comparison and architecture baseline: commit `2db627df2ffff230c88c6de070246b5c58fc4446`.
- Research question: which minimum state transitions and receipts can prove price-time matching, reservation conservation,
  cancellation ordering, stable market-data reads, and restart replay without claiming to reproduce a real exchange?
- Evidence rule: the chapter is a secondary design prompt. Venue specifications and PostgreSQL/RFC documentation calibrate only
  the narrow behavior they state. This repository's tests prove only its own synthetic implementation.
- Clean-room rule: the upstream tree exposes no detected license file at the pinned commit, so no prose, diagram, pseudocode,
  fixture, benchmark, or code is copied into tracked files.

## Acquisition receipts

| Source | Narrow use | Acquisition result |
|---|---|---|
| [Pinned chapter](https://github.com/liquidslr/system-design-notes/blob/9d8388721e7231442763ad37398b8d82224aa68f/28.%20Stock%20Exchange/README.md) | Secondary scope and claims to challenge | blob `6c76fbf43ff06b1270349a7e96d09c469fdcd3c0`; raw SHA-256 `64d97680b040bebb216fda104cf98fd094718bdd6b7c1a7c3bb2ceb52c7c2319`; `tf_64d97680b040bebb_20260819T045716Z`; verification valid |
| [Coinbase Exchange matching engine](https://docs.cdp.coinbase.com/exchange/concepts/matching-engine) | One venue's documented price-time, maker-price, self-trade, and lifecycle behavior | official content fetched through its Mintlify mirror; SHA-256 `fb1b50ba03f5dfca3d4dc6ae7902775c06134ce406da9534f2f1033bca4e9b60`; `tf_fb1b50ba03f5dfca_20260819T045945Z`; verification valid |
| [Nasdaq OUCH 5.0](https://www.nasdaqtrader.com/content/technicalsupport/specifications/TradingProducts/OUCH5.0.pdf) | Native order-entry identities, benign retransmission, ordered inbound processing, accept/cancel/execute messages | raw PDF SHA-256 `770253de8b257ab68700ab5dbf179f806d890890683bf695ab8257585d8c2c00`; `tf_770253de8b257ab6_20260819T045830Z`; raw fetch valid, built-in normalization failed, local `pdftotext` used only for reading |
| [Nasdaq TotalView-ITCH 5.0](https://www.nasdaqtrader.com/content/technicalsupport/specifications/dataproducts/NQTVITCHSpecification.pdf) | Sequenced book reconstruction and add/execute/cancel/delete/replace semantics | raw PDF SHA-256 `45e0531d1b4b3beb886e9618b2ab824a5aa9bda3a99c0dff03509306e68aacc3`; `tf_45e0531d1b4b3beb_20260819T045831Z`; raw fetch valid, built-in normalization failed, local `pdftotext` used only for reading |
| [PostgreSQL 17 explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html) | Row-lock duration, writer exclusion, consistent lock order, and deadlock boundary | SHA-256 `dc13a9df72216e8bde3a9b6a4640493a6af8436c2ce7f06023bbce41e06cac44`; `tf_dc13a9df72216e8b_20260819T045827Z`; verification valid |
| [PostgreSQL 17 transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html) | Snapshot scope and explicit serialization-retry boundary | SHA-256 `70cf332f46ff2d0537fe7706a7922fee9f1d8092fe98a8ea05947fe7cc1c769d`; `tf_70cf332f46ff2d05_20260819T045827Z`; verification valid |
| [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) | Separate HTTP method defaults from an application-level stable command contract | SHA-256 `d431760660ea44e130f6e919dab216df2d0b3a490567a98089267523368fe1e5`; `tf_d431760660ea44e1_20260819T045828Z`; verification valid |

The Nasdaq equity rulebook page was also discovered as a primary candidate for a richer price/display/time policy, but two
TraceFetch attempts failed. It is not used as an anchored source claim. The runnable slice deliberately has displayed limit orders
only, so its simpler price/acceptance-sequence rule is an explicit lab contract rather than an asserted Nasdaq clone.

## Source observations

### Fixed secondary chapter

The chapter correctly surfaces limit-order partial fills, a best bid/ask book, client gateway and risk boundaries, deterministic
sequencing, cancel, market data, reporting, replay, failover questions, and funds withheld for live orders. It also makes several
claims that cannot be carried into an implementation without qualification:

- `1 billion orders/day`, five-times peak, 99.99% availability, millisecond round trip, and later tens-of-microseconds latency are
  interview assumptions, not measured requirements or mutually demonstrated targets.
- Sequencing does not by itself create exactly-once effects. The API has no stable caller identity, intent conflict, stored result,
  or commit-before-response recovery contract.
- The order manager says it withholds funds, but there is no accounting model for concurrent reservation, partial-fill release,
  cancel release, price improvement, inventory, or conservation.
- The market-data publisher is said to reconstruct a book from executions. Executions alone cannot reveal an unmatched add, cancel,
  delete, or replace.
- The pseudocode looks up only the incoming order's exact price, even though compatible better prices must execute first. It advances
  the iterator more than once, uses original rather than remaining quantity in the minimum, removes a maker even after a partial
  fill, and never rests the incoming remainder.
- A map plus linked lists can make operations fast only with an explicit ordered price index and stable node handles; a hash map does
  not make best-price traversal or range lookup constant-time.
- A ring buffer is not inherently lock-free. `mmap` and `/dev/shm` are transport/storage mechanisms, not durable commit receipts;
  `/dev/shm` is intentionally volatile across host loss.
- Warm replicas that process input but suppress output still need leader fencing, a committed cut, state-transfer rules, and split-
  brain prevention. “Reliable UDP,” heartbeat, Raft, and frequent backup are not interchangeable replication/durability proofs.
- Multicast can reduce distribution skew, but it cannot prove simultaneous arrival, equal subscriber processing, or market fairness.
- Candles derived from submitted orders rather than executed trades would encode intent, not traded price; the chapter also mixes
  integer price fields with a `Double` response without a rounding/precision contract.

### Primary calibration

- Nasdaq OUCH documents participant-scoped transaction identities, sequential processing within an order port, sequenced outbound
  messages, and benign retransmission after uncertain delivery. That supports stable identity plus replay, not a generic exactly-
  once network promise.
- OUCH distinguishes acceptance, cancellation/reduction, and execution messages; accepted values can differ from submitted values.
  The lab keeps these facts distinct even though its accepted price is never repriced.
- Nasdaq ITCH describes a sequenced stream with unique order references and cumulative modify effects. Partial execution can emit
  several messages for one order, and consumers must process add plus multiple modify/delete categories to reconstruct current book
  state. The lab therefore publishes complete immutable cuts and audits all event categories.
- Coinbase documents one continuous venue policy: price-time priority and execution at the resting book order's price. The lab uses
  those two rules as explicit local choices, not universal stock-exchange facts, and rejects any account crossing its own open order.
- PostgreSQL row locks last until transaction end, while inconsistent multi-object lock order can deadlock. The lab takes the one
  market row first for every state-changing command, then account/order rows, making the database transaction its bounded authority.
- RFC 9110 does not make `POST` idempotent by default. Replay safety here comes from application request keys, canonical intent
  digests, unique constraints, atomic stored results, and exact-response replay.

## Decisions after comparison

| Closed-book hypothesis | Decision | Reason |
|---|---|---|
| Single synthetic symbol and integer units | keep | Makes price/quantity arithmetic and conservation executable without pretending to model securities or currency |
| Price-time with resting maker price | keep | Confirmed as one documented continuous-book policy; still labeled venue-specific rather than universal |
| Separate match command | change | Submission will reserve, accept, and immediately cross under one transaction; an explicit delayed matcher would leave a crossed book and weaken the continuous-market slice |
| One immutable execution linking both sides | keep | One identity prevents two per-side fill records from drifting; per-order views can project the same execution |
| Full event stream and immutable publications | strengthen | Executions-only reconstruction is incomplete; accept, execute, cancel, market/account state, and endowment events are required |
| PostgreSQL authority | keep | Sacrifices microsecond and billion-order claims to make reservation, matching, settlement, replay, and crash boundaries testable |
| Self-trade behavior out of scope | narrow change | The lab rejects an order that could cross the same account instead of implementing a venue-specific decrement/cancel policy |
| Automatic replay audit | keep | Compares event reconstruction with projections but does not repair corruption or certify a real market |

## Stop line

Research is sufficient for v0.1 when every retained source claim maps to an executable invariant or an explicit exclusion. Further
venue rulebooks, FIX variants, auctions, hidden liquidity, routing, clearing, surveillance, microsecond engineering, and HA would
change the product and evidence target; they are not required to prove this bounded slice.
