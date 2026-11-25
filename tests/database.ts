// PURPOSE: Run integration tests on a fresh, loopback-only PostgreSQL instance.
import { randomBytes } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createServer } from 'node:net'
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
  await engine.start()
  return {url:'postgres://postgres:'+password+'@127.0.0.1:'+port+'/postgres', stop:async()=>{
    await engine.stop()
    await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:150})
  }}
}
