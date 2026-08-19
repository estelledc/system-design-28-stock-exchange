# Architecture

## Outcome-first view

The v0.1 authority is one PostgreSQL transaction serialized by the single `LABX` market row. This intentionally trades throughput
and fault-domain breadth for a small proof: an accepted command, its reservation, every resulting execution, synthetic settlement,
book projection, immutable events, and stored replay result become visible together.

```text
HTTP or test caller
        |
        v
validation + canonical intent digest
        |
        v
PostgreSQL transaction
  lock market row
  resolve stable command replay/conflict
  lock account/order rows
  reserve -> accept -> best-price/FIFO loop -> settle
  append events/executions + update projections
  store exact result
        |
        +--> immutable publication cut/page receipts
        +--> event replay audit (compare only; never repair)
```

## Write authority

Every market/account/order/cancel/publication/audit write first locks the one market row with `FOR UPDATE`. The row contains market
state, generation, and the last allocated sequence. This yields a total committed order and prevents two writers from choosing the
same maker, canceling the same remainder, or spending the same reservation concurrently.

This is not a scalability architecture. It is a reference authority for one symbol. A partitioned implementation would need one
authority per book plus a separately designed account/risk/clearing protocol; this repository does not infer that protocol.

## Submission transaction

1. Validate bounded fields and compute canonical intent digest before logging or opening a transaction.
2. Lock market; look up `(operation, request_key)` and return its stored result or raise intent conflict.
3. Verify market `open` and expected generation. Reject reused order identity with a different command.
4. Lock submitting account; verify active generation and reserve full buy notional or sell inventory.
5. Reject if any compatible opposite order belongs to the same account. No partial work commits.
6. Allocate acceptance sequence, insert immutable order economics, append `order_accepted` event.
7. Repeatedly select one compatible maker by price then acceptance sequence. Lock its account, calculate the bounded execution, and
   settle at maker price.
8. For every execution allocate sequence; insert immutable execution/event; update both order quantities/states and account
   available/reserved projections.
9. Leave unmatched incoming quantity open, or mark it filled. Store the full result and commit.

Buy settlement for quantity `q`, buy limit `L`, execution price `P`:

```text
buyer.cash_reserved  -= L * q
buyer.cash_available += (L - P) * q
seller.cash_available += P * q
seller.inventory_reserved -= q
buyer.inventory_available += q
```

The sums of available plus reserved cash and inventory do not change.

## Cancellation transaction

Lock market, resolve stable request, lock order/account, verify expected order version and live remainder, release `limit × remaining`
cash or `remaining` inventory, set canceled quantity/state, allocate one sequence/event, store result, and commit. A taker submission
and cancel therefore cannot both consume/release the same unit: their market-row lock order decides which sees the remainder.

## Immutable history and projections

- `market_events` is append-only and total-ordered. Economic replay uses explicit endowment, accept, execution, and cancel payloads.
- `executions` is append-only and links both sides. It is not duplicated into two independently mutable fills.
- `accounts` and `orders` are materialized projections for command-time checks and reads.
- `request_receipts` binds an operation/request key to intent digest and canonical result inside the effect transaction.
- mutation guards reject update/delete of immutable events and executions.

Replay requires the v0.1 event schema and matching/settlement semantics. Retaining bytes alone would not make future code/schema
versions replay-compatible; that is an explicit evolution gap.

## Publications

A publication locks the market and copies, in one transaction:

- open orders ordered as bids `(price DESC, accepted_sequence, order_id)` then asks `(price ASC, accepted_sequence, order_id)`;
- executions ordered by authority sequence;
- market generation, as-of sequence, counts, and canonical digest.

Pages read only this stored manifest. The cursor encodes publication, section, next offset, and digest; changing the live book cannot
change a prior page. A successful page is a content receipt, not evidence any subscriber received or acted on it.

## Audit

An audit locks the market, selects an as-of sequence, replays immutable economic events into fresh in-memory account/order state,
and compares canonical rows/digests with database projections. It also checks execution rows against execution events and genesis
totals against available plus reserved resources. The audit stores a result receipt but never repairs a mismatch.

Current-cut audit is the v0.1 completion target. Historical audit can replay history, but comparison with historical materialized
projections would require versioned projection snapshots and is not claimed.

## Failure boundaries

- Before commit: PostgreSQL rollback exposes no accepted order, reservation, execution, settlement, cancel, publication, or audit.
- After commit/before response: retry resolves the same request receipt and returns the original result.
- Database unavailable: caller receives a bounded infrastructure error; no outcome is inferred.
- Projection tamper: audit returns explicit mismatch; reads that require a verified publication can abstain.
- Host/process loss: committed PostgreSQL state can be reopened, but no claim covers PostgreSQL host loss, WAL durability settings,
  failover, backup, or power/controller failure.
