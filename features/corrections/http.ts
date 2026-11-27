// PURPOSE: Handle authenticated correction requests and per-date decisions under isolated API paths.
import { resolveAuthenticatedSubject } from '../access/access.ts';
import { portalIdentity } from '../../platform/auth.ts';
import { transaction } from '../../platform/db.ts';
import { body, HttpError, json } from '../../platform/http.ts';
import { createCorrectionRequest, decideCorrectionDay, listCorrectionDays } from './corrections.ts';

export async function correctionsApi(request: Request, parts: string[]): Promise<Response> {
  const subject = await portalIdentity(request);
  if (parts.length === 1 && parts[0] === 'requests') {
    if (request.method === 'GET') {
      const scope = new URL(request.url).searchParams.get('scope') ?? 'mine';
      if (scope !== 'mine' && scope !== 'review') throw new HttpError(400, 'invalid_scope');
      return transaction(async tx => {
        const actor = await resolveAuthenticatedSubject(tx, subject);
        return json({ days: await listCorrectionDays(tx, actor, scope) });
      });
    }
    if (request.method === 'POST') {
      const data = await body(request);
      return transaction(async tx => {
        const actor = await resolveAuthenticatedSubject(tx, subject);
        return json({ days: await createCorrectionRequest(tx, actor, data) }, 201);
      });
    }
  }
  if (parts.length === 3 && parts[0] === 'days' && parts[2] === 'decision' && request.method === 'POST') {
    const data = await body(request);
    return transaction(async tx => {
      const actor = await resolveAuthenticatedSubject(tx, subject);
      return json({ day: await decideCorrectionDay(tx, actor, parts[1]!, data) });
    });
  }
  throw new HttpError(404, 'unknown_endpoint');
}
