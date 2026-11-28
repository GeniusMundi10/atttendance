// PURPOSE: Authenticate scheduled WhatsApp runs and expose only aggregate delivery results.
import { createHash, timingSafeEqual } from 'node:crypto'
import { runWhatsAppPass, type WhatsAppPass } from './whatsapp.ts'

function digest(value: string) {
  return createHash('sha256').update(value).digest()
}

export async function whatsappHttp(
  request: Request,
  run: () => Promise<WhatsAppPass> = runWhatsAppPass,
  secret = process.env.WHATSAPP_CRON_SECRET,
): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' }
  const bearer = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1]
  if (!secret || !bearer || !timingSafeEqual(digest(bearer), digest(secret))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: { ...headers, 'WWW-Authenticate': 'Bearer' } })
  }
  try {
    return Response.json(await run(), { headers })
  } catch {
    // A transport or database exception can contain contact or configuration data.
    return Response.json({ error: 'WhatsApp worker unavailable' }, { status: 503, headers })
  }
}
