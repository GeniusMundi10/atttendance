// PURPOSE: Bound incoming JSON and map errors to safe, uncached responses.
export class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code }
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415,'json_required')
  const reader = request.body?.getReader()
  if (!reader) throw new HttpError(400,'empty_body')
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const {done,value} = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 65536) { await reader.cancel(); throw new HttpError(413,'body_too_large') }
    chunks.push(value)
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw Error()
    return data
  } catch { throw new HttpError(400,'invalid_json') }
}
export function json(value: unknown, status = 200) {
  return Response.json(value,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}})
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) throw new HttpError(400,'invalid_id')
  return value
}
