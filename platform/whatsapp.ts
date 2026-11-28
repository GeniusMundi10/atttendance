// PURPOSE: Deliver committed punch notifications in bounded passes with durable retries.
import { transaction } from './db.ts'

type Db = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
type Transact = <T>(work: (tx: Db) => Promise<T>) => Promise<T>
export type Send = (to: string, params: string[]) => Promise<void>
export type WhatsAppPass = { attempted: number; published: number; deferred: number }

const istTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })
export const WHATSAPP_PASS_LIMIT = 20
const PASS_BUDGET_MS = 20_000
const SEND_TIMEOUT_MS = 5_000

/** Template body parameters: {{1}} first name, {{2}} "checked in"/"checked out", {{3}} IST time. */
export function punchParams(displayName: string, action: string, recordedAt: string): string[] {
  return [displayName.trim().split(/\s+/)[0] ?? '', action === 'IN' ? 'checked in' : 'checked out', istTime.format(new Date(recordedAt)) + ' IST']
}

/** Lock one row through the send and commit its outcome before starting any other row. */
async function deliverOne(tx: Db, send: Send): Promise<'published' | 'deferred' | undefined> {
  await tx.query(`SET LOCAL statement_timeout = '5s'; SET LOCAL idle_in_transaction_session_timeout = '15s'`)
  const { rows } = await tx.query(`
    SELECT outbox.outbox_id, outbox.payload, employee.display_name, employee.whatsapp_number
      FROM attendance_outbox outbox
      JOIN access_employees employee ON employee.id = (outbox.payload->>'employeeId')::uuid
     WHERE outbox.published_at IS NULL
       AND outbox.next_attempt_at <= CURRENT_TIMESTAMP
     ORDER BY outbox.next_attempt_at, outbox.outbox_id
     LIMIT 1
     FOR UPDATE OF outbox SKIP LOCKED`)
  const row = rows[0]
  if (!row) return
  if (typeof row.whatsapp_number === 'string') {
    const payload = row.payload as { action: string; recordedAt: string }
    try {
      await send(row.whatsapp_number, punchParams(String(row.display_name), payload.action, payload.recordedAt))
    } catch {
      await tx.query(`
        UPDATE attendance_outbox SET next_attempt_at = clock_timestamp() + interval '1 minute'
         WHERE outbox_id = $1`, [row.outbox_id])
      return 'deferred'
    }
  }
  // A provider acceptance followed by an interrupted commit can still be delivered again.
  await tx.query('UPDATE attendance_outbox SET published_at = clock_timestamp() WHERE outbox_id = $1', [row.outbox_id])
  return 'published'
}

export async function runWhatsAppPass(send = cloudApiSender(), transact: Transact = transaction): Promise<WhatsAppPass> {
  const result: WhatsAppPass = { attempted: 0, published: 0, deferred: 0 }
  const deadline = performance.now() + PASS_BUDGET_MS
  while (result.attempted < WHATSAPP_PASS_LIMIT && performance.now() < deadline) {
    const outcome = await transact(tx => deliverOne(tx, send))
    if (!outcome) break
    result.attempted++
    result[outcome]++
  }
  return result
}

/** WhatsApp Cloud API sender. Business-initiated messages must use an approved template with three body parameters. */
export function cloudApiSender(): Send {
  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID, template = process.env.WHATSAPP_TEMPLATE
  if (!token || !phoneId || !template) throw new Error('WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TEMPLATE are required')
  return async (to, params) => {
    const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(phoneId)}/messages`, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: to.replace('+', ''), type: 'template', template: {
        name: template, language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? 'en' },
        components: [{ type: 'body', parameters: params.map(text => ({ type: 'text', text })) }],
      } }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    await res.body?.cancel().catch(() => {})
    if (!res.ok) throw new Error('WhatsApp send failed ' + res.status)
  }
}
