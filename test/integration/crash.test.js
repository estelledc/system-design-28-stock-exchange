import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { accountFixture, createAccount, createRuntime, killWorkerAt, orderFixture } from '../helpers/runtime.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; crash tests never skip PostgreSQL');

let directory;
let runtime;
let crashCount = 0;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'exchange-crash-'));
  runtime = await createRuntime(databaseUrl, { reset: true });
});

after(async () => {
  await runtime?.close();
  await rm(directory, { recursive: true, force: true });
});

async function killAt(operation, payload) {
  crashCount += 1;
  const result = await killWorkerAt({ databaseUrl, directory, counter: crashCount, operation, payload });
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGKILL');
}

test('six true SIGKILL commit-before-response windows replay one authority effect each', async () => {
  const buyerInput = accountFixture('crash_buyer', 2_000, 0);
  await killAt('account-after-commit', { account: buyerInput });
  const buyer = await runtime.service.createAccount(buyerInput);
  assert.equal(buyer.cashAvailable, 2_000);

  const haltInput = { requestKey: 'req_crash_halt', expectedGeneration: 1, targetState: 'halted' };
  await killAt('market-state-after-commit', { input: haltInput });
  const halted = await runtime.service.transitionMarket(haltInput);
  assert.equal(halted.state, 'halted');
  const resumed = await runtime.service.transitionMarket({
    requestKey: 'req_crash_resume', expectedGeneration: 2, targetState: 'open'
  });
  assert.equal(resumed.generation, 3);

  const seller = await createAccount(runtime.service, 'crash_seller', 0, 5);
  await runtime.service.submitOrder(orderFixture(
    'crash_ask', seller.accountId, 'sell', 100, 5, { marketGeneration: 3 }
  ));
  const takerInput = orderFixture(
    'crash_taker', buyer.accountId, 'buy', 110, 5, { marketGeneration: 3 }
  );
  await killAt('order-settlement-after-commit', { order: takerInput });
  const taker = await runtime.service.submitOrder(takerInput);
  assert.equal(taker.executions.length, 1);
  assert.equal(taker.executions[0].priceTicks, 100);

  const cancelBuyer = await createAccount(runtime.service, 'crash_cancel_buyer', 500, 0);
  const open = await runtime.service.submitOrder(orderFixture(
    'crash_open', cancelBuyer.accountId, 'buy', 10, 10, { marketGeneration: 3 }
  ));
  const cancelInput = { requestKey: 'req_crash_cancel', expectedOrderVersion: open.order.version };
  await killAt('cancel-after-commit', { orderId: open.order.orderId, input: cancelInput });
  const canceled = await runtime.service.cancelOrder(open.order.orderId, cancelInput);
  assert.equal(canceled.cancelCommitted, true);
  assert.equal(canceled.releasedResource, 100);

  const publicationInput = {
    requestKey: 'req_crash_publication', publicationId: 'publication_crash', asOfSequence: null
  };
  await killAt('publication-after-commit', { publication: publicationInput });
  const publication = await runtime.service.publishMarketData(publicationInput);
  assert.equal(publication.published, true);

  const auditInput = { requestKey: 'req_crash_audit', auditId: 'audit_crash', asOfSequence: null };
  await killAt('audit-after-commit', { audit: auditInput });
  const audit = await runtime.service.runAudit(auditInput);
  assert.equal(audit.passed, true);

  const state = await runtime.service.getState();
  assert.equal(state.accounts, 3);
  assert.equal(state.orders, 3);
  assert.equal(state.executions, 1);
  assert.equal(state.publications, 1);
  assert.equal(state.audits, 1);
  assert.equal(state.externalAcceptance, false);
  assert.equal(crashCount, 6);
});
