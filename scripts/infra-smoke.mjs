import { Pool } from 'pg';
import { ExchangeRepository } from '../src/repository.js';
import { ExchangeService } from '../src/service.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; infrastructure smoke never skips PostgreSQL');

function account(suffix, cashEndowment, inventoryEndowment) {
  return { requestKey: `req_smoke_account_${suffix}`, accountId: `account_smoke_${suffix}`,
    cashEndowment, inventoryEndowment };
}

function order(suffix, accountId, side, priceTicks, quantity) {
  return {
    requestKey: `req_smoke_order_${suffix}`, orderId: `order_smoke_${suffix}`, accountId,
    symbol: 'LABX', side, priceTicks, quantity, expectedMarketGeneration: 1, expectedAccountGeneration: 1
  };
}

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const repository = await new ExchangeRepository(pool).init();
const service = new ExchangeService(repository);

try {
  await repository.reset();
  const sellerA = await service.createAccount(account('seller_a', 0, 5));
  const sellerB = await service.createAccount(account('seller_b', 0, 5));
  const buyer = await service.createAccount(account('buyer', 2_000, 0));
  await service.submitOrder(order('ask_a', sellerA.accountId, 'sell', 90, 5));
  await service.submitOrder(order('ask_b', sellerB.accountId, 'sell', 100, 5));
  const taker = await service.submitOrder(order('taker', buyer.accountId, 'buy', 110, 8));
  const open = await service.submitOrder(order('open_bid', buyer.accountId, 'buy', 50, 2));
  const canceled = await service.cancelOrder(open.order.orderId, {
    requestKey: 'req_smoke_cancel', expectedOrderVersion: open.order.version
  });
  const publication = await service.publishMarketData({
    requestKey: 'req_smoke_publication', publicationId: 'publication_smoke_main', asOfSequence: null
  });
  const executionPage = await service.getPublicationPage(publication.publicationId, 'executions', null, 1);
  const audit = await service.runAudit({ requestKey: 'req_smoke_audit', auditId: 'audit_smoke_main', asOfSequence: null });
  const state = await service.getState();
  const health = await service.health();
  if (taker.executions.length !== 2 || !canceled.cancelCommitted || !audit.passed ||
      state.executions !== 2 || state.accounts !== 3) {
    throw new Error('smoke invariant failed');
  }
  process.stdout.write(`${JSON.stringify({
    runtime: process.version,
    postgresql: health.postgresqlVersion,
    accounts: state.accounts,
    orders: state.orders,
    executions: state.executions,
    openOrders: state.open_orders,
    canceledOrders: 1,
    publications: state.publications,
    executionPageItems: executionPage.items.length,
    audits: state.audits,
    auditPassed: audit.passed,
    realOrderPlaced: state.realOrderPlaced,
    clearingCompleted: state.clearingCompleted,
    externalAcceptance: state.externalAcceptance
  })}\n`);
} finally {
  await repository.close();
}
