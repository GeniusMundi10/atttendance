// PURPOSE: Wrap the deployed ELT Attendance portal as an Android app; the portal keeps its server API routes.
import type { CapacitorConfig } from '@capacitor/cli'

// The Next.js portal needs its server (API routes, auth), so the app loads the HTTPS deployment rather than a static export.
const url = process.env.ELT_PORTAL_URL
if (!url?.startsWith('https://')) throw new Error('Set ELT_PORTAL_URL to the deployed https:// portal origin before running cap commands')

const config: CapacitorConfig = {
  appId: 'com.elt.attendance.portal',
  appName: 'ELT Attendance',
  webDir: 'www',
  server: { url, cleartext: false, errorPath: 'index.html' },
  android: { backgroundColor: '#fff7f3' },
}
export default config
