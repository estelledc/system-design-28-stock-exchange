import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Pool } from 'pg';
import { ExchangeRepository } from '../src/repository.js';
import { ExchangeService } from '../src/service.js';

async function stopAfterCommit() {
  const markerPath = process.env.FAILPOINT_MARKER_PATH;
  if (!markerPath) throw new Error('FAILPOINT_MARKER_PATH is required');
  await mkdir(dirname(markerPath), { recursive: true });
  const handle = await open(markerPath, 'w', 0o600);
  try {
    await handle.writeFile('committed\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await new Promise(() => {});
}

async function main() {
  const operation = process.argv[2];
  const payload = JSON.parse(process.env.CRASH_PAYLOAD);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const repository = await new ExchangeRepository(pool).init();
  const service = new ExchangeService(repository);
  const options = { afterCommit: stopAfterCommit };

  if (operation === 'account-after-commit') {
    await service.createAccount(payload.account, options);
  } else if (operation === 'market-state-after-commit') {
    await service.transitionMarket(payload.input, options);
  } else if (operation === 'order-settlement-after-commit') {
    await service.submitOrder(payload.order, options);
  } else if (operation === 'cancel-after-commit') {
    await service.cancelOrder(payload.orderId, payload.input, options);
  } else if (operation === 'publication-after-commit') {
    await service.publishMarketData(payload.publication, options);
  } else if (operation === 'audit-after-commit') {
    await service.runAudit(payload.audit, options);
  } else {
    throw new Error('unsupported crash operation');
  }
}

main().catch((error) => {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = 1;
});
