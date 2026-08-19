import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { ExchangeRepository } from '../../src/repository.js';
import { ExchangeService } from '../../src/service.js';

export async function createRuntime(databaseUrl, { reset = false } = {}) {
  const pool = new Pool({ connectionString: databaseUrl, max: 20 });
  const repository = await new ExchangeRepository(pool).init();
  if (reset) await repository.reset();
  const service = new ExchangeService(repository);
  return { pool, repository, service, close: () => repository.close() };
}

export function accountFixture(suffix, cashEndowment = 0, inventoryEndowment = 0) {
  return {
    requestKey: `req_account_${suffix}`,
    accountId: `account_${suffix}`,
    cashEndowment,
    inventoryEndowment
  };
}

export function orderFixture(suffix, accountId, side, priceTicks, quantity, {
  marketGeneration = 1,
  accountGeneration = 1
} = {}) {
  return {
    requestKey: `req_order_${suffix}`,
    orderId: `order_${suffix}`,
    accountId,
    symbol: 'LABX',
    side,
    priceTicks,
    quantity,
    expectedMarketGeneration: marketGeneration,
    expectedAccountGeneration: accountGeneration
  };
}

export async function createAccount(service, suffix, cashEndowment = 0, inventoryEndowment = 0) {
  return service.createAccount(accountFixture(suffix, cashEndowment, inventoryEndowment));
}

export async function waitForMarker(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(20);
  }
  throw new Error('failpoint marker timed out');
}

export async function killWorkerAt({ databaseUrl, directory, counter, operation, payload }) {
  const marker = `${directory}/marker-${counter}`;
  const child = spawn(process.execPath, ['scripts/crash-worker.mjs', operation], {
    cwd: new URL('../..', import.meta.url),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      FAILPOINT_MARKER_PATH: marker,
      CRASH_PAYLOAD: JSON.stringify(payload)
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  let rejectEarly;
  const prematureExit = new Promise((_, reject) => { rejectEarly = reject; });
  const onEarlyExit = (code, signal) => {
    rejectEarly(new Error(`crash worker exited before marker (${code}/${signal}): ${stderr}`));
  };
  child.once('exit', onEarlyExit);
  await Promise.race([waitForMarker(marker), prematureExit]);
  child.removeListener('exit', onEarlyExit);
  child.kill('SIGKILL');
  const [code, signal] = await once(child, 'exit');
  return { code, signal };
}
