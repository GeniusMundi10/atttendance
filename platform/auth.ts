// PURPOSE: Resolve portal bearer tokens only against the configured Supabase project's JWKS.
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { HttpError } from './http.ts'

let getKey: ReturnType<typeof createRemoteJWKSet> | undefined
export async function portalIdentity(request: Request) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!base) throw new HttpError(503,'auth_unconfigured')
  const issuer = base.replace(/\/$/,'') + '/auth/v1'
  const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1]
  if (!token || token.length > 12000) throw new HttpError(401,'sign_in_required')
  getKey ??= createRemoteJWKSet(new URL(issuer + '/.well-known/jwks.json'))
  try {
    const { payload } = await jwtVerify(token,getKey,{issuer,audience:'authenticated',algorithms:['ES256','RS256'],requiredClaims:['exp','sub']})
    if (!payload.sub || payload.role !== 'authenticated' || payload.is_anonymous === true) throw Error()
    return {authProvider:issuer,authSubject:payload.sub,aal:payload.aal==='aal2'?'aal2':'aal1',email:typeof payload.email==='string'?payload.email:''}
  } catch { throw new HttpError(401,'invalid_session') }
}
