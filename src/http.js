import { createServer } from 'node:http';
import { LIMITS } from './contracts.js';
import { asDomainError, DomainError, fail } from './errors.js';

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > LIMITS.bodyBytes) fail('invalid_request', 'request body exceeds bound', 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) fail('invalid_request', 'request body is required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('invalid_request', 'request body must be valid JSON');
  }
}

function send(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
    'cache-control': 'no-store'
  });
  response.end(encoded);
}

async function sendCommand(response, successStatus, command) {
  const body = await command;
  return send(response, body?.state === 'rejected' ? 409 : successStatus, body);
}

function segment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail('invalid_request', 'route identity is malformed');
  }
}

export function createRequestHandler(service) {
  return async (request, response) => {
    try {
      const url = new URL(request.url, 'http://exchange.invalid');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return send(response, 200, await service.health());
      }
      if (request.method === 'GET' && url.pathname === '/v1/state') {
        return send(response, 200, await service.getState());
      }
      if (request.method === 'POST' && url.pathname === '/v1/accounts') {
        return sendCommand(response, 201, service.createAccount(await readBody(request)));
      }
      if (request.method === 'POST' && url.pathname === '/v1/market/state') {
        return sendCommand(response, 200, service.transitionMarket(await readBody(request)));
      }
      let match = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/disable$/);
      if (request.method === 'POST' && match) {
        return sendCommand(response, 200, service.disableAccount(segment(match[1]), await readBody(request)));
      }
      if (request.method === 'POST' && url.pathname === '/v1/orders') {
        return sendCommand(response, 201, service.submitOrder(await readBody(request)));
      }
      match = url.pathname.match(/^\/v1\/orders\/([^/]+)\/cancel$/);
      if (request.method === 'POST' && match) {
        return sendCommand(response, 200, service.cancelOrder(segment(match[1]), await readBody(request)));
      }
      match = url.pathname.match(/^\/v1\/orders\/([^/]+)\/evidence$/);
      if (request.method === 'GET' && match) {
        return send(response, 200, await service.getOrderEvidence(segment(match[1])));
      }
      if (request.method === 'POST' && url.pathname === '/v1/publications') {
        return sendCommand(response, 201, service.publishMarketData(await readBody(request)));
      }
      match = url.pathname.match(/^\/v1\/publications\/([^/]+)\/pages$/);
      if (request.method === 'GET' && match) {
        return send(response, 200, await service.getPublicationPage(
          segment(match[1]), url.searchParams.get('section') ?? 'book', url.searchParams.get('cursor'),
          url.searchParams.get('limit') ?? '50'
        ));
      }
      if (request.method === 'POST' && url.pathname === '/v1/audits') {
        return sendCommand(response, 201, service.runAudit(await readBody(request)));
      }
      return send(response, 404, { error: { code: 'not_found', message: 'route is not available' } });
    } catch (error) {
      const mapped = error instanceof DomainError ? error : asDomainError(error);
      return send(response, mapped.status, { error: { code: mapped.code, message: mapped.message } });
    }
  };
}

export async function createExchangeServer(service, { host = '127.0.0.1', port = 0 } = {}) {
  const server = createServer(createRequestHandler(service));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}
