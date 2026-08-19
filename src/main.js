import { Pool } from 'pg';
import { createExchangeServer } from './http.js';
import { ExchangeRepository } from './repository.js';
import { ExchangeService } from './service.js';

function databaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value || !/^postgres(?:ql)?:\/\//.test(value)) {
    throw new Error('DATABASE_URL must be an explicit PostgreSQL URL');
  }
  return value;
}

async function main() {
  const command = process.argv[2] ?? 'serve';
  const pool = new Pool({ connectionString: databaseUrl(), max: 12 });
  const repository = await new ExchangeRepository(pool).init();
  if (command === 'migrate') {
    process.stdout.write(`${JSON.stringify(await repository.health())}\n`);
    await repository.close();
    return;
  }
  if (command !== 'serve') throw new Error('command must be serve or migrate');
  const service = new ExchangeService(repository);
  const port = Number(process.env.PORT ?? 3000);
  const server = await createExchangeServer(service, { host: '127.0.0.1', port });
  process.stdout.write(`${JSON.stringify({ status: 'ready', port: server.address().port })}\n`);
  const stop = async () => {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
}

main().catch((error) => {
  void error;
  process.stderr.write('startup_error: exchange process failed\n');
  process.exitCode = 1;
});
