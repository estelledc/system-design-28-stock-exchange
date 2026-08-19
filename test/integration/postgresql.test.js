import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, beforeEach, test } from 'node:test';
import { createExchangeServer } from '../../src/http.js';
import { accountFixture, createAccount, createRuntime, orderFixture } from '../helpers/runtime.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; PostgreSQL tests never skip infrastructure');

let runtime;

before(async () => {
  runtime = await createRuntime(databaseUrl, { reset: true });
});

beforeEach(async () => {
  await runtime.repository.reset();
});

after(async () => {
  await runtime?.close();
});

test('account genesis and order identity replay exact results while changed intent conflicts', async () => {
  const accountInput = accountFixture('identity', 1_000, 10);
  const account = await runtime.service.createAccount(accountInput);
  assert.equal(account.cashAvailable, 1_000);
  assert.equal(account.inventoryAvailable, 10);
  assert.deepEqual(await runtime.service.createAccount(accountInput), account);
  await assert.rejects(
    runtime.service.createAccount({ ...accountInput, cashEndowment: 999 }),
    { code: 'intent_conflict' }
  );

  const orderInput = orderFixture('identity', account.accountId, 'buy', 10, 5);
  const submitted = await runtime.service.submitOrder(orderInput);
  assert.equal(submitted.accepted, true);
  assert.equal(submitted.order.state, 'open');
  assert.deepEqual(await runtime.service.submitOrder(orderInput), submitted);
  await assert.rejects(
    runtime.service.submitOrder({ ...orderInput, priceTicks: 11 }),
    { code: 'intent_conflict' }
  );
});

test('concurrent orders reserve at most the account cash that exists', async () => {
  const buyer = await createAccount(runtime.service, 'reserve_buyer', 100, 0);
  const [first, second] = await Promise.all([
    runtime.service.submitOrder(orderFixture('reserve_one', buyer.accountId, 'buy', 10, 10)),
    runtime.service.submitOrder(orderFixture('reserve_two', buyer.accountId, 'buy', 10, 10))
  ]);
  assert.equal([first, second].filter((item) => item.accepted).length, 1);
  assert.equal([first, second].filter((item) => item.code === 'insufficient_resource').length, 1);
  const accepted = [first, second].find((item) => item.accepted);
  const evidence = await runtime.service.getOrderEvidence(accepted.order.orderId);
  assert.equal(evidence.currentReservation, 100);
  const audit = await runtime.service.runAudit({
    requestKey: 'req_audit_reserve', auditId: 'audit_reserve', asOfSequence: null
  });
  assert.equal(audit.passed, true);
  assert.equal(audit.replayCashSupply, 100);
  assert.equal(audit.materializedCashTotal, 100);
});

test('matching uses best price then FIFO, maker price, and bounded partial fills', async () => {
  const first = await createAccount(runtime.service, 'fifo_first', 0, 10);
  const second = await createAccount(runtime.service, 'fifo_second', 0, 10);
  const worse = await createAccount(runtime.service, 'fifo_worse', 0, 10);
  const buyer = await createAccount(runtime.service, 'fifo_buyer', 5_000, 0);
  await runtime.service.submitOrder(orderFixture('fifo_first', first.accountId, 'sell', 90, 10));
  await runtime.service.submitOrder(orderFixture('fifo_second', second.accountId, 'sell', 90, 10));
  await runtime.service.submitOrder(orderFixture('fifo_worse', worse.accountId, 'sell', 100, 10));

  const taker = await runtime.service.submitOrder(orderFixture('fifo_taker', buyer.accountId, 'buy', 110, 25));
  assert.deepEqual(taker.executions.map((item) => [item.makerOrderId, item.priceTicks, item.quantity]), [
    ['order_fifo_first', 90, 10],
    ['order_fifo_second', 90, 10],
    ['order_fifo_worse', 100, 5]
  ]);
  assert.equal(taker.order.state, 'filled');
  const worseEvidence = await runtime.service.getOrderEvidence('order_fifo_worse');
  assert.equal(worseEvidence.order.remainingQuantity, 5);
  assert.equal(worseEvidence.currentReservation, 5);
  const buyerEvidence = await runtime.service.getOrderEvidence('order_fifo_taker');
  assert.equal(buyerEvidence.currentReservation, 0);
  const audit = await runtime.service.runAudit({
    requestKey: 'req_audit_fifo', auditId: 'audit_fifo', asOfSequence: null
  });
  assert.equal(audit.passed, true);
  assert.equal(audit.executionCount, 3);
});

test('cancel releases only the open remainder once and exact retry replays', async () => {
  const buyer = await createAccount(runtime.service, 'cancel_buyer', 1_000, 0);
  const submitted = await runtime.service.submitOrder(orderFixture('cancel_bid', buyer.accountId, 'buy', 50, 10));
  assert.equal((await runtime.service.getOrderEvidence(submitted.order.orderId)).currentReservation, 500);
  const input = { requestKey: 'req_cancel_bid', expectedOrderVersion: 1 };
  const canceled = await runtime.service.cancelOrder(submitted.order.orderId, input);
  assert.equal(canceled.canceledQuantity, 10);
  assert.equal(canceled.releasedResource, 500);
  assert.deepEqual(await runtime.service.cancelOrder(submitted.order.orderId, input), canceled);
  const evidence = await runtime.service.getOrderEvidence(submitted.order.orderId);
  assert.equal(evidence.order.state, 'canceled');
  assert.equal(evidence.currentReservation, 0);
  const audit = await runtime.service.runAudit({
    requestKey: 'req_audit_cancel', auditId: 'audit_cancel', asOfSequence: null
  });
  assert.equal(audit.passed, true);
});

test('cancel racing a compatible taker has one authority winner for every unit', async () => {
  const seller = await createAccount(runtime.service, 'race_seller', 0, 10);
  const buyer = await createAccount(runtime.service, 'race_buyer', 2_000, 0);
  await runtime.service.submitOrder(orderFixture('race_ask', seller.accountId, 'sell', 100, 10));
  const [cancel, taker] = await Promise.all([
    runtime.service.cancelOrder('order_race_ask', { requestKey: 'req_cancel_race', expectedOrderVersion: 1 }),
    runtime.service.submitOrder(orderFixture('race_taker', buyer.accountId, 'buy', 100, 10))
  ]);
  const ask = await runtime.service.getOrderEvidence('order_race_ask');
  if (cancel.cancelCommitted) {
    assert.equal(ask.order.state, 'canceled');
    assert.equal(taker.executions.length, 0);
    assert.equal(taker.order.state, 'open');
  } else {
    assert.equal(cancel.code, 'stale_order_version');
    assert.equal(ask.order.state, 'filled');
    assert.equal(taker.executions.length, 1);
    assert.equal(taker.order.state, 'filled');
  }
  const audit = await runtime.service.runAudit({
    requestKey: 'req_audit_race', auditId: 'audit_race', asOfSequence: null
  });
  assert.equal(audit.passed, true);
});

test('market halt and resume fence stale generations without accepting an order', async () => {
  const buyer = await createAccount(runtime.service, 'fence_buyer', 1_000, 0);
  const haltInput = { requestKey: 'req_market_halt', expectedGeneration: 1, targetState: 'halted' };
  const halted = await runtime.service.transitionMarket(haltInput);
  assert.equal(halted.state, 'halted');
  assert.equal(halted.generation, 2);
  assert.deepEqual(await runtime.service.transitionMarket(haltInput), halted);
  const blocked = await runtime.service.submitOrder(orderFixture(
    'fence_blocked', buyer.accountId, 'buy', 10, 1, { marketGeneration: 1 }
  ));
  assert.equal(blocked.code, 'market_not_open');
  const resumed = await runtime.service.transitionMarket({
    requestKey: 'req_market_resume', expectedGeneration: 2, targetState: 'open'
  });
  assert.equal(resumed.generation, 3);
  const stale = await runtime.service.submitOrder(orderFixture(
    'fence_stale', buyer.accountId, 'buy', 10, 1, { marketGeneration: 1 }
  ));
  assert.equal(stale.code, 'stale_market_generation');
  const accepted = await runtime.service.submitOrder(orderFixture(
    'fence_current', buyer.accountId, 'buy', 10, 1, { marketGeneration: 3 }
  ));
  assert.equal(accepted.accepted, true);
});

test('same-account crossing rejects atomically and disable waits for reservations', async () => {
  const account = await createAccount(runtime.service, 'self_actor', 1_000, 10);
  await runtime.service.submitOrder(orderFixture('self_ask', account.accountId, 'sell', 100, 5));
  const rejected = await runtime.service.submitOrder(orderFixture('self_bid', account.accountId, 'buy', 100, 5));
  assert.equal(rejected.code, 'self_cross_rejected');
  const disabledEarly = await runtime.service.disableAccount(account.accountId, {
    requestKey: 'req_disable_early', expectedGeneration: 1
  });
  assert.equal(disabledEarly.code, 'account_has_reservations');
  await runtime.service.cancelOrder('order_self_ask', { requestKey: 'req_cancel_self', expectedOrderVersion: 1 });
  const disabled = await runtime.service.disableAccount(account.accountId, {
    requestKey: 'req_disable_final', expectedGeneration: 1
  });
  assert.equal(disabled.state, 'disabled');
  assert.equal(disabled.generation, 2);
  const audit = await runtime.service.runAudit({
    requestKey: 'req_audit_self', auditId: 'audit_self', asOfSequence: null
  });
  assert.equal(audit.passed, true);
});

test('publication pages stay bound to one sequence while the live book changes', async () => {
  const seller = await createAccount(runtime.service, 'page_seller', 0, 10);
  const buyer = await createAccount(runtime.service, 'page_buyer', 1_000, 0);
  await runtime.service.submitOrder(orderFixture('page_ask', seller.accountId, 'sell', 110, 5));
  await runtime.service.submitOrder(orderFixture('page_bid', buyer.accountId, 'buy', 90, 5));
  const input = { requestKey: 'req_publication_stable', publicationId: 'publication_stable', asOfSequence: null };
  const publication = await runtime.service.publishMarketData(input);
  assert.equal(publication.bookItemCount, 2);
  const first = await runtime.service.getPublicationPage(publication.publicationId, 'book', null, 1);
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);

  const buyerTwo = await createAccount(runtime.service, 'page_buyer_two', 1_000, 0);
  await runtime.service.submitOrder(orderFixture('page_new_bid', buyerTwo.accountId, 'buy', 95, 1));
  const second = await runtime.service.getPublicationPage(publication.publicationId, 'book', first.nextCursor, 1);
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(second.asOfSequence, publication.asOfSequence);
  assert.equal(second.manifestDigest, publication.manifestDigest);
  assert.deepEqual(await runtime.service.publishMarketData(input), publication);
  await assert.rejects(
    runtime.service.getPublicationPage(publication.publicationId, 'book', first.nextCursor, 2),
    { code: 'invalid_cursor' }
  );
});

test('audit detects projection tamper, immutable history rejects mutation, and restart preserves evidence', async () => {
  const seller = await createAccount(runtime.service, 'audit_seller', 0, 2);
  const buyer = await createAccount(runtime.service, 'audit_buyer', 1_000, 0);
  await runtime.service.submitOrder(orderFixture('audit_ask', seller.accountId, 'sell', 100, 2));
  await runtime.service.submitOrder(orderFixture('audit_bid', buyer.accountId, 'buy', 100, 2));
  const clean = await runtime.service.runAudit({
    requestKey: 'req_audit_clean', auditId: 'audit_clean', asOfSequence: null
  });
  assert.equal(clean.passed, true);
  await assert.rejects(
    runtime.pool.query("UPDATE market_events SET entity_id = 'changed' WHERE sequence = 1"),
    (error) => error.code === '23514'
  );
  await runtime.pool.query('UPDATE accounts SET cash_available = cash_available + 1 WHERE account_id = $1', [buyer.accountId]);
  const failed = await runtime.service.runAudit({
    requestKey: 'req_audit_tamper', auditId: 'audit_tamper', asOfSequence: null
  });
  assert.equal(failed.passed, false);
  assert.ok(failed.mismatches.includes('account_projection'));
  assert.ok(failed.mismatches.includes('cash_conservation'));
  assert.equal(failed.repaired, false);

  const restarted = await createRuntime(databaseUrl);
  try {
    const evidence = await restarted.service.getOrderEvidence('order_audit_bid');
    assert.equal(evidence.executions.length, 1);
    assert.equal(evidence.externalAcceptance, false);
  } finally {
    await restarted.close();
  }
});

test('real HTTP slice returns committed synthetic evidence with external outcomes false', async () => {
  const server = await createExchangeServer(runtime.service);
  const { port } = server.address();
  try {
    const createdResponse = await fetch(`http://127.0.0.1:${port}/v1/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(accountFixture('http_real', 500, 0))
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.externalAcceptance, false);
    const orderResponse = await fetch(`http://127.0.0.1:${port}/v1/orders`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(orderFixture('http_real', created.accountId, 'buy', 10, 2))
    });
    assert.equal(orderResponse.status, 201);
    const order = await orderResponse.json();
    assert.equal(order.accepted, true);
    assert.equal(order.realOrderPlaced, false);
    const stateResponse = await fetch(`http://127.0.0.1:${port}/v1/state`);
    assert.equal(stateResponse.status, 200);
    assert.equal((await stateResponse.json()).accounts, 1);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
