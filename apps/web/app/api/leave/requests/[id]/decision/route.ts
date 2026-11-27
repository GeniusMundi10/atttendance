// PURPOSE: Record a scoped manager decision or reasoned HR override.
import { leaveHttp } from '../../../../../../../../features/leave/http.ts'
export const runtime='nodejs'
export const dynamic='force-dynamic'
export async function POST(request:Request,context:{params:Promise<{id:string}>}) {
  return leaveHttp(request,'decision',(await context.params).id)
}
