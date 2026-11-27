// PURPOSE: Build the portal and the feature modules in one server application.
import { fileURLToPath } from 'node:url'
export default {
  poweredByHeader: false,
  devIndicators: false,
  turbopack: {root: fileURLToPath(new URL('../../', import.meta.url))},
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  serverExternalPackages: ['pg'],
  // Dev only: let phones reach `next dev` through an ngrok tunnel.
  allowedDevOrigins: ['*.ngrok-free.dev', '*.ngrok-free.app']
}
