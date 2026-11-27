// PURPOSE: Run integration tests on a fresh, loopback-only PostgreSQL instance.
import { randomBytes } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import EmbeddedPostgres from 'embedded-postgres'

export async function startDatabase() {
  const socket=createServer()
  const port=await new Promise<number>((resolve,reject)=>{
    socket.once('error',reject)
    socket.listen(0,'127.0.0.1',()=>{
      const address=socket.address()
      if (!address || typeof address==='string') return reject(Error('No loopback port'))
      socket.close(()=>resolve(address.port))
    })
  })
  const password=randomBytes(24).toString('hex')
  const temp=await realpath(tmpdir())
  const dir=await realpath(await mkdtemp(join(temp,'elt-kiosk-pg-')))
  if (dirname(dir)!==temp || !basename(dir).startsWith('elt-kiosk-pg-')) throw Error('Unexpected test directory')
  const engine=new EmbeddedPostgres({databaseDir:dir,port,user:'postgres',password,
    persistent:true,authMethod:'scram-sha-256',postgresFlags:['-h','127.0.0.1'],
    initdbFlags:['--encoding=UTF8','--locale=C'],onLog:()=>{},onError:()=>{}})
  await engine.initialise()
  // Windows taskkill can orphan PostgreSQL children that retain the test process pipes.
  // pg_ctl coordinates clean shutdown with the running database instead.
  const windowsPackage='@embedded-postgres/windows-x64'
  const control:string|undefined=process.platform==='win32' ? (await import(windowsPackage)).pg_ctl : undefined
  const run=(command:string,args:string[])=>new Promise<void>((resolve,reject)=>{
    const proc=spawn(command,args,{windowsHide:true,stdio:'ignore'})
    proc.once('error',reject)
    proc.once('exit',code=>code===0?resolve():reject(Error('pg_ctl exited with code '+code)))
  })
  if (control) await run(control,['-D',dir,'-l',join(dir,'server.log'),'-o','-h 127.0.0.1 -p '+port,'-w','start'])
  else await engine.start()
  return {url:'postgres://postgres:'+password+'@127.0.0.1:'+port+'/postgres', stop:async()=>{
    if (control) await run(control,['-D',dir,'-m','fast','-w','stop'])
    else await engine.stop()
    await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:150})
  }}
}
