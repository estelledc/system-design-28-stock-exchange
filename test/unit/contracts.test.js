import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalJson,
  digest,
  parseAccountInput,
  parseAuditInput,
  parseOrderInput,
  parsePublicationInput
} from '../../src/contracts.js';

test('canonical JSON and digest ignore object key insertion order', () => {
  assert.equal(canonicalJson({ z: 2, a: { y: 3, x: 1 } }), '{"a":{"x":1,"y":3},"z":2}');
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
});

test('account input accepts only generated identities and bounded integer endowments', () => {
  assert.deepEqual(parseAccountInput({
    requestKey: 'req_create_a', accountId: 'account_alpha', cashEndowment: 10_000, inventoryEndowment: 20
  }), {
    requestKey: 'req_create_a', accountId: 'account_alpha', cashEndowment: 10_000, inventoryEndowment: 20
  });
  assert.throws(() => parseAccountInput({
    requestKey: 'req_create_a', accountId: 'account_alpha', cashEndowment: 1.5, inventoryEndowment: 20
  }), { code: 'invalid_request' });
});

test('order input rejects unknown fields, floats, and non-synthetic symbols', () => {
  const valid = {
    requestKey: 'req_order_a', orderId: 'order_alpha', accountId: 'account_alpha', symbol: 'LABX',
    side: 'buy', priceTicks: 125, quantity: 4, expectedMarketGeneration: 1, expectedAccountGeneration: 1
  };
  assert.deepEqual(parseOrderInput(valid), valid);
  assert.throws(() => parseOrderInput({ ...valid, priceTicks: 12.5 }), { code: 'invalid_request' });
  assert.throws(() => parseOrderInput({ ...valid, symbol: 'REAL' }), { code: 'invalid_request' });
  assert.throws(() => parseOrderInput({ ...valid, owner: 'unknown' }), { code: 'invalid_request' });
});

test('publication and audit require explicit nullable authority cuts', () => {
  assert.equal(parsePublicationInput({
    requestKey: 'req_publication_a', publicationId: 'publication_alpha', asOfSequence: null
  }).asOfSequence, null);
  assert.equal(parseAuditInput({
    requestKey: 'req_audit_a', auditId: 'audit_alpha', asOfSequence: 0
  }).asOfSequence, 0);
  assert.throws(() => parseAuditInput({
    requestKey: 'req_audit_a', auditId: 'audit_alpha', asOfSequence: -1
  }), { code: 'invalid_request' });
});
