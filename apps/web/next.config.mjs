// PURPOSE: Build the portal and the feature modules in one server application.
import { fileURLToPath } from 'node:url'
export default {
  poweredByHeader: false,
  turbopack: {root: fileURLToPath(new URL('../../', import.meta.url))},
  serverExternalPackages: ['pg']
}
