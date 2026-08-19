import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkedNotional,
  compareMakers,
  decodeCursor,
  derivedOrderState,
  encodeCursor,
  executionId,
  isCompatible,
  publicationDigest,
  replayEconomicEvents,
  selectCompatibleMakers
} from '../../src/model.js';

test('checked notional keeps integer multiplication inside safe bounds', () => {
  assert.equal(checkedNotional(125, 8), 1_000);
  assert.throws(() => checkedNotional(Number.MAX_SAFE_INTEGER, 2), { code: 'invalid_request' });
});

test('buy and sell compatibility use inequalities rather than exact price only', () => {
  assert.equal(isCompatible('buy', 100, 90), true);
  assert.equal(isCompatible('buy', 100, 101), false);
  assert.equal(isCompatible('sell', 100, 110), true);
  assert.equal(isCompatible('sell', 100, 99), false);
});

test('maker ordering is best price, acceptance sequence, then identity', () => {
  const asks = [
    { orderId: 'order_zed', priceTicks: 100, acceptedSequence: 2 },
    { orderId: 'order_beta', priceTicks: 90, acceptedSequence: 4 },
    { orderId: 'order_alpha', priceTicks: 90, acceptedSequence: 3 }
  ].sort(compareMakers('buy'));
  assert.deepEqual(asks.map((order) => order.orderId), ['order_alpha', 'order_beta', 'order_zed']);
  const bids = [
    { orderId: 'order_low', priceTicks: 99, acceptedSequence: 1 },
    { orderId: 'order_high', priceTicks: 101, acceptedSequence: 2 }
  ].sort(compareMakers('sell'));
  assert.deepEqual(bids.map((order) => order.orderId), ['order_high', 'order_low']);
});

test('maker selection excludes incompatible orders and retains FIFO', () => {
  const incoming = { side: 'buy', priceTicks: 100 };
  const selected = selectCompatibleMakers(incoming, [
    { orderId: 'order_late', side: 'sell', priceTicks: 95, acceptedSequence: 3, remainingQuantity: 2 },
    { orderId: 'order_early', side: 'sell', priceTicks: 95, acceptedSequence: 1, remainingQuantity: 2 },
    { orderId: 'order_expensive', side: 'sell', priceTicks: 101, acceptedSequence: 0, remainingQuantity: 2 },
    { orderId: 'order_bid', side: 'buy', priceTicks: 99, acceptedSequence: 2, remainingQuantity: 2 }
  ]);
  assert.deepEqual(selected.map((order) => order.orderId), ['order_early', 'order_late']);
});

test('derived order state preserves the quantity equation', () => {
  assert.equal(derivedOrderState(10, 0, 0), 'open');
  assert.equal(derivedOrderState(10, 4, 0), 'partially_filled');
  assert.equal(derivedOrderState(10, 10, 0), 'filled');
  assert.equal(derivedOrderState(10, 4, 6), 'canceled');
  assert.throws(() => derivedOrderState(10, 8, 3), { code: 'invariant_violation' });
});

test('execution identity is deterministic and sensitive to authority sequence', () => {
  assert.equal(executionId(7, 'order_maker', 'order_taker'), executionId(7, 'order_maker', 'order_taker'));
  assert.notEqual(executionId(7, 'order_maker', 'order_taker'), executionId(8, 'order_maker', 'order_taker'));
});

test('publication cursor binds identity, digest, section, offset, and page limit', () => {
  const cursor = encodeCursor({
    publicationId: 'publication_alpha', manifestDigest: 'a'.repeat(64), section: 'book', nextOffset: 4, pageLimit: 2
  });
  assert.deepEqual(decodeCursor(cursor), {
    publicationId: 'publication_alpha', manifestDigest: 'a'.repeat(64), section: 'book', nextOffset: 4, pageLimit: 2
  });
  assert.throws(() => decodeCursor('not-json'), { code: 'invalid_cursor' });
});

test('publication digest changes with order or execution content', () => {
  const metadata = { publicationId: 'publication_alpha', asOfSequence: 3 };
  const base = publicationDigest(metadata, [{ side: 'buy', priceTicks: 10 }], []);
  assert.notEqual(base, publicationDigest(metadata, [{ side: 'buy', priceTicks: 11 }], []));
  assert.notEqual(base, publicationDigest(metadata, [], [{ executionId: 'execution_alpha' }]));
});

test('economic replay conserves cash and inventory through fill and cancellation', () => {
  const events = [
    { sequence: 1, eventKind: 'account_endowed', payload: {
      accountId: 'account_seller', generation: 1, cashEndowment: 0, inventoryEndowment: 5
    } },
    { sequence: 2, eventKind: 'account_endowed', payload: {
      accountId: 'account_buyer', generation: 1, cashEndowment: 1_000, inventoryEndowment: 0
    } },
    { sequence: 3, eventKind: 'order_accepted', payload: {
      orderId: 'order_sell', accountId: 'account_seller', side: 'sell', priceTicks: 100, quantity: 5,
      reservedAmount: 5, marketGeneration: 1, accountGeneration: 1
    } },
    { sequence: 4, eventKind: 'order_accepted', payload: {
      orderId: 'order_buy', accountId: 'account_buyer', side: 'buy', priceTicks: 120, quantity: 3,
      reservedAmount: 360, marketGeneration: 1, accountGeneration: 1
    } },
    { sequence: 5, eventKind: 'execution_recorded', payload: {
      executionId: executionId(5, 'order_sell', 'order_buy'), makerOrderId: 'order_sell', takerOrderId: 'order_buy',
      buyOrderId: 'order_buy', sellOrderId: 'order_sell', buyerAccountId: 'account_buyer',
      sellerAccountId: 'account_seller', priceTicks: 100, quantity: 3
    } },
    { sequence: 6, eventKind: 'order_canceled', payload: { orderId: 'order_sell', canceledQuantity: 2 } }
  ];
  const replay = replayEconomicEvents(events);
  assert.equal(replay.cashSupply, 1_000);
  assert.equal(replay.inventorySupply, 5);
  assert.deepEqual(replay.accounts, [
    { accountId: 'account_buyer', state: 'active', generation: 1,
      cashAvailable: 700, cashReserved: 0, inventoryAvailable: 3, inventoryReserved: 0 },
    { accountId: 'account_seller', state: 'active', generation: 1,
      cashAvailable: 300, cashReserved: 0, inventoryAvailable: 2, inventoryReserved: 0 }
  ]);
  assert.equal(replay.orders.find((order) => order.orderId === 'order_sell').state, 'canceled');
  assert.equal(replay.orders.find((order) => order.orderId === 'order_buy').state, 'filled');
  const corrupted = structuredClone(events);
  corrupted[4].payload.priceTicks = 101;
  assert.throws(() => replayEconomicEvents(corrupted), { code: 'invariant_violation' });
});
