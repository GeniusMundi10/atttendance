// PURPOSE: Run the attendance PostgreSQL suite in a disposable dedicated database.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a test port');
  await new Promise(resolve => server.close(resolve));
  return address.port;
}

const directory = await mkdtemp(join(tmpdir(), 'attendance-postgres-'));
const port = await freePort();
const user = 'attendance_test';
const password = randomUUID();
const database = 'attendance_test';
const postgres = new EmbeddedPostgres({
  databaseDir: join(directory, 'data'),
  port,
  user,
  password,
  persistent: false,
  onLog: () => {},
  onError: () => {},
});

try {
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase(database);
  const url = new URL(`postgresql://127.0.0.1:${port}/${database}`);
  url.username = user;
  url.password = password;
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--experimental-strip-types',
      '--experimental-test-isolation=none',
      '--test',
      'features/attendance/attendance.test.ts',
    ], {
      cwd: new URL('../../', import.meta.url),
      env: { ...process.env, ATTENDANCE_TEST_DATABASE_URL: url.toString() },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
  process.exitCode = exitCode;
} finally {
  await postgres.stop().catch(() => {});
  const resolved = await realpath(directory);
  const tempRoot = await realpath(tmpdir());
  if (!resolved.startsWith(`${tempRoot}${sep}`)) throw new Error('Unexpected test directory');
  await rm(resolved, { recursive: true, force: true });
}
