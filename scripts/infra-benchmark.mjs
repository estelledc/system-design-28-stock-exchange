import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { ExchangeRepository } from '../src/repository.js';
import { ExchangeService } from '../src/service.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; infrastructure benchmark never skips PostgreSQL');

const pool = new Pool({ connectionString: databaseUrl, max: 20 });
const repository = await new ExchangeRepository(pool).init();
const service = new ExchangeService(repository);

function account(index, kind) {
  return {
    requestKey: `req_bench_account_${kind}_${index}`,
    accountId: `account_bench_${kind}_${index}`,
    cashEndowment: kind === 'buyer' ? 1_000_000 : 0,
    inventoryEndowment: kind === 'seller' ? 16 : 0
  };
}

function order(index, kind, accountId, side, priceTicks) {
  return {
    requestKey: `req_bench_order_${kind}_${index}`,
    orderId: `order_bench_${kind}_${index}`,
    accountId,
    symbol: 'LABX',
    side,
    priceTicks,
    quantity: 1,
    expectedMarketGeneration: 1,
    expectedAccountGeneration: 1
  };
}

async function timed(callback) {
  const started = performance.now();
  const value = await callback();
  return { milliseconds: Number((performance.now() - started).toFixed(3)), value };
}

try {
  await repository.reset();
  const accountPhase = await timed(async () => {
    for (let index = 0; index < 8; index += 1) {
      await service.createAccount(account(index, 'seller'));
      await service.createAccount(account(index, 'buyer'));
    }
  });
  const makerPhase = await timed(async () => {
    for (let index = 0; index < 64; index += 1) {
      await service.submitOrder(order(
        index, 'maker', `account_bench_seller_${index % 8}`, 'sell', 100 + (index % 4)
      ));
    }
  });
  const takerPhase = await timed(async () => {
    for (let index = 0; index < 64; index += 1) {
      const result = await service.submitOrder(order(
        index, 'taker', `account_bench_buyer_${index % 8}`, 'buy', 110
      ));
      if (result.executions.length !== 1) throw new Error('benchmark taker did not execute exactly once');
    }
  });
  const cancelPhase = await timed(async () => {
    for (let index = 0; index < 16; index += 1) {
      const result = await service.submitOrder(order(
        index, 'cancel', `account_bench_buyer_${index % 8}`, 'buy', 50
      ));
      await service.cancelOrder(result.order.orderId, {
        requestKey: `req_bench_cancel_${index}`, expectedOrderVersion: result.order.version
      });
    }
  });
  const publicationPhase = await timed(async () => {
    for (let index = 0; index < 8; index += 1) {
      const publication = await service.publishMarketData({
        requestKey: `req_bench_publication_${index}`,
        publicationId: `publication_bench_${index}`,
        asOfSequence: null
      });
      await service.getPublicationPage(publication.publicationId, 'executions', null, 8);
    }
  });
  const auditPhase = await timed(async () => {
    for (let index = 0; index < 4; index += 1) {
      const audit = await service.runAudit({
        requestKey: `req_bench_audit_${index}`, auditId: `audit_bench_${index}`, asOfSequence: null
      });
      if (!audit.passed) throw new Error('benchmark audit mismatch');
    }
  });
  const evidencePhase = await timed(async () => {
    for (let index = 0; index < 16; index += 1) {
      await service.getOrderEvidence(`order_bench_taker_${index}`);
    }
  });
  const state = await service.getState();
  const health = await service.health();
  process.stdout.write(`${JSON.stringify({
    fixture: {
      accounts: 16,
      orders: 144,
      executions: 64,
      cancellations: 16,
      publications: 8,
      pages: 8,
      audits: 4,
      evidenceReads: 16
    },
    observed: {
      accounts: state.accounts,
      orders: state.orders,
      executions: state.executions,
      openOrders: state.open_orders,
      publications: state.publications,
      audits: state.audits
    },
    milliseconds: {
      createAccounts: accountPhase.milliseconds,
      restMakers: makerPhase.milliseconds,
      crossTakers: takerPhase.milliseconds,
      submitAndCancel: cancelPhase.milliseconds,
      publicationAndPage: publicationPhase.milliseconds,
      replayAudits: auditPhase.milliseconds,
      evidenceReads: evidencePhase.milliseconds
    },
    runtime: process.version,
    postgresql: health.postgresqlVersion,
    exclusions: [
      'real orders, securities, cash, ownership, clearing, settlement, and participant outcomes',
      'FIX, OUCH, ITCH, venue rule, auction, hidden liquidity, routing, risk, and compliance compatibility',
      'PostgreSQL or host HA, failover, backup, power-loss durability, multi-region, production capacity, latency, fairness, and SLA'
    ],
    externalAcceptance: state.externalAcceptance
  })}\n`);
} finally {
  await repository.close();
}
