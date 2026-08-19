# Repository instructions

- This is an independent clean-room learning repository for one bounded synthetic limit-order market.
- Keep command received, order accepted, reservation committed, trade executed, settlement committed, market-data publication,
  real exchange activity, and external acceptance as separate facts.
- Never add real trader/account/order data, credentials, venue endpoints, internal topology, or copied third-party prose, diagrams,
  fixtures, benchmarks, or code.
- Preserve unrelated work. Stage exact paths, keep commits single-purpose, and do not add co-author trailers unless requested.
- Correctness conclusions require real database/process boundaries in public CI; mocks cannot prove reservation conservation,
  price-time priority, cancel/match serialization, response-loss recovery, or replay-equivalent projections.
- A benchmark is a bounded synthetic observation for its exact fixture and runtime, never market throughput, latency, fairness,
  availability, durability, regulatory compliance, production capacity, or external acceptance.
