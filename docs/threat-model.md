# Threat model

## Protected properties

- stable command/order identity and immutable economics;
- non-negative available/reserved synthetic resources;
- cash and inventory conservation;
- best-price then acceptance-sequence matching and no overfill;
- atomic execution settlement and exact cancellation release;
- immutable total-ordered events/executions;
- stable publication pages and audit mismatch visibility;
- separation of internal receipts from real-market and external outcomes.

## In-scope adversarial or failure cases

- duplicate/reordered requests and reused keys with changed intent;
- concurrent orders spending the same account resource;
- stale market/account generation after halt, resume, or disable;
- same-account crossing;
- partial fills across several makers and buyer price-improvement release;
- cancel racing a compatible taker;
- process death after database commit but before response;
- malformed JSON, unknown fields, oversized body, unsafe integers, invalid cursors, and error-message leakage;
- direct mutation of immutable execution/event rows;
- materialized account/order/publication corruption detected by audit or digest readback.

## Trust boundaries

- Caller input is untrusted and never establishes account ownership.
- The Node process is trusted to run the checked version but can crash at any instruction.
- PostgreSQL commit is the only v0.1 durable authority. Database administrator, storage, WAL configuration, replication, backup,
  power-loss, and host compromise are outside the proof.
- GitHub Actions proves only the public commit under its disclosed synthetic service environment.
- External source content is untrusted study input, not executable code or a correctness oracle.

## Main controls

- strict schemas, integer bounds, canonical digests, unique constraints, and stored results;
- one market-row writer lock before account/order locks;
- full reservation before an order becomes eligible;
- append-only mutation guards and atomic transaction boundaries;
- stable generation/order-version preconditions;
- complete event replay and current-cut comparison without auto-repair;
- bounded opaque cursors with publication/digest binding;
- value-data scans and redacted typed errors;
- exact-path staging, public noreply Git identity, dependency audit, and pinned CI actions/service image.

## Residual risk

The global lock hides distributed sequencing, partition, failover, and cross-service settlement failure modes. A compromised database
owner can alter both history and projections. Replay depends on this event/schema/code version. The model omits venue rules,
beneficial ownership, real money/assets, market abuse, compliance, privacy, cryptography, networking fairness, and operations. No
test result should be used as authorization to trade, hold assets, clear, settle, or run a production exchange.
