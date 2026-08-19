# API contract

## Shared rules

- JSON only; unknown fields are rejected.
- IDs are generated bounded opaque strings and are not authorization grants.
- `requestKey` is stable per operation. The same key and exact canonical intent replay the stored result; changed intent returns
  `intent_conflict`.
- `priceTicks`, `quantity`, cash, and inventory are JSON safe integers within documented bounds. Decimal strings and floats reject.
- Success describes committed internal synthetic state only. No response field implies a real venue, security, cash movement,
  clearing, participant receipt, or external acceptance.

## Market and account commands

### `POST /v1/accounts`

Input: `requestKey`, `accountId`, `cashEndowment`, `inventoryEndowment`.

Result: account generation/state, available/reserved resources, authority sequence, `syntheticOnly: true`, and all external outcome
flags `false`.

### `POST /v1/market/state`

Input: `requestKey`, `expectedGeneration`, `targetState` (`open`, `halted`, or `closed`). `closed` is terminal; `halted -> open`
increments generation and fences stale orders.

### `POST /v1/accounts/{accountId}/disable`

Input: `requestKey`, `expectedGeneration`. Rejects while the account has any open order or reserved resource.

## Order commands

### `POST /v1/orders`

Input: `requestKey`, `orderId`, `accountId`, `symbol: "LABX"`, `side: "buy" | "sell"`, `priceTicks`, `quantity`,
`expectedMarketGeneration`, `expectedAccountGeneration`.

Result: accepted sequence, final order version/state/remainder, zero or more immutable executions, remaining reservation, last
authority sequence, and explicit false outcome flags. Acceptance and all immediate matches settle in one transaction.

Typed rejections include invalid input, stale generation, market unavailable, account unavailable, insufficient resource,
self-cross, order identity conflict, and request intent conflict.

### `POST /v1/orders/{orderId}/cancel`

Input: `requestKey`, `expectedOrderVersion`.

Result: canceled quantity, released resource, final order state/version, authority sequence, and false external flags. Filled or
already canceled orders return a typed terminal/stale result rather than fabricate a new cancel event.

### `GET /v1/orders/{orderId}/evidence`

Returns immutable order economics, executions, cancellation, current reservation, and a boundary object separating internal facts
from real venue delivery/clearing/external acceptance.

## Publication and audit

### `POST /v1/publications`

Input: `requestKey`, `publicationId`, optional `asOfSequence`. v0.1 accepts only the current authority sequence for publication;
historical reconstruction is an audit concern.

Result: immutable book/execution counts, sequence/generation, manifest digest, and publication identity.

### `GET /v1/publications/{publicationId}/pages`

Query: `section=book|executions`, `limit`, optional opaque `cursor`. Cursor must bind the requested publication, section, offset,
limit contract, and digest. The result includes items, next cursor, page digest, and false subscriber/external flags.

### `POST /v1/audits`

Input: `requestKey`, `auditId`, optional `asOfSequence`. v0.1 projection comparison requires the current sequence.

Result: event/order/execution/account counts, genesis and replay totals, canonical digests, mismatch list/count, `passed`, and false
accounting/regulatory/external flags.

### `GET /v1/state`

Returns only low-cardinality counts, market state/generation/sequence, fixed symbol/asset labels, and outcome boundaries. It omits
identities, prices, quantities, balances, positions, and digests.

## Status mapping

- `200`: exact replay or successful read/state transition.
- `201`: first committed account/order/publication/audit creation.
- `400`: bounded validation error.
- `404`: unknown local identity.
- `409`: stable-intent, identity, generation, state, resource, self-cross, stale cancel, or invariant conflict.
- `413`: bounded body limit.
- `503`: database/infrastructure unavailable; no business outcome inferred.
