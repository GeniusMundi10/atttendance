// PURPOSE: Verify transactions keep one checked-out connection and release it safely on every outcome.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { transaction } from './db.ts'

function sourceFor(client: PoolClient) {
  return { async connect() { return client } } as unknown as Pool
}

function mockClient(options: { failRollback?: boolean; failBegin?: boolean } = {}) {
  const statements: string[] = []
  const releases: unknown[] = []
  const client = {
    async query(sql: string) {
      statements.push(sql)
      if (sql === 'BEGIN' && options.failBegin) throw new Error('begin failed')
      if (sql === 'ROLLBACK' && options.failRollback) throw new Error('rollback failed')
      return { rows: [] }
    },
    release(discard?: unknown) { releases.push(discard) },
  } as unknown as PoolClient
  return { client, statements, releases }
}

test('transaction commits then releases its single checked-out connection', async () => {
  const mock = mockClient()
  const result = await transaction(async client => {
    await client.query('WORK')
    return 'done'
  }, sourceFor(mock.client))
  assert.equal(result, 'done')
  assert.deepEqual(mock.statements, ['BEGIN', 'WORK', 'COMMIT'])
  assert.deepEqual(mock.releases, [false])
})

test('transaction rolls back a failed body and preserves the original error', async () => {
  const mock = mockClient()
  const original = new Error('body failed')
  await assert.rejects(transaction(async () => { throw original }, sourceFor(mock.client)), error => error === original)
  assert.deepEqual(mock.statements, ['BEGIN', 'ROLLBACK'])
  assert.deepEqual(mock.releases, [false])
})

test('transaction discards a client when rollback fails, without replacing the first error', async () => {
  const mock = mockClient({ failRollback: true })
  const original = new Error('body failed')
  await assert.rejects(transaction(async () => { throw original }, sourceFor(mock.client)), error => error === original)
  assert.deepEqual(mock.statements, ['BEGIN', 'ROLLBACK'])
  assert.deepEqual(mock.releases, [true])
})

test('transaction attempts rollback and releases when BEGIN fails', async () => {
  const mock = mockClient({ failBegin: true })
  await assert.rejects(transaction(async () => 'unused', sourceFor(mock.client)), /begin failed/)
  assert.deepEqual(mock.statements, ['BEGIN', 'ROLLBACK'])
  assert.deepEqual(mock.releases, [false])
})
