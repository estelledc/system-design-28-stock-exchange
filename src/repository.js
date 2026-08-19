import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { digest, LIMITS } from './contracts.js';
import { fail } from './errors.js';
import {
  checkedNotional,
  decodeCursor,
  encodeCursor,
  executionId,
  publicResult,
  publicationDigest,
  replayEconomicEvents
} from './model.js';

const SCHEMA_URL = new URL('../sql/schema.sql', import.meta.url);

function integer(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail('invariant_violation', 'database integer exceeds runtime bounds', 500);
  return parsed;
}

function accountView(row, authoritySequence = null) {
  return publicResult({
    accountId: row.account_id,
    state: row.state,
    generation: row.generation,
    cashAvailable: integer(row.cash_available),
    cashReserved: integer(row.cash_reserved),
    inventoryAvailable: integer(row.inventory_available),
    inventoryReserved: integer(row.inventory_reserved),
    authoritySequence,
    syntheticOnly: true
  });
}

function orderView(row) {
  return {
    orderId: row.order_id,
    accountId: row.account_id,
    symbol: row.symbol,
    side: row.side,
    priceTicks: integer(row.limit_price),
    originalQuantity: integer(row.original_quantity),
    remainingQuantity: integer(row.remaining_quantity),
    filledQuantity: integer(row.filled_quantity),
    canceledQuantity: integer(row.canceled_quantity),
    state: row.state,
    version: row.version,
    acceptedSequence: integer(row.accepted_sequence),
    marketGeneration: row.market_generation,
    accountGeneration: row.account_generation
  };
}

function executionView(row) {
  return {
    executionId: row.execution_id,
    sequence: integer(row.sequence),
    makerOrderId: row.maker_order_id,
    takerOrderId: row.taker_order_id,
    buyOrderId: row.buy_order_id,
    sellOrderId: row.sell_order_id,
    buyerAccountId: row.buyer_account_id,
    sellerAccountId: row.seller_account_id,
    priceTicks: integer(row.price_ticks),
    quantity: integer(row.quantity)
  };
}

async function afterCommit(hook, result) {
  if (hook) await hook(result);
  return result;
}

export class ExchangeRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async init() {
    const sql = await readFile(fileURLToPath(SCHEMA_URL), 'utf8');
    await this.pool.query(sql);
    const config = await this.pool.query('SELECT * FROM lab_config WHERE singleton = true');
    if (config.rows.length !== 1 || config.rows[0].schema_version !== 1 || config.rows[0].symbol !== 'LABX' ||
        config.rows[0].quote_asset !== 'LAB') {
      fail('invariant_violation', 'lab genesis contract changed', 500);
    }
    return this;
  }

  async close() {
    await this.pool.end();
  }

  async reset() {
    await this.pool.query(`
      TRUNCATE publication_page_receipts, publications, audits, executions, orders, accounts,
        operation_receipts, market_events RESTART IDENTITY CASCADE;
      UPDATE market_state SET state = 'open', generation = 1, authority_sequence = 0,
        cash_supply = 0, inventory_supply = 0, updated_at = clock_timestamp()
      WHERE singleton = true;
    `);
  }

  async tx(callback, { retries = 3 } = {}) {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (attempt < retries && (error?.code === '40001' || error?.code === '40P01')) continue;
        throw error;
      } finally {
        client.release();
      }
    }
    fail('internal_error', 'transaction retry bound was exhausted', 500);
  }

  async lockMarket(client) {
    const query = await client.query('SELECT * FROM market_state WHERE singleton = true FOR UPDATE');
    if (query.rows.length !== 1) fail('invariant_violation', 'market authority row is missing', 500);
    return query.rows[0];
  }

  async allocateSequence(client) {
    const updated = await client.query(
      `UPDATE market_state SET authority_sequence = authority_sequence + 1, updated_at = clock_timestamp()
       WHERE singleton = true RETURNING authority_sequence::text`
    );
    if (updated.rows.length !== 1) fail('invariant_violation', 'market authority row is missing', 500);
    return integer(updated.rows[0].authority_sequence);
  }

  async insertEvent(client, sequence, eventKind, entityId, payload) {
    await client.query(
      'INSERT INTO market_events(sequence, event_kind, entity_id, payload) VALUES ($1, $2, $3, $4)',
      [sequence, eventKind, entityId, payload]
    );
  }

  async allocateEvent(client, eventKind, entityId, payload) {
    const sequence = await this.allocateSequence(client);
    await this.insertEvent(client, sequence, eventKind, entityId, payload);
    return sequence;
  }

  async claimReceipt(client, operation, requestKey, intentDigest) {
    await client.query(
      `INSERT INTO operation_receipts(operation, request_key, intent_digest)
       VALUES ($1, $2, $3) ON CONFLICT (operation, request_key) DO NOTHING`,
      [operation, requestKey, intentDigest]
    );
    const query = await client.query(
      `SELECT intent_digest, completed, result FROM operation_receipts
       WHERE operation = $1 AND request_key = $2 FOR UPDATE`,
      [operation, requestKey]
    );
    const receipt = query.rows[0];
    if (!receipt || receipt.intent_digest !== intentDigest) {
      fail('intent_conflict', 'request identity is bound to different immutable intent', 409);
    }
    return receipt.completed ? receipt.result : null;
  }

  async completeReceipt(client, operation, requestKey, result) {
    await client.query(
      `UPDATE operation_receipts SET completed = true, result = $3, completed_at = clock_timestamp()
       WHERE operation = $1 AND request_key = $2 AND completed = false`,
      [operation, requestKey, result]
    );
    return result;
  }

  async createAccount(input, { afterCommit: hook } = {}) {
    const intent = {
      operation: 'create_account', accountId: input.accountId, cashEndowment: input.cashEndowment,
      inventoryEndowment: input.inventoryEndowment
    };
    const intentDigest = digest(intent);
    const result = await this.tx(async (client) => {
      await this.lockMarket(client);
      const replay = await this.claimReceipt(client, 'create_account', input.requestKey, intentDigest);
      if (replay) return replay;
      const existing = await client.query('SELECT * FROM accounts WHERE account_id = $1 FOR UPDATE', [input.accountId]);
      let output;
      if (existing.rows.length === 1) {
        if (existing.rows[0].create_intent_digest !== intentDigest) {
          fail('intent_conflict', 'account identity is bound to changed genesis', 409);
        }
        output = accountView(existing.rows[0], integer(existing.rows[0].created_sequence));
      } else {
        const count = await client.query('SELECT count(*)::integer AS count FROM accounts');
        if (count.rows[0].count >= LIMITS.accounts) {
          output = publicResult({ state: 'rejected', code: 'account_capacity_reached' });
          return this.completeReceipt(client, 'create_account', input.requestKey, output);
        }
        const sequence = await this.allocateEvent(client, 'account_endowed', input.accountId, {
          accountId: input.accountId,
          generation: 1,
          cashEndowment: input.cashEndowment,
          inventoryEndowment: input.inventoryEndowment
        });
        await client.query(
          `UPDATE market_state SET cash_supply = cash_supply + $1, inventory_supply = inventory_supply + $2
           WHERE singleton = true`,
          [input.cashEndowment, input.inventoryEndowment]
        );
        const inserted = await client.query(
          `INSERT INTO accounts(
             account_id, state, generation, initial_cash, initial_inventory, cash_available, cash_reserved,
             inventory_available, inventory_reserved, create_intent_digest, created_sequence
           ) VALUES ($1, 'active', 1, $2, $3, $2, 0, $3, 0, $4, $5) RETURNING *`,
          [input.accountId, input.cashEndowment, input.inventoryEndowment, intentDigest, sequence]
        );
        output = accountView(inserted.rows[0], sequence);
      }
      return this.completeReceipt(client, 'create_account', input.requestKey, output);
    });
    return afterCommit(hook, result);
  }

  async transitionMarket(input, { afterCommit: hook } = {}) {
    const intentDigest = digest({ operation: 'transition_market', ...input, requestKey: undefined });
    const result = await this.tx(async (client) => {
      const market = await this.lockMarket(client);
      const replay = await this.claimReceipt(client, 'transition_market', input.requestKey, intentDigest);
      if (replay) return replay;
      if (market.generation !== input.expectedGeneration) {
        const output = publicResult({ state: 'rejected', code: 'stale_market_generation',
          currentGeneration: market.generation, currentState: market.state });
        return this.completeReceipt(client, 'transition_market', input.requestKey, output);
      }
      const allowed = (market.state === 'open' && ['halted', 'closed'].includes(input.targetState)) ||
        (market.state === 'halted' && ['open', 'closed'].includes(input.targetState));
      if (!allowed) {
        const output = publicResult({ state: 'rejected', code: 'market_state_conflict', currentState: market.state });
        return this.completeReceipt(client, 'transition_market', input.requestKey, output);
      }
      if (input.targetState === 'closed') {
        const open = await client.query(
          `SELECT count(*)::integer AS count FROM orders
           WHERE state IN ('open', 'partially_filled') AND remaining_quantity > 0`
        );
        if (open.rows[0].count !== 0) {
          const output = publicResult({ state: 'rejected', code: 'open_orders_exist', openOrderCount: open.rows[0].count });
          return this.completeReceipt(client, 'transition_market', input.requestKey, output);
        }
      }
      const generation = market.generation + 1;
      const sequence = await this.allocateEvent(client, 'market_state_changed', 'LABX', {
        symbol: 'LABX', fromState: market.state, targetState: input.targetState, generation
      });
      await client.query(
        `UPDATE market_state SET state = $1, generation = $2, updated_at = clock_timestamp()
         WHERE singleton = true`,
        [input.targetState, generation]
      );
      const output = publicResult({ symbol: 'LABX', state: input.targetState, generation, authoritySequence: sequence });
      return this.completeReceipt(client, 'transition_market', input.requestKey, output);
    });
    return afterCommit(hook, result);
  }

  async disableAccount(input, { afterCommit: hook } = {}) {
    const intentDigest = digest({ operation: 'disable_account', ...input, requestKey: undefined });
    const result = await this.tx(async (client) => {
      await this.lockMarket(client);
      const replay = await this.claimReceipt(client, 'disable_account', input.requestKey, intentDigest);
      if (replay) return replay;
      const query = await client.query('SELECT * FROM accounts WHERE account_id = $1 FOR UPDATE', [input.accountId]);
      if (query.rows.length === 0) fail('not_found', 'account is not retained', 404);
      const account = query.rows[0];
      if (account.state !== 'active' || account.generation !== input.expectedGeneration) {
        const output = publicResult({ accountId: input.accountId, state: 'rejected',
          code: account.generation !== input.expectedGeneration ? 'stale_account_generation' : 'account_state_conflict' });
        return this.completeReceipt(client, 'disable_account', input.requestKey, output);
      }
      const open = await client.query(
        `SELECT count(*)::integer AS count FROM orders WHERE account_id = $1
         AND state IN ('open', 'partially_filled') AND remaining_quantity > 0`,
        [input.accountId]
      );
      if (open.rows[0].count !== 0 || account.cash_reserved !== '0' || account.inventory_reserved !== '0') {
        const output = publicResult({ accountId: input.accountId, state: 'rejected', code: 'account_has_reservations' });
        return this.completeReceipt(client, 'disable_account', input.requestKey, output);
      }
      const generation = account.generation + 1;
      const sequence = await this.allocateEvent(client, 'account_disabled', input.accountId, {
        accountId: input.accountId, generation
      });
      const updated = await client.query(
        `UPDATE accounts SET state = 'disabled', generation = $2, updated_at = clock_timestamp()
         WHERE account_id = $1 RETURNING *`,
        [input.accountId, generation]
      );
      const output = accountView(updated.rows[0], sequence);
      return this.completeReceipt(client, 'disable_account', input.requestKey, output);
    });
    return afterCommit(hook, result);
  }

  async compatibleOwnOrder(client, input) {
    const comparator = input.side === 'buy' ? 'limit_price <= $3' : 'limit_price >= $3';
    const query = await client.query(
      `SELECT order_id FROM orders WHERE account_id = $1 AND side <> $2
       AND state IN ('open', 'partially_filled') AND remaining_quantity > 0 AND ${comparator} LIMIT 1`,
      [input.accountId, input.side, input.priceTicks]
    );
    return query.rows.length > 0;
  }

  async makerCapacity(client, input) {
    const comparator = input.side === 'buy' ? 'limit_price <= $2' : 'limit_price >= $2';
    const query = await client.query(
      `SELECT count(*)::integer AS count FROM orders WHERE side <> $1 AND account_id <> $3
       AND state IN ('open', 'partially_filled') AND remaining_quantity > 0 AND ${comparator}`,
      [input.side, input.priceTicks, input.accountId]
    );
    return query.rows[0].count;
  }

  async nextMaker(client, input) {
    const comparator = input.side === 'buy' ? 'limit_price <= $2' : 'limit_price >= $2';
    const ordering = input.side === 'buy'
      ? 'limit_price ASC, accepted_sequence ASC, order_id ASC'
      : 'limit_price DESC, accepted_sequence ASC, order_id ASC';
    const query = await client.query(
      `SELECT * FROM orders WHERE side <> $1 AND account_id <> $3
       AND state IN ('open', 'partially_filled') AND remaining_quantity > 0 AND ${comparator}
       ORDER BY ${ordering} LIMIT 1 FOR UPDATE`,
      [input.side, input.priceTicks, input.accountId]
    );
    return query.rows[0] ?? null;
  }

  async submitOrder(input, { afterCommit: hook } = {}) {
    const intent = {
      operation: 'submit_order', orderId: input.orderId, accountId: input.accountId, symbol: input.symbol,
      side: input.side, priceTicks: input.priceTicks, quantity: input.quantity,
      expectedMarketGeneration: input.expectedMarketGeneration,
      expectedAccountGeneration: input.expectedAccountGeneration
    };
    const intentDigest = digest(intent);
    const result = await this.tx(async (client) => {
      const market = await this.lockMarket(client);
      const replay = await this.claimReceipt(client, 'submit_order', input.requestKey, intentDigest);
      if (replay) return replay;
      const existing = await client.query('SELECT * FROM orders WHERE order_id = $1 FOR UPDATE', [input.orderId]);
      if (existing.rows.length === 1) {
        if (existing.rows[0].intent_digest !== intentDigest || !existing.rows[0].submit_result) {
          fail('intent_conflict', 'order identity is bound to changed or incomplete intent', 409);
        }
        return this.completeReceipt(client, 'submit_order', input.requestKey, existing.rows[0].submit_result);
      }
      const count = await client.query('SELECT count(*)::integer AS count FROM orders');
      if (count.rows[0].count >= LIMITS.orders) {
        return this.completeReceipt(client, 'submit_order', input.requestKey,
          publicResult({ orderId: input.orderId, state: 'rejected', code: 'order_capacity_reached' }));
      }
      if (market.state !== 'open') {
        return this.completeReceipt(client, 'submit_order', input.requestKey,
          publicResult({ orderId: input.orderId, state: 'rejected', code: 'market_not_open' }));
      }
      if (market.generation !== input.expectedMarketGeneration) {
        return this.completeReceipt(client, 'submit_order', input.requestKey,
          publicResult({ orderId: input.orderId, state: 'rejected', code: 'stale_market_generation' }));
      }
      const accountQuery = await client.query('SELECT * FROM accounts WHERE account_id = $1 FOR UPDATE', [input.accountId]);
      if (accountQuery.rows.length === 0) fail('not_found', 'account is not retained', 404);
      const account = accountQuery.rows[0];
      if (account.state !== 'active') {
        return this.completeReceipt(client, 'submit_order', input.requestKey,
          publicResult({ orderId: input.orderId, state: 'rejected', code: 'account_not_active' }));
      }
      if (account.generation !== input.expectedAccountGeneration) {
        return this.completeReceipt(client, 'submit_order', input.requestKey,
          publicResult({ orderId: input.orderId, state: 'rejected', code: 'stale_account_generation' }));
      }
      if (await this.compatibleOwnOrder(client, input)) {
        return this.completeReceipt(client, 'submit_order', input.requestKey,
          publicResult({ orderId: input.orderId, state: 'rejected', code: 'self_cross_rejected' }));
      }
      const notional = checkedNotional(input.priceTicks, input.quantity);
      if ((input.side === 'buy' && integer(account.cash_available) < notional) ||
          (input.side === 'sell' && integer(account.inventory_available) < input.quantity)) {
        return this.completeReceipt(client, 'submit_order', input.requestKey,
          publicResult({ orderId: input.orderId, state: 'rejected', code: 'insufficient_resource' }));
      }
      const executionCount = await client.query('SELECT count(*)::integer AS count FROM executions');
      const possibleMakers = await this.makerCapacity(client, input);
      if (executionCount.rows[0].count + possibleMakers > LIMITS.executions) {
        return this.completeReceipt(client, 'submit_order', input.requestKey,
          publicResult({ orderId: input.orderId, state: 'rejected', code: 'execution_capacity_reached' }));
      }

      if (input.side === 'buy') {
        await client.query(
          `UPDATE accounts SET cash_available = cash_available - $2, cash_reserved = cash_reserved + $2,
           updated_at = clock_timestamp() WHERE account_id = $1`,
          [input.accountId, notional]
        );
      } else {
        await client.query(
          `UPDATE accounts SET inventory_available = inventory_available - $2,
           inventory_reserved = inventory_reserved + $2, updated_at = clock_timestamp() WHERE account_id = $1`,
          [input.accountId, input.quantity]
        );
      }
      const acceptedSequence = await this.allocateEvent(client, 'order_accepted', input.orderId, {
        orderId: input.orderId,
        accountId: input.accountId,
        side: input.side,
        priceTicks: input.priceTicks,
        quantity: input.quantity,
        reservedAmount: input.side === 'buy' ? notional : input.quantity,
        marketGeneration: input.expectedMarketGeneration,
        accountGeneration: input.expectedAccountGeneration
      });
      await client.query(
        `INSERT INTO orders(
           order_id, account_id, symbol, side, limit_price, original_quantity, remaining_quantity,
           filled_quantity, canceled_quantity, state, version, accepted_sequence, market_generation,
           account_generation, intent_digest
         ) VALUES ($1, $2, 'LABX', $3, $4, $5, $5, 0, 0, 'open', 1, $6, $7, $8, $9)`,
        [input.orderId, input.accountId, input.side, input.priceTicks, input.quantity, acceptedSequence,
          input.expectedMarketGeneration, input.expectedAccountGeneration, intentDigest]
      );

      let incomingRemaining = input.quantity;
      const createdExecutions = [];
      while (incomingRemaining > 0) {
        const maker = await this.nextMaker(client, input);
        if (!maker) break;
        const makerRemaining = integer(maker.remaining_quantity);
        const quantity = Math.min(incomingRemaining, makerRemaining);
        const priceTicks = integer(maker.limit_price);
        const makerSide = maker.side;
        const buyOrderId = input.side === 'buy' ? input.orderId : maker.order_id;
        const sellOrderId = input.side === 'sell' ? input.orderId : maker.order_id;
        const buyerAccountId = input.side === 'buy' ? input.accountId : maker.account_id;
        const sellerAccountId = input.side === 'sell' ? input.accountId : maker.account_id;
        const buyLimit = input.side === 'buy' ? input.priceTicks : integer(maker.limit_price);
        await client.query('SELECT account_id FROM accounts WHERE account_id = $1 FOR UPDATE', [maker.account_id]);
        const sequence = await this.allocateSequence(client);
        const id = executionId(sequence, maker.order_id, input.orderId);
        const payload = {
          executionId: id, makerOrderId: maker.order_id, takerOrderId: input.orderId,
          buyOrderId, sellOrderId, buyerAccountId, sellerAccountId, priceTicks, quantity
        };
        await this.insertEvent(client, sequence, 'execution_recorded', input.orderId, payload);

        await client.query(
          `UPDATE accounts SET cash_reserved = cash_reserved - $2,
             cash_available = cash_available + $3,
             inventory_available = inventory_available + $4,
             updated_at = clock_timestamp()
           WHERE account_id = $1`,
          [buyerAccountId, buyLimit * quantity, (buyLimit - priceTicks) * quantity, quantity]
        );
        await client.query(
          `UPDATE accounts SET inventory_reserved = inventory_reserved - $2,
             cash_available = cash_available + $3,
             updated_at = clock_timestamp()
           WHERE account_id = $1`,
          [sellerAccountId, quantity, priceTicks * quantity]
        );
        for (const orderId of [maker.order_id, input.orderId]) {
          await client.query(
            `UPDATE orders SET remaining_quantity = remaining_quantity - $2,
               filled_quantity = filled_quantity + $2,
               state = CASE WHEN remaining_quantity - $2 = 0 THEN 'filled' ELSE 'partially_filled' END,
               version = version + 1, updated_at = clock_timestamp()
             WHERE order_id = $1`,
            [orderId, quantity]
          );
        }
        await client.query(
          `INSERT INTO executions(
             execution_id, sequence, maker_order_id, taker_order_id, buy_order_id, sell_order_id,
             buyer_account_id, seller_account_id, price_ticks, quantity
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, sequence, maker.order_id, input.orderId, buyOrderId, sellOrderId,
            buyerAccountId, sellerAccountId, priceTicks, quantity]
        );
        createdExecutions.push({
          executionId: id, sequence, makerOrderId: maker.order_id, takerOrderId: input.orderId,
          buyOrderId, sellOrderId, buyerAccountId, sellerAccountId, priceTicks, quantity,
          makerSide
        });
        incomingRemaining -= quantity;
      }

      const finalQuery = await client.query('SELECT * FROM orders WHERE order_id = $1', [input.orderId]);
      const last = await client.query('SELECT authority_sequence::text FROM market_state WHERE singleton = true');
      const output = publicResult({
        accepted: true,
        order: orderView(finalQuery.rows[0]),
        executions: createdExecutions,
        lastAuthoritySequence: integer(last.rows[0].authority_sequence),
        reservationCommitted: true,
        syntheticSettlementCommitted: createdExecutions.length > 0
      });
      await client.query('UPDATE orders SET submit_result = $2 WHERE order_id = $1', [input.orderId, output]);
      return this.completeReceipt(client, 'submit_order', input.requestKey, output);
    });
    return afterCommit(hook, result);
  }

  async cancelOrder(input, { afterCommit: hook } = {}) {
    const intentDigest = digest({ operation: 'cancel_order', ...input, requestKey: undefined });
    const result = await this.tx(async (client) => {
      await this.lockMarket(client);
      const replay = await this.claimReceipt(client, 'cancel_order', input.requestKey, intentDigest);
      if (replay) return replay;
      const query = await client.query('SELECT * FROM orders WHERE order_id = $1 FOR UPDATE', [input.orderId]);
      if (query.rows.length === 0) fail('not_found', 'order is not retained', 404);
      const order = query.rows[0];
      if (order.version !== input.expectedOrderVersion) {
        const output = publicResult({ orderId: input.orderId, state: 'rejected', code: 'stale_order_version',
          currentVersion: order.version, currentState: order.state });
        return this.completeReceipt(client, 'cancel_order', input.requestKey, output);
      }
      const remaining = integer(order.remaining_quantity);
      if (!['open', 'partially_filled'].includes(order.state) || remaining === 0) {
        const output = publicResult({ orderId: input.orderId, state: 'rejected', code: 'order_not_cancelable',
          currentVersion: order.version, currentState: order.state });
        return this.completeReceipt(client, 'cancel_order', input.requestKey, output);
      }
      await client.query('SELECT account_id FROM accounts WHERE account_id = $1 FOR UPDATE', [order.account_id]);
      const released = order.side === 'buy' ? integer(order.limit_price) * remaining : remaining;
      if (order.side === 'buy') {
        await client.query(
          `UPDATE accounts SET cash_reserved = cash_reserved - $2, cash_available = cash_available + $2,
           updated_at = clock_timestamp() WHERE account_id = $1`,
          [order.account_id, released]
        );
      } else {
        await client.query(
          `UPDATE accounts SET inventory_reserved = inventory_reserved - $2,
           inventory_available = inventory_available + $2, updated_at = clock_timestamp() WHERE account_id = $1`,
          [order.account_id, released]
        );
      }
      const sequence = await this.allocateEvent(client, 'order_canceled', input.orderId, {
        orderId: input.orderId, canceledQuantity: remaining
      });
      const updated = await client.query(
        `UPDATE orders SET canceled_quantity = canceled_quantity + remaining_quantity, remaining_quantity = 0,
         state = 'canceled', version = version + 1, updated_at = clock_timestamp()
         WHERE order_id = $1 RETURNING *`,
        [input.orderId]
      );
      const output = publicResult({
        order: orderView(updated.rows[0]), canceledQuantity: remaining, releasedResource: released,
        authoritySequence: sequence, cancelCommitted: true
      });
      return this.completeReceipt(client, 'cancel_order', input.requestKey, output);
    });
    return afterCommit(hook, result);
  }

  async publishMarketData(input, { afterCommit: hook } = {}) {
    const intentDigest = digest({ operation: 'publish_market_data', ...input, requestKey: undefined });
    const result = await this.tx(async (client) => {
      const market = await this.lockMarket(client);
      const replay = await this.claimReceipt(client, 'publish_market_data', input.requestKey, intentDigest);
      if (replay) return replay;
      const existing = await client.query('SELECT * FROM publications WHERE publication_id = $1', [input.publicationId]);
      if (existing.rows.length === 1) {
        if (existing.rows[0].intent_digest !== intentDigest) {
          fail('intent_conflict', 'publication identity is bound to changed intent', 409);
        }
        return this.completeReceipt(client, 'publish_market_data', input.requestKey, existing.rows[0].result);
      }
      const currentSequence = integer(market.authority_sequence);
      if (input.asOfSequence !== null && input.asOfSequence !== currentSequence) {
        const output = publicResult({ publicationId: input.publicationId, state: 'rejected',
          code: 'historical_publication_unsupported', currentSequence });
        return this.completeReceipt(client, 'publish_market_data', input.requestKey, output);
      }
      const count = await client.query('SELECT count(*)::integer AS count FROM publications');
      if (count.rows[0].count >= LIMITS.publications) {
        return this.completeReceipt(client, 'publish_market_data', input.requestKey,
          publicResult({ publicationId: input.publicationId, state: 'rejected', code: 'publication_capacity_reached' }));
      }
      const open = await client.query(
        `SELECT side, limit_price::text, sum(remaining_quantity)::text AS total_quantity,
                count(*)::integer AS order_count
         FROM orders WHERE state IN ('open', 'partially_filled') AND remaining_quantity > 0
         GROUP BY side, limit_price`
      );
      const bids = open.rows.filter((row) => row.side === 'buy').sort((a, b) => integer(b.limit_price) - integer(a.limit_price));
      const asks = open.rows.filter((row) => row.side === 'sell').sort((a, b) => integer(a.limit_price) - integer(b.limit_price));
      const book = [...bids, ...asks].map((row) => ({
        side: row.side,
        priceTicks: integer(row.limit_price),
        totalQuantity: integer(row.total_quantity),
        orderCount: row.order_count
      }));
      const executionRows = await client.query('SELECT * FROM executions WHERE sequence <= $1 ORDER BY sequence', [currentSequence]);
      const executionItems = executionRows.rows.map((row) => ({
        executionId: row.execution_id,
        sequence: integer(row.sequence),
        priceTicks: integer(row.price_ticks),
        quantity: integer(row.quantity)
      }));
      const metadata = {
        publicationId: input.publicationId,
        symbol: 'LABX',
        marketGeneration: market.generation,
        asOfSequence: currentSequence,
        bookItemCount: book.length,
        executionCount: executionItems.length
      };
      const manifestDigest = publicationDigest(metadata, book, executionItems);
      const publicationSequence = await this.allocateEvent(client, 'publication_created', input.publicationId, {
        publicationId: input.publicationId, asOfSequence: currentSequence, manifestDigest
      });
      const output = publicResult({
        ...metadata, publicationSequence, manifestDigest, published: true, subscriberDelivered: false
      });
      await client.query(
        `INSERT INTO publications(
           publication_id, request_key, intent_digest, market_generation, as_of_sequence, publication_sequence,
           book, executions, book_item_count, execution_count, manifest_digest, result
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [input.publicationId, input.requestKey, intentDigest, market.generation, currentSequence, publicationSequence,
          JSON.stringify(book), JSON.stringify(executionItems), book.length, executionItems.length, manifestDigest, output]
      );
      return this.completeReceipt(client, 'publish_market_data', input.requestKey, output);
    });
    return afterCommit(hook, result);
  }

  async getPublicationPage(publicationId, section, cursor, limit) {
    if (!['book', 'executions'].includes(section)) fail('invalid_request', 'publication section is unsupported');
    return this.tx(async (client) => {
      await this.lockMarket(client);
      const publicationQuery = await client.query('SELECT * FROM publications WHERE publication_id = $1', [publicationId]);
      if (publicationQuery.rows.length === 0) fail('not_found', 'publication is not retained', 404);
      const publication = publicationQuery.rows[0];
      const metadata = {
        publicationId: publication.publication_id,
        symbol: 'LABX',
        marketGeneration: publication.market_generation,
        asOfSequence: integer(publication.as_of_sequence),
        bookItemCount: publication.book_item_count,
        executionCount: publication.execution_count
      };
      if (publication.book.length !== publication.book_item_count ||
          publication.executions.length !== publication.execution_count ||
          publicationDigest(metadata, publication.book, publication.executions) !== publication.manifest_digest) {
        fail('publication_corrupt', 'publication readback does not match its immutable manifest', 409);
      }
      let offset = 0;
      if (cursor) {
        const parsed = decodeCursor(cursor);
        if (parsed.publicationId !== publicationId || parsed.manifestDigest !== publication.manifest_digest ||
            parsed.section !== section || parsed.pageLimit !== limit) {
          fail('invalid_cursor', 'publication cursor does not bind this page request', 409);
        }
        offset = parsed.nextOffset;
      }
      const cursorKey = cursor ?? 'start';
      const existing = await client.query(
        `SELECT result FROM publication_page_receipts
         WHERE publication_id = $1 AND section = $2 AND cursor_key = $3 AND page_limit = $4`,
        [publicationId, section, cursorKey, limit]
      );
      if (existing.rows.length === 1) return existing.rows[0].result;
      const receiptCount = await client.query('SELECT count(*)::integer AS count FROM publication_page_receipts');
      if (receiptCount.rows[0].count >= LIMITS.pageReceipts) {
        return publicResult({ publicationId, section, state: 'rejected', code: 'page_receipt_capacity_reached' });
      }
      const items = publication[section];
      if (offset > items.length) fail('invalid_cursor', 'publication cursor is beyond retained items', 409);
      const pageItems = items.slice(offset, offset + limit);
      const nextOffset = offset + pageItems.length;
      const nextCursor = nextOffset < items.length
        ? encodeCursor({ publicationId, manifestDigest: publication.manifest_digest, section, nextOffset, pageLimit: limit })
        : null;
      const pageDigest = digest({ publicationId, manifestDigest: publication.manifest_digest, section, offset, limit, pageItems });
      const output = publicResult({
        publicationId, section, asOfSequence: integer(publication.as_of_sequence), manifestDigest: publication.manifest_digest,
        offset, limit, items: pageItems, nextCursor, pageDigest, subscriberDelivered: false
      });
      await client.query(
        `INSERT INTO publication_page_receipts(
           publication_id, section, cursor_key, page_limit, result_digest, result
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [publicationId, section, cursorKey, limit, pageDigest, output]
      );
      return output;
    });
  }

  async runAudit(input, { afterCommit: hook } = {}) {
    const intentDigest = digest({ operation: 'run_audit', ...input, requestKey: undefined });
    const result = await this.tx(async (client) => {
      const market = await this.lockMarket(client);
      const replayReceipt = await this.claimReceipt(client, 'run_audit', input.requestKey, intentDigest);
      if (replayReceipt) return replayReceipt;
      const existing = await client.query('SELECT * FROM audits WHERE audit_id = $1', [input.auditId]);
      if (existing.rows.length === 1) {
        if (existing.rows[0].intent_digest !== intentDigest) fail('intent_conflict', 'audit identity is bound to changed intent', 409);
        return this.completeReceipt(client, 'run_audit', input.requestKey, existing.rows[0].result);
      }
      const currentSequence = integer(market.authority_sequence);
      if (input.asOfSequence !== null && input.asOfSequence !== currentSequence) {
        const output = publicResult({ auditId: input.auditId, state: 'rejected',
          code: 'historical_projection_comparison_unsupported', currentSequence });
        return this.completeReceipt(client, 'run_audit', input.requestKey, output);
      }
      const count = await client.query('SELECT count(*)::integer AS count FROM audits');
      if (count.rows[0].count >= LIMITS.audits) {
        return this.completeReceipt(client, 'run_audit', input.requestKey,
          publicResult({ auditId: input.auditId, state: 'rejected', code: 'audit_capacity_reached' }));
      }
      const eventQuery = await client.query(
        `SELECT sequence::text, event_kind, payload FROM market_events
         WHERE sequence <= $1 ORDER BY market_events.sequence`,
        [currentSequence]
      );
      const events = eventQuery.rows.map((row) => ({
        sequence: integer(row.sequence), eventKind: row.event_kind, payload: row.payload
      }));
      const replay = replayEconomicEvents(events);
      const accountQuery = await client.query('SELECT * FROM accounts ORDER BY account_id');
      const orderQuery = await client.query('SELECT * FROM orders ORDER BY order_id');
      const executionQuery = await client.query('SELECT * FROM executions ORDER BY sequence');
      const materializedAccounts = accountQuery.rows.map((row) => ({
        accountId: row.account_id, state: row.state, generation: row.generation,
        cashAvailable: integer(row.cash_available), cashReserved: integer(row.cash_reserved),
        inventoryAvailable: integer(row.inventory_available), inventoryReserved: integer(row.inventory_reserved)
      }));
      const materializedOrders = orderQuery.rows.map(orderView);
      const materializedExecutions = executionQuery.rows.map(executionView);
      const totals = materializedAccounts.reduce((sum, account) => ({
        cash: sum.cash + account.cashAvailable + account.cashReserved,
        inventory: sum.inventory + account.inventoryAvailable + account.inventoryReserved
      }), { cash: 0, inventory: 0 });
      const mismatches = [];
      if (digest(replay.accounts) !== digest(materializedAccounts)) mismatches.push('account_projection');
      if (digest(replay.orders) !== digest(materializedOrders)) mismatches.push('order_projection');
      if (digest(replay.executions) !== digest(materializedExecutions)) mismatches.push('execution_projection');
      if (replay.cashSupply !== integer(market.cash_supply)) mismatches.push('cash_genesis');
      if (replay.inventorySupply !== integer(market.inventory_supply)) mismatches.push('inventory_genesis');
      if (totals.cash !== replay.cashSupply) mismatches.push('cash_conservation');
      if (totals.inventory !== replay.inventorySupply) mismatches.push('inventory_conservation');
      const auditDigest = digest({
        asOfSequence: currentSequence, replay, materializedAccounts, materializedOrders, materializedExecutions, mismatches
      });
      const auditSequence = await this.allocateEvent(client, 'audit_created', input.auditId, {
        auditId: input.auditId, asOfSequence: currentSequence, passed: mismatches.length === 0, auditDigest
      });
      const output = publicResult({
        auditId: input.auditId,
        asOfSequence: currentSequence,
        auditSequence,
        passed: mismatches.length === 0,
        mismatches,
        eventCount: events.length,
        accountCount: replay.accounts.length,
        orderCount: replay.orders.length,
        executionCount: replay.executions.length,
        replayCashSupply: replay.cashSupply,
        replayInventorySupply: replay.inventorySupply,
        materializedCashTotal: totals.cash,
        materializedInventoryTotal: totals.inventory,
        auditDigest,
        repaired: false
      });
      await client.query(
        `INSERT INTO audits(
           audit_id, request_key, intent_digest, as_of_sequence, audit_sequence, passed, account_count,
           order_count, execution_count, event_count, mismatch_count, replay_cash_supply,
           replay_inventory_supply, materialized_cash_total, materialized_inventory_total, audit_digest, result
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [input.auditId, input.requestKey, intentDigest, currentSequence, auditSequence, output.passed,
          output.accountCount, output.orderCount, output.executionCount, output.eventCount, mismatches.length,
          replay.cashSupply, replay.inventorySupply, totals.cash, totals.inventory, auditDigest, output]
      );
      return this.completeReceipt(client, 'run_audit', input.requestKey, output);
    });
    return afterCommit(hook, result);
  }

  async getOrderEvidence(orderId) {
    return this.tx(async (client) => {
      await this.lockMarket(client);
      const orderQuery = await client.query('SELECT * FROM orders WHERE order_id = $1', [orderId]);
      if (orderQuery.rows.length === 0) fail('not_found', 'order is not retained', 404);
      const order = orderQuery.rows[0];
      const executionQuery = await client.query(
        `SELECT * FROM executions WHERE buy_order_id = $1 OR sell_order_id = $1 ORDER BY sequence`, [orderId]
      );
      const remaining = integer(order.remaining_quantity);
      return publicResult({
        order: orderView(order),
        executions: executionQuery.rows.map(executionView),
        currentReservation: order.side === 'buy' ? integer(order.limit_price) * remaining : remaining,
        orderAccepted: true,
        syntheticSettlementCommitted: executionQuery.rows.length > 0,
        cancellationCommitted: order.state === 'canceled'
      });
    });
  }

  async getState() {
    const query = await this.pool.query(`
      SELECT state, generation, authority_sequence::text,
        (SELECT count(*)::integer FROM accounts) AS accounts,
        (SELECT count(*)::integer FROM orders) AS orders,
        (SELECT count(*)::integer FROM orders WHERE state IN ('open', 'partially_filled')) AS open_orders,
        (SELECT count(*)::integer FROM executions) AS executions,
        (SELECT count(*)::integer FROM publications) AS publications,
        (SELECT count(*)::integer FROM audits) AS audits
      FROM market_state WHERE singleton = true
    `);
    const row = query.rows[0];
    return publicResult({
      symbol: 'LABX', quoteAsset: 'LAB', marketState: row.state,
      marketGeneration: row.generation, authoritySequence: integer(row.authority_sequence),
      accounts: row.accounts, orders: row.orders, open_orders: row.open_orders, executions: row.executions,
      publications: row.publications, audits: row.audits, syntheticOnly: true
    });
  }

  async health() {
    const query = await this.pool.query(
      `SELECT current_setting('server_version') AS version,
              (SELECT state FROM market_state WHERE singleton = true) AS market_state`
    );
    return { status: 'ok', postgresqlVersion: query.rows[0].version,
      marketState: query.rows[0].market_state, syntheticOnly: true };
  }
}
