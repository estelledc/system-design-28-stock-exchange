import { Buffer } from 'node:buffer';
import { digest } from './contracts.js';
import { fail } from './errors.js';

export const OUTCOME_BOUNDARY = Object.freeze({
  realOrderPlaced: false,
  realSecurityTransferred: false,
  clearingCompleted: false,
  participantConsumed: false,
  compliant: false,
  externalAcceptance: false
});

export function publicResult(value = {}) {
  return Object.freeze({ ...value, ...OUTCOME_BOUNDARY });
}

export function checkedNotional(priceTicks, quantity) {
  const value = priceTicks * quantity;
  if (!Number.isSafeInteger(value) || value < 1) fail('invalid_request', 'order notional exceeds safe integer bounds');
  return value;
}

export function isCompatible(takerSide, takerPrice, makerPrice) {
  return takerSide === 'buy' ? makerPrice <= takerPrice : makerPrice >= takerPrice;
}

export function compareMakers(takerSide) {
  return (left, right) => {
    const price = takerSide === 'buy'
      ? left.priceTicks - right.priceTicks
      : right.priceTicks - left.priceTicks;
    if (price !== 0) return price;
    if (left.acceptedSequence !== right.acceptedSequence) {
      return left.acceptedSequence - right.acceptedSequence;
    }
    return left.orderId.localeCompare(right.orderId);
  };
}

export function selectCompatibleMakers(incoming, resting) {
  return resting
    .filter((order) => order.side !== incoming.side && order.remainingQuantity > 0 &&
      isCompatible(incoming.side, incoming.priceTicks, order.priceTicks))
    .sort(compareMakers(incoming.side));
}

export function derivedOrderState(originalQuantity, filledQuantity, canceledQuantity) {
  const remaining = originalQuantity - filledQuantity - canceledQuantity;
  if (remaining < 0) fail('invariant_violation', 'order quantities exceed accepted quantity', 500);
  if (remaining === 0 && canceledQuantity > 0) return 'canceled';
  if (remaining === 0) return 'filled';
  if (filledQuantity > 0) return 'partially_filled';
  return 'open';
}

export function executionId(sequence, makerOrderId, takerOrderId) {
  return `execution_${digest({ sequence, makerOrderId, takerOrderId }).slice(0, 24)}`;
}

export function encodeCursor({ publicationId, manifestDigest, section, nextOffset, pageLimit }) {
  return Buffer.from(
    JSON.stringify({ publicationId, manifestDigest, section, nextOffset, pageLimit }), 'utf8'
  ).toString('base64url');
}

export function decodeCursor(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 512) {
    fail('invalid_cursor', 'publication cursor is malformed', 409);
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed.publicationId !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.manifestDigest) ||
        !['book', 'executions'].includes(parsed.section) || !Number.isSafeInteger(parsed.nextOffset) ||
        parsed.nextOffset < 0 || !Number.isSafeInteger(parsed.pageLimit) || parsed.pageLimit < 1 ||
        parsed.pageLimit > 50) {
      fail('invalid_cursor', 'publication cursor is malformed', 409);
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'invalid_cursor') throw error;
    fail('invalid_cursor', 'publication cursor is malformed', 409);
  }
}

export function publicationDigest(metadata, book, executions) {
  return digest({ metadata, book, executions });
}

function emptyAccount(payload) {
  return {
    accountId: payload.accountId,
    state: 'active',
    generation: payload.generation,
    cashAvailable: payload.cashEndowment,
    cashReserved: 0,
    inventoryAvailable: payload.inventoryEndowment,
    inventoryReserved: 0
  };
}

export function replayEconomicEvents(events) {
  const accounts = new Map();
  const orders = new Map();
  const executions = [];
  let cashSupply = 0;
  let inventorySupply = 0;

  for (const event of events) {
    const payload = event.payload;
    if (event.eventKind === 'account_endowed') {
      if (accounts.has(payload.accountId)) fail('invariant_violation', 'replay contains duplicate account genesis', 500);
      accounts.set(payload.accountId, emptyAccount(payload));
      cashSupply += payload.cashEndowment;
      inventorySupply += payload.inventoryEndowment;
      continue;
    }
    if (event.eventKind === 'account_disabled') {
      const account = accounts.get(payload.accountId);
      if (!account) fail('invariant_violation', 'replay disabled an unknown account', 500);
      account.state = 'disabled';
      account.generation = payload.generation;
      continue;
    }
    if (event.eventKind === 'order_accepted') {
      const account = accounts.get(payload.accountId);
      if (!account || orders.has(payload.orderId)) fail('invariant_violation', 'replay order genesis is invalid', 500);
      const expectedReservation = payload.side === 'buy'
        ? payload.priceTicks * payload.quantity
        : payload.quantity;
      if (!['buy', 'sell'].includes(payload.side) || !Number.isSafeInteger(expectedReservation) ||
          expectedReservation !== payload.reservedAmount) {
        fail('invariant_violation', 'replay order reservation is invalid', 500);
      }
      if (payload.side === 'buy') {
        account.cashAvailable -= payload.reservedAmount;
        account.cashReserved += payload.reservedAmount;
      } else {
        account.inventoryAvailable -= payload.quantity;
        account.inventoryReserved += payload.quantity;
      }
      orders.set(payload.orderId, {
        orderId: payload.orderId,
        accountId: payload.accountId,
        side: payload.side,
        priceTicks: payload.priceTicks,
        originalQuantity: payload.quantity,
        remainingQuantity: payload.quantity,
        filledQuantity: 0,
        canceledQuantity: 0,
        state: 'open',
        acceptedSequence: Number(event.sequence),
        version: 1,
        symbol: 'LABX',
        marketGeneration: payload.marketGeneration,
        accountGeneration: payload.accountGeneration
      });
      continue;
    }
    if (event.eventKind === 'execution_recorded') {
      const buy = orders.get(payload.buyOrderId);
      const sell = orders.get(payload.sellOrderId);
      const buyer = accounts.get(payload.buyerAccountId);
      const seller = accounts.get(payload.sellerAccountId);
      const maker = orders.get(payload.makerOrderId);
      const taker = orders.get(payload.takerOrderId);
      if (!buy || !sell || !buyer || !seller || !maker || !taker) {
        fail('invariant_violation', 'replay execution references missing state', 500);
      }
      const quantity = payload.quantity;
      if (buy.side !== 'buy' || sell.side !== 'sell' || buy.accountId !== payload.buyerAccountId ||
          sell.accountId !== payload.sellerAccountId || maker.accountId === taker.accountId ||
          maker.acceptedSequence >= taker.acceptedSequence || !isCompatible('buy', buy.priceTicks, sell.priceTicks) ||
          payload.priceTicks !== maker.priceTicks || !Number.isSafeInteger(quantity) || quantity < 1 ||
          quantity > buy.remainingQuantity || quantity > sell.remainingQuantity ||
          payload.executionId !== executionId(event.sequence, payload.makerOrderId, payload.takerOrderId)) {
        fail('invariant_violation', 'replay execution violates matching semantics', 500);
      }
      buy.remainingQuantity -= quantity;
      buy.filledQuantity += quantity;
      buy.version += 1;
      buy.state = derivedOrderState(buy.originalQuantity, buy.filledQuantity, buy.canceledQuantity);
      sell.remainingQuantity -= quantity;
      sell.filledQuantity += quantity;
      sell.version += 1;
      sell.state = derivedOrderState(sell.originalQuantity, sell.filledQuantity, sell.canceledQuantity);
      buyer.cashReserved -= buy.priceTicks * quantity;
      buyer.cashAvailable += (buy.priceTicks - payload.priceTicks) * quantity;
      seller.cashAvailable += payload.priceTicks * quantity;
      seller.inventoryReserved -= quantity;
      buyer.inventoryAvailable += quantity;
      executions.push({
        executionId: payload.executionId,
        sequence: Number(event.sequence),
        makerOrderId: payload.makerOrderId,
        takerOrderId: payload.takerOrderId,
        buyOrderId: payload.buyOrderId,
        sellOrderId: payload.sellOrderId,
        buyerAccountId: payload.buyerAccountId,
        sellerAccountId: payload.sellerAccountId,
        priceTicks: payload.priceTicks,
        quantity
      });
      continue;
    }
    if (event.eventKind === 'order_canceled') {
      const order = orders.get(payload.orderId);
      const account = order && accounts.get(order.accountId);
      if (!order || !account || order.remainingQuantity !== payload.canceledQuantity) {
        fail('invariant_violation', 'replay cancellation does not match open remainder', 500);
      }
      if (order.side === 'buy') {
        const release = order.priceTicks * payload.canceledQuantity;
        account.cashReserved -= release;
        account.cashAvailable += release;
      } else {
        account.inventoryReserved -= payload.canceledQuantity;
        account.inventoryAvailable += payload.canceledQuantity;
      }
      order.canceledQuantity += payload.canceledQuantity;
      order.remainingQuantity = 0;
      order.version += 1;
      order.state = 'canceled';
    }
  }

  for (const account of accounts.values()) {
    if ([account.cashAvailable, account.cashReserved, account.inventoryAvailable, account.inventoryReserved]
      .some((value) => !Number.isSafeInteger(value) || value < 0)) {
      fail('invariant_violation', 'replay produced an invalid account projection', 500);
    }
  }
  for (const order of orders.values()) {
    if (order.remainingQuantity + order.filledQuantity + order.canceledQuantity !== order.originalQuantity) {
      fail('invariant_violation', 'replay produced an invalid order projection', 500);
    }
  }

  return Object.freeze({
    accounts: [...accounts.values()].sort((a, b) => a.accountId.localeCompare(b.accountId)),
    orders: [...orders.values()].sort((a, b) => a.orderId.localeCompare(b.orderId)),
    executions: executions.sort((a, b) => a.sequence - b.sequence),
    cashSupply,
    inventorySupply
  });
}
