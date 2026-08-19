import { createHash } from 'node:crypto';
import { fail } from './errors.js';

export const LIMITS = Object.freeze({
  accounts: 32,
  audits: 32,
  bodyBytes: 16_384,
  cashEndowment: 10_000_000_000_000,
  executions: 4_096,
  idLength: 72,
  inventoryEndowment: 1_000_000_000,
  orders: 2_048,
  pageLimit: 50,
  pageReceipts: 512,
  priceTicks: 1_000_000,
  publications: 128,
  quantity: 1_000_000
});

const PREFIXES = Object.freeze({
  accountId: 'account',
  auditId: 'audit',
  orderId: 'order',
  publicationId: 'publication',
  requestKey: 'req'
});

export function assertPlainObject(value, label = 'request') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_request', `${label} must be a JSON object`);
  }
  return value;
}

export function exactKeys(value, required, optional = [], label = 'request') {
  assertPlainObject(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('invalid_request', `${label} contains unknown field`);
  }
  for (const key of required) {
    if (!(key in value)) fail('invalid_request', `${label} is missing required field`);
  }
}

export function parseId(value, field) {
  const prefix = PREFIXES[field];
  if (!prefix || typeof value !== 'string' || value.length > LIMITS.idLength ||
      !new RegExp(`^${prefix}_[a-z0-9][a-z0-9_-]{2,63}$`).test(value)) {
    fail('invalid_request', `${field} has invalid identity grammar`);
  }
  return value;
}

function parseBoundedInteger(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('invalid_request', `${field} must be a bounded JSON integer`);
  }
  return value;
}

export function parseGeneration(value, field = 'expectedGeneration') {
  return parseBoundedInteger(value, field, 1, 1_000_000);
}

export function parseSequence(value, field = 'asOfSequence') {
  if (value === null) return null;
  return parseBoundedInteger(value, field, 0, 10_000_000);
}

export function parsePageLimit(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > LIMITS.pageLimit) {
    fail('invalid_request', 'page limit is outside the supported bound');
  }
  return parsed;
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function parseAccountInput(value) {
  exactKeys(value, ['requestKey', 'accountId', 'cashEndowment', 'inventoryEndowment']);
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    accountId: parseId(value.accountId, 'accountId'),
    cashEndowment: parseBoundedInteger(value.cashEndowment, 'cashEndowment', 0, LIMITS.cashEndowment),
    inventoryEndowment: parseBoundedInteger(
      value.inventoryEndowment, 'inventoryEndowment', 0, LIMITS.inventoryEndowment
    )
  });
}

export function parseMarketStateInput(value) {
  exactKeys(value, ['requestKey', 'expectedGeneration', 'targetState']);
  if (!['open', 'halted', 'closed'].includes(value.targetState)) {
    fail('invalid_request', 'targetState is unsupported');
  }
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    expectedGeneration: parseGeneration(value.expectedGeneration),
    targetState: value.targetState
  });
}

export function parseDisableInput(value, accountId) {
  exactKeys(value, ['requestKey', 'expectedGeneration']);
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    accountId: parseId(accountId, 'accountId'),
    expectedGeneration: parseGeneration(value.expectedGeneration)
  });
}

export function parseOrderInput(value) {
  exactKeys(value, [
    'requestKey', 'orderId', 'accountId', 'symbol', 'side', 'priceTicks', 'quantity',
    'expectedMarketGeneration', 'expectedAccountGeneration'
  ]);
  if (value.symbol !== 'LABX') fail('invalid_request', 'symbol must be the synthetic LABX instrument');
  if (!['buy', 'sell'].includes(value.side)) fail('invalid_request', 'side must be buy or sell');
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    orderId: parseId(value.orderId, 'orderId'),
    accountId: parseId(value.accountId, 'accountId'),
    symbol: value.symbol,
    side: value.side,
    priceTicks: parseBoundedInteger(value.priceTicks, 'priceTicks', 1, LIMITS.priceTicks),
    quantity: parseBoundedInteger(value.quantity, 'quantity', 1, LIMITS.quantity),
    expectedMarketGeneration: parseGeneration(value.expectedMarketGeneration, 'expectedMarketGeneration'),
    expectedAccountGeneration: parseGeneration(value.expectedAccountGeneration, 'expectedAccountGeneration')
  });
}

export function parseCancelInput(value, orderId) {
  exactKeys(value, ['requestKey', 'expectedOrderVersion']);
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    orderId: parseId(orderId, 'orderId'),
    expectedOrderVersion: parseBoundedInteger(value.expectedOrderVersion, 'expectedOrderVersion', 1, 1_000_000)
  });
}

export function parsePublicationInput(value) {
  exactKeys(value, ['requestKey', 'publicationId', 'asOfSequence']);
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    publicationId: parseId(value.publicationId, 'publicationId'),
    asOfSequence: parseSequence(value.asOfSequence)
  });
}

export function parseAuditInput(value) {
  exactKeys(value, ['requestKey', 'auditId', 'asOfSequence']);
  return Object.freeze({
    requestKey: parseId(value.requestKey, 'requestKey'),
    auditId: parseId(value.auditId, 'auditId'),
    asOfSequence: parseSequence(value.asOfSequence)
  });
}
