// PURPOSE: Supply one connection pool and a transaction boundary for feature composition.
import pg, { type PoolClient } from 'pg'

let pool: pg.Pool | undefined
export function database() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  // Keep per-process connections low because serverless instances scale independently.
  return pool ??= new pg.Pool({connectionString: process.env.DATABASE_URL, max: 2,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, allowExitOnIdle: true})
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>, source = database()) {
  const client = await source.connect()
  let discard = false
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { discard = true }
    throw error
  } finally { client.release(discard) }
}
