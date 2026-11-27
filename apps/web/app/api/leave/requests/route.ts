// PURPOSE: Expose current paid leave requests and application for verified portal users.
import { leaveHttp } from '../../../../../../features/leave/http.ts'
export const runtime='nodejs'
export const dynamic='force-dynamic'
export async function GET(request:Request) { return leaveHttp(request,'requests') }
export async function POST(request:Request) { return leaveHttp(request,'requests') }
