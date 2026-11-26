// PURPOSE: Check the WhatsApp outbox drain marks only delivered or numberless rows as published.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { drainOutbox, punchParams } from '../platform/whatsapp.ts'

test('outbox drain sends, skips numberless rows, and keeps failed sends queued', async () => {
  const rows = [
    { outbox_id: 1, display_name: 'Asha Rao', whatsapp_number: '+919800000001', payload: { action: 'IN', recordedAt: '2026-11-26T03:30:00Z' } },
    { outbox_id: 2, display_name: 'No Phone', whatsapp_number: null, payload: { action: 'OUT', recordedAt: '2026-11-26T12:00:00Z' } },
    { outbox_id: 3, display_name: 'Fails Once', whatsapp_number: '+919800000003', payload: { action: 'OUT', recordedAt: '2026-11-26T12:00:00Z' } },
  ]
  const published: unknown[] = []
  const sent: [string, string[]][] = []
  const db = { async query(sql: string, values: unknown[] = []) {
    if (sql.includes('FROM attendance_outbox')) return { rows }
    if (sql.includes('UPDATE attendance_outbox')) { published.push(values[0]); return { rows: [] } }
    throw new Error('Unexpected query')
  } }
  const done = await drainOutbox(db, async (to, params) => {
    if (to.endsWith('3')) throw new Error('synthetic outage')
    sent.push([to, params])
  })
  assert.equal(done, 2)
  assert.deepEqual(published, [1, 2])
  assert.deepEqual(sent, [['+919800000001', ['Asha', 'checked in', punchParams('Asha', 'IN', '2026-11-26T03:30:00Z')[2]]]])
  assert.match(sent[0]![1][2]!, /9:00 am IST$/i)
})
