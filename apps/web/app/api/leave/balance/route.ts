// PURPOSE: Expose the current monthly paid day balance to its employee.
import { leaveHttp } from '../../../../../../features/leave/http.ts'
export const runtime='nodejs'
export const dynamic='force-dynamic'
export async function GET(request:Request) { return leaveHttp(request,'balance') }
