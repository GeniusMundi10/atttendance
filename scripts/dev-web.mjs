// PURPOSE: Local dev only: load root .env.local then .env (first value wins) and run `next dev apps/web`, which otherwise reads env files from apps/web.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

for (const file of ['.env.local', '.env']) if (existsSync(file)) process.loadEnvFile(file)
const port = process.argv[2] ?? '3000'
const web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', port], { stdio: 'inherit', env: process.env })
web.on('exit', code => process.exit(code ?? 0))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => web.kill(signal))
