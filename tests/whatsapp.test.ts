// PURPOSE: Verify scheduled WhatsApp authorization, retry fairness, and per-message commits.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import pg from 'pg'
import { transaction } from '../platform/db.ts'
import { whatsappHttp } from '../platform/whatsapp-http.ts'
import { cloudApiSender, runWhatsAppPass, WHATSAPP_PASS_LIMIT } from '../platform/whatsapp.ts'
import { startDatabase } from './database.ts'

test('the scheduler requires a configured bearer before invoking the worker', async () => {
  const secret = 'synthetic-scheduler-secret'
  const request = (value?: string) => new Request('http://localhost/api/internal/whatsapp', {
    method: 'POST', headers: value ? { authorization: value } : {},
  })
  const result = { attempted: 3, published: 2, deferred: 1 }
  let runs = 0
  const run = async () => { runs++; return result }
  assert.equal((await whatsappHttp(request(), run, secret)).status, 401)
  assert.equal((await whatsappHttp(request('Bearer mismatch'), run, secret)).status, 401)
  assert.equal((await whatsappHttp(request(`Bearer ${secret}`), run, '')).status, 401)
  assert.equal(runs, 0)
  const accepted = await whatsappHttp(request(`Bearer ${secret}`), run, secret)
  assert.equal(accepted.status, 200)
  assert.equal(accepted.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await accepted.json(), result)
  assert.equal(runs, 1)
  const unavailable = await whatsappHttp(request(`Bearer ${secret}`), async () => {
    throw Error('synthetic sensitive details')
  }, secret)
  assert.equal(unavailable.status, 503)
  assert.deepEqual(await unavailable.json(), { error: 'WhatsApp worker unavailable' })
})

test('Cloud API sender uses a bounded request and rejects non-success responses', async t => {
  for (const [key, value] of Object.entries({
    WHATSAPP_TOKEN: 'test-only', WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_TEMPLATE: 'sample_punch', WHATSAPP_TEMPLATE_LANGUAGE: 'en',
  })) {
    const before = process.env[key]
    process.env[key] = value
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before })
  }
  const signal = new AbortController().signal
  const timeout = t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.equal(ms, 5_000)
    return signal
  })
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.match(url, /\/123\/messages$/)
    assert.equal(options.signal, signal)
    assert.equal(options.redirect, 'error')
    const body = JSON.parse(String(options.body))
    assert.equal(body.to, '919800000001')
    assert.equal(body.template.name, 'sample_punch')
    return new Response('{"error":"synthetic"}', { status: 429 })
  })
  await assert.rejects(cloudApiSender()('+919800000001', ['Test', 'checked in', '9:00 am IST']), /429/)
  assert.equal(timeout.mock.callCount(), 1)
  assert.equal(fetch.mock.callCount(), 1)
})

test('delivery commits rows independently and retries later without starving the backlog', async t => {
  const server = await startDatabase()
  const pool = new pg.Pool({ connectionString: server.url, max: 4 })
  t.after(async () => { await pool.end(); await server.stop() })
  await pool.query(`
    CREATE TABLE access_employees (id uuid PRIMARY KEY, display_name text, whatsapp_number text);
    CREATE TABLE attendance_outbox (
      outbox_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, payload jsonb NOT NULL, published_at timestamptz
    );`)
  const migration = await readFile(new URL('../features/attendance/migrations/002_whatsapp_retry.sql', import.meta.url), 'utf8')
  await pool.query(migration)
  const transact = <T>(work: (client: pg.PoolClient) => Promise<T>) => transaction(work, pool)
  const enqueue = async (number: string | null) => {
    const id = randomUUID()
    await pool.query('INSERT INTO access_employees VALUES ($1, $2, $3)', [id, 'Test Employee', number])
    const { rows } = await pool.query(`INSERT INTO attendance_outbox (payload)
      VALUES (jsonb_build_object('employeeId', $1::uuid, 'action', 'IN', 'recordedAt', '2026-11-26T03:30:00Z')) RETURNING outbox_id`, [id])
    return Number(rows[0].outbox_id)
  }

  await t.test('old failures are deferred, later rows progress, and no-number rows are resolved', async () => {
    const failing = '+919800000001'
    const healthy = '+919800000002'
    for (let i = 0; i < WHATSAPP_PASS_LIMIT + 1; i++) await enqueue(failing)
    await enqueue(healthy)
    await enqueue(null)
    const sent: string[] = []
    const send = async (to: string, params: string[]) => {
      if (to === failing) throw Error('synthetic provider outage')
      sent.push(to)
      assert.deepEqual(params.slice(0, 2), ['Test', 'checked in'])
      assert.match(params[2]!, /9:00 am IST$/i)
    }
    assert.deepEqual(await runWhatsAppPass(send, transact), { attempted: 20, deferred: 20, published: 0 })
    assert.deepEqual(await runWhatsAppPass(send, transact), { attempted: 3, deferred: 1, published: 2 })
    assert.deepEqual(await runWhatsAppPass(send, transact), { attempted: 0, deferred: 0, published: 0 })
    assert.deepEqual(sent, [healthy])
    await pool.query(`UPDATE attendance_outbox SET next_attempt_at = clock_timestamp() WHERE published_at IS NULL`)
    const recovered = async (to: string) => { assert.equal(to, failing) }
    assert.deepEqual(await runWhatsAppPass(recovered, transact), { attempted: 20, deferred: 0, published: 20 })
    assert.deepEqual(await runWhatsAppPass(recovered, transact), { attempted: 1, deferred: 0, published: 1 })
  })

  await t.test('concurrent workers skip the row another worker is sending', async () => {
    const first = '+919800000003'
    const second = '+919800000004'
    await enqueue(first)
    await enqueue(second)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const firstPass = runWhatsAppPass(async to => {
      assert.equal(to, first)
      started.resolve()
      await release.promise
    }, transact)
    try {
      await Promise.race([started.promise, firstPass.then(() => assert.fail('first worker did not start a send'))])
      assert.deepEqual(await runWhatsAppPass(async to => { assert.equal(to, second) }, transact),
        { attempted: 1, deferred: 0, published: 1 })
    } finally {
      release.resolve()
      assert.deepEqual(await firstPass, { attempted: 1, deferred: 0, published: 1 })
    }
  })

  await t.test('a later database write failure keeps an earlier successful send published', async () => {
    const first = await enqueue('+919800000005')
    const second = await enqueue('+919800000006')
    await pool.query(`ALTER TABLE attendance_outbox ADD CHECK (outbox_id <> ${second} OR published_at IS NULL)`)
    const sent: string[] = []
    await assert.rejects(runWhatsAppPass(async to => { sent.push(to) }, transact), /check constraint/)
    const { rows } = await pool.query('SELECT published_at IS NOT NULL AS published FROM attendance_outbox WHERE outbox_id IN ($1, $2) ORDER BY outbox_id', [first, second])
    assert.deepEqual(rows, [{ published: true }, { published: false }])
    assert.deepEqual(sent, ['+919800000005', '+919800000006'])
  })
})
