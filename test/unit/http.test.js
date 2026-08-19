import assert from 'node:assert/strict';
import test from 'node:test';
import { createExchangeServer } from '../../src/http.js';

async function withServer(service, callback) {
  const server = await createExchangeServer(service);
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('HTTP order route forwards a parsed JSON body and disables caching', async () => {
  let observed;
  const service = {
    submitOrder: async (body) => {
      observed = body;
      return body.reject ? { state: 'rejected', code: 'bounded_rejection' } : { accepted: true };
    }
  };
  await withServer(service, async (base) => {
    const response = await fetch(`${base}/v1/orders`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order: 'synthetic' })
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { accepted: true });
    assert.deepEqual(observed, { order: 'synthetic' });
    const rejected = await fetch(`${base}/v1/orders`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reject: true })
    });
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), { state: 'rejected', code: 'bounded_rejection' });
  });
});

test('HTTP maps unexpected failures to a redacted local error', async () => {
  const service = { getState: async () => { throw new Error('database secret and raw SQL'); } };
  await withServer(service, async (base) => {
    const response = await fetch(`${base}/v1/state`);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.deepEqual(body, { error: { code: 'internal_error', message: 'unexpected local failure' } });
    assert.doesNotMatch(JSON.stringify(body), /secret|SQL/);
  });
});
