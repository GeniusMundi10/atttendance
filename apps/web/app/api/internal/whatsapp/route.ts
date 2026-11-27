// PURPOSE: Run one authenticated WhatsApp delivery pass for the scheduler.
import { whatsappHttp } from '../../../../../../platform/whatsapp-http.ts'

export const runtime = 'nodejs'
export const maxDuration = 60

export function POST(request: Request) {
  return whatsappHttp(request)
}
