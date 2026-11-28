// PURPOSE: Run the bounded WhatsApp delivery worker repeatedly for CLI operators.
import { setTimeout as delay } from 'node:timers/promises'
import { database } from './db.ts'
import { cloudApiSender, runWhatsAppPass, WHATSAPP_PASS_LIMIT } from './whatsapp.ts'

const send = cloudApiSender()
database()
for (;;) {
  try {
    if ((await runWhatsAppPass(send)).attempted === WHATSAPP_PASS_LIMIT) continue
  } catch {
    console.error('WhatsApp outbox pass failed')
  }
  await delay(5000)
}
