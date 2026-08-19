# Source comparison

## Conclusion

The fixed chapter is useful as a component checklist, but its central pseudocode and recovery claims are not implementation-ready.
The lab retains the problem—limit-order acceptance, matching, cancellation, market data, replay—and replaces the implied correctness
story with explicit request identity, resource reservations, a total authority sequence, atomic settlement, complete immutable
events, and revision-bound read receipts.

## Confirmed or retained

- Limit orders can rest, execute partially, execute fully, or cancel.
- The best compatible opposite price must be considered before worse prices; same-price orders need a deterministic queue.
- A sequenced input/output history is useful for deterministic replay and market-data consumption.
- Order entry, matching, market-data publication, reporting, risk, funds, and external settlement are different boundaries.
- Integer/fixed-point price representation is preferable to binary floating point.
- Recovery design must consider leader loss, response uncertainty, and replay rather than only happy-path throughput.

## Corrected

| Chapter shortcut | Correction in this lab |
|---|---|
| exact price lookup in matching pseudocode | buy crosses asks at or below its limit; sell crosses bids at or above its limit; best price then acceptance sequence wins |
| iterator advanced twice and maker always removed | each maker is read once; executed quantity uses both remainders; partial maker remains open |
| incoming remainder disappears | unmatched remainder stays reserved and open at its accepted price/sequence |
| sequencer implies exactly once | stable request/order identities, immutable intent digests, unique constraints, transactionally stored results, and replay prove one local effect |
| execution stream rebuilds book | accept, execute, cancel, and state events plus their total sequence are retained; publications copy a complete cut |
| funds check is enough | full limit notional or inventory is atomically reserved; execution and cancellation release exact deltas |
| two fills are the execution model | one immutable execution links maker, taker, buy, sell, price, quantity, and sequence; side-specific views reference it |
| `mmap` or `/dev/shm` is an event-store durability answer | PostgreSQL commit is the only v0.1 durable authority; volatile shared memory is not used |
| standby processing plus heartbeat is HA | no HA claim; a future design needs committed replication, fencing, takeover cut, duplicate suppression, and tested failure model |
| multicast means equal-time delivery | no fairness claim; the lab proves only identical sequence-bound publication content |
| submitted orders create candles | v0.1 omits candles; any later OHLC must derive from printable execution policy, not raw order intent |

## Deliberate divergences

- One PostgreSQL 17 database and one global `LABX` market-row lock replace an in-memory single-host low-latency architecture. This is
  a correctness experiment, not a performance substitute.
- Submission matches immediately in the same transaction. There is no independent matcher queue, so crash recovery can replay one
  stored command result without exposing a crossed committed book.
- Accounts receive explicit synthetic endowments. This is test genesis, not wallet, custody, clearing, margin, or beneficial
  ownership.
- Same-account crossing is rejected before acceptance. The lab does not implement venue-specific self-trade prevention modes.
- Only displayed day-like limit orders exist. There is no replace; callers cancel and submit a new identity, which necessarily loses
  priority.
- Market data is an immutable bounded snapshot and paged receipt, not a multicast feed, L1/L2/L3 protocol, candle service, or
  subscriber-delivery proof.

## Evidence boundary

The tracked documents paraphrase only narrow facts from the cited sources. Source files and local extraction live in ignored
`evidence/`. Passing repository tests can establish deterministic behavior of this implementation, not source truth, Nasdaq or
Coinbase compatibility, regulatory correctness, production latency, availability, fairness, real clearing, or external acceptance.
