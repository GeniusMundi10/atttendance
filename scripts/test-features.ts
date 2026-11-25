// PURPOSE: Exercise all feature tests with real disposable PostgreSQL.
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { startDatabase } from '../tests/database.ts'

const db=await startDatabase()
try {
  const files:string[]=[]
  for (const feature of ['access','attendance','biometrics']) {
    const path='features/'+feature
    for (const entry of await readdir(path)) if (entry.endsWith('.test.ts')) files.push(path+'/'+entry)
  }
  const result=await new Promise<number>((done,fail)=>{
    const child=spawn(process.execPath,['--experimental-strip-types','--test',...files],{
      env:{...process.env,ACCESS_TEST_DATABASE_URL:db.url,ATTENDANCE_TEST_DATABASE_URL:db.url},stdio:'inherit'})
    child.once('error',fail);child.once('exit',code=>done(code??1))
  })
  process.exitCode=result
} finally { await db.stop() }
