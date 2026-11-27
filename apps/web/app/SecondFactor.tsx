'use client'
// PURPOSE: Let privileged portal users enroll or verify a Supabase TOTP authenticator.
import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
export function SecondFactor({auth,onVerified}:{auth:SupabaseClient,onVerified:()=>void}) {
  const [factor,setFactor]=useState('')
  const [qr,setQr]=useState('')
  const [code,setCode]=useState('')
  const [message,setMessage]=useState('')
  const [busy,setBusy]=useState(false)
  async function prepare() {
    setBusy(true)
    try {
      const factors=await auth.auth.mfa.listFactors()
      if (factors.error) throw factors.error
      if (factors.data.totp[0]) {setFactor(factors.data.totp[0].id);return}
      const enrolled=await auth.auth.mfa.enroll({factorType:'totp',issuer:'ELT Corporate'})
      if (enrolled.error) throw enrolled.error
      setQr(enrolled.data.totp.qr_code);setFactor(enrolled.data.id)
    } catch {setMessage('Authenticator unavailable. Retry or contact HR.')} finally {setBusy(false)}
  }
  async function verify() {
    setBusy(true)
    try {
      const result=await auth.auth.mfa.challengeAndVerify({factorId:factor,code})
      if (result.error) throw result.error
      onVerified()
    } catch {setMessage('Verification failed. Try a fresh code.')} finally {setBusy(false)}
  }
  return <section><h2>Verify your authenticator</h2>{!factor?
    <button onClick={prepare} disabled={busy}>Set up or verify authenticator</button>:
    <form onSubmit={e=>{e.preventDefault();void verify()}}>
      {qr && <img src={qr} alt="Scan this code with your authenticator" width="180" height="180"/>}
      <label>Six-digit code<input autoComplete="one-time-code" inputMode="numeric" required pattern="[0-9]{6}" value={code} onChange={e=>setCode(e.target.value)}/></label>
      <button disabled={busy}>Verify</button></form>}
    <p role="status">{message}</p></section>
}
