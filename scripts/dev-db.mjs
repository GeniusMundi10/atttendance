// PURPOSE: Local dev only: run a persistent embedded Postgres matching .env DATABASE_URL, migrate it, and keep it up.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'

process.loadEnvFile('.env')
const url = new URL(process.env.DATABASE_URL)
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('dev-db only runs a loopback DATABASE_URL')
const database = url.pathname.slice(1)
const postgres = new EmbeddedPostgres({
  databaseDir: join(process.env.LOCALAPPDATA ?? '.', 'elt-attendance-devdb'),
  port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
  persistent: true, onLog: () => {},
})
await postgres.initialise().catch(() => {}) // already initialised on later runs
await postgres.start()
await postgres.createDatabase(database).catch(() => {}) // already exists on later runs
const migrated = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/migrate.ts'], { stdio: 'inherit', env: process.env })
console.log(migrated.status === 0 ? `dev-db ready on port ${url.port}` : 'dev-db: migration failed')
const stop = () => postgres.stop().finally(() => process.exit())
process.on('SIGINT', stop); process.on('SIGTERM', stop)
setInterval(() => {}, 1 << 30)
