# Stock Exchange Lab

This clean-room system-design practice starts with one question: can a bounded synthetic market accept, match, settle, cancel,
publish, and replay limit orders without violating price-time priority or creating cash and inventory?

The prompt title is “Stock Exchange.” This repository does not copy a source chapter, exchange API, order-book format, diagram,
benchmark, market rulebook, or proprietary system. The initial contract is frozen from the title alone before the fixed secondary
chapter is read.

## Current status

Closed-book design only. No implementation or production claim exists yet.

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

## Read first

- [Closed-book contract](docs/closed-book-contract.md)
- [Security policy](SECURITY.md)

## Evidence boundary

Command received, order accepted, funds or inventory reserved, execution recorded, synthetic settlement committed, market data
published, a real trade placed, clearing completed, and external acceptance are different facts. The implementation may claim only
the boundaries its executable receipts reach.

## License

MIT. Third-party study material and real trader, account, order, credential, endpoint, or internal data are not included.
