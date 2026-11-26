// PURPOSE: Drain committed punch outbox rows into WhatsApp template messages, retrying until delivered.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { database, transaction } from './db.ts'

type Db = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
export type Send = (to: string, params: string[]) => Promise<void>

const istTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })

/** Template body parameters: {{1}} first name, {{2}} "checked in"/"checked out", {{3}} IST time. */
export function punchParams(displayName: string, action: string, recordedAt: string): string[] {
  return [displayName.trim().split(/\s+/)[0] ?? '', action === 'IN' ? 'checked in' : 'checked out', istTime.format(new Date(recordedAt)) + ' IST']
}

/**
 * Send up to 20 unpublished punch notifications. Rows without a WhatsApp number are marked done; a failed send stays
 * queued for the next pass. Returns how many rows were resolved.
 * ponytail: holds row locks during the HTTP calls; fine for one worker at kiosk punch rates, split claim/send if it lags.
 */
export async function drainOutbox(tx: Db, send: Send): Promise<number> {
  const { rows } = await tx.query(`
    SELECT outbox.outbox_id, outbox.payload, employee.display_name, employee.whatsapp_number
      FROM attendance_outbox outbox
      JOIN access_employees employee ON employee.id = (outbox.payload->>'employeeId')::uuid
     WHERE outbox.published_at IS NULL
     ORDER BY outbox.outbox_id
     LIMIT 20
     FOR UPDATE OF outbox SKIP LOCKED`)
  let resolved = 0
  for (const row of rows) {
    const payload = row.payload as { action: string; recordedAt: string }
    if (typeof row.whatsapp_number === 'string') {
      try { await send(row.whatsapp_number, punchParams(String(row.display_name), payload.action, payload.recordedAt)) }
      catch { continue }
    }
    await tx.query('UPDATE attendance_outbox SET published_at = clock_timestamp() WHERE outbox_id = $1', [row.outbox_id])
    resolved++
  }
  return resolved
}

/** WhatsApp Cloud API sender. Business-initiated messages must use an approved template with three body parameters. */
export function cloudApiSender(): Send {
  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID, template = process.env.WHATSAPP_TEMPLATE
  if (!token || !phoneId || !template) throw new Error('WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TEMPLATE are required')
  return async (to, params) => {
    const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(phoneId)}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: to.replace('+', ''), type: 'template', template: {
        name: template, language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? 'en' },
        components: [{ type: 'body', parameters: params.map(text => ({ type: 'text', text })) }],
      } }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error('WhatsApp send failed ' + res.status)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const send = cloudApiSender()
  const pool = database()
  for (;;) {
    try {
      const done = await transaction(tx => drainOutbox(tx, send), pool)
      if (done === 20) continue
    } catch (error) {
      // Database errors may carry personal data; report only the error class.
      console.error('WhatsApp outbox pass failed', error instanceof Error ? error.name : 'Error')
    }
    await new Promise(wake => setTimeout(wake, 5000))
  }
}
