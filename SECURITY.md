# Security policy

## Supported scope

Only the current `main` branch is maintained. This repository is a bounded local experiment, not an exchange, broker, trading
venue, matching service, clearing house, custody service, or market-data feed.

## Reporting

Open a private GitHub security advisory for a vulnerability. Do not include real trader/account/order identities, securities,
balances, positions, prices, credentials, database URLs, venue endpoints, production topology, or company data in an issue,
fixture, log, or reproduction.

## Deliberate limits

The lab accepts generated identities, one synthetic `LABX` instrument, integer ticks/quantities, and synthetic `LAB` cash. It does
not implement authentication, beneficial ownership, brokerage, KYC/AML, sanctions, market surveillance, manipulation controls,
price bands, auctions, halts, corporate actions, custody, clearing, settlement finality, reporting, encryption/KMS, tenant
isolation, multi-region failover, or production operations. Passing tests does not establish those properties.
