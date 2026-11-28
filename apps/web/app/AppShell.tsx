'use client'
// PURPOSE: One Supabase session for the whole portal: password sign-in and sign-up, approval wait, admin second factor, and tab navigation.
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { SecondFactor } from './SecondFactor'

type Auth = { auth: SupabaseClient, token: string, email: string, operator: boolean, signOut: () => void, requireMfa: () => void }
const AuthContext = createContext<Auth | null>(null)
export function useAuth(): Auth {
  const value = useContext(AuthContext)
  if (!value) throw Error('useAuth must be used inside AppShell')
  return value
}

export class ApiError extends Error {
  code: string
  data: Record<string, unknown>
  constructor(code: string, data: Record<string, unknown>) { super(code); this.code = code; this.data = data }
}
/** JSON call to the portal API with the signed-in bearer token. Throws ApiError carrying the server's error code. */
export async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', 'Bearer ' + token)
  if (init.body) headers.set('Content-Type', 'application/json')
  const res = await fetch(path, { ...init, cache: 'no-store', headers })
  const data = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) throw new ApiError(typeof data.error === 'string' ? data.error : 'service_unavailable', data)
  return data as T
}

// Outline icons, 24px grid, drawn with the current text colour.
const icons = {
  home: 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8M3 10a2 2 0 0 1 .7-1.5l7-6a2 2 0 0 1 2.6 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  history: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2',
  leave: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01',
  fix: 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.4 2.6a1 1 0 0 1 3 3l-9 9a2 2 0 0 1-.85.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.85z',
  settings: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  admin: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  menu: 'M4 6h16M4 12h16M4 18h16',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  today: 'M8 2v4M16 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 15l2 2 4-4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  face: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM7 18a5 5 0 0 1 10 0',
  chevron: 'm9 18 6-6-6-6',
  down: 'm6 9 6 6 6-6',
  checkin: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
  filter: 'M22 3H2l8 9.46V19l4 2v-8.54z',
  kiosk: 'M4 4h16v11H4zM8 21h8M12 15v6',
  refresh: 'M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5',
  code: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M8 8h3v3H8zM13 8h3v3h-3zM8 13h3v3H8zM13 13h3v3h-3z',
}
export function Icon({ name, size = 22 }: { name: keyof typeof icons, size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={icons[name]} /></svg>
}

function SignIn({ auth }: { auth: SupabaseClient }) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setMessage('')
    try {
      if (creating) {
        const { data, error } = await auth.auth.signUp({ email: email.trim(), password, options: { data: { name: name.trim() } } })
        if (error) setMessage(error.message.includes('registered') ? 'That email already has an account. Sign in instead.' : 'Could not create the account: ' + error.message)
        else if (!data.session) setMessage('Account created, but email confirmation is still switched on in Supabase. Ask your admin.')
      } else {
        const { error } = await auth.auth.signInWithPassword({ email: email.trim(), password })
        if (error) setMessage('Wrong email or password.')
      }
    } catch { setMessage('Could not reach sign-in. Check your connection.') } finally { setBusy(false); setPassword('') }
  }
  return <div className="auth-screen"><div className="auth-card">
    <img src="/elt.png" alt="ELT Corporate" />
    <h1>{creating ? 'Create your account' : 'Welcome back'}</h1>
    <p>{creating ? 'An admin approves new accounts before you can register your face.' : 'Sign in to see your attendance.'}</p>
    <form onSubmit={submit}>
      {creating && <label>Full name<input autoComplete="name" required maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>}
      <label>Work email<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
      <label>Password<input type="password" autoComplete={creating ? 'new-password' : 'current-password'} required minLength={8} value={password} onChange={e => setPassword(e.target.value)} /></label>
      <button disabled={busy}>{busy ? 'Please wait…' : creating ? 'Create account' : 'Sign in'}</button>
    </form>
    {message && <p className="form-error" role="alert">{message}</p>}
    <button type="button" className="link-button" onClick={() => { setCreating(value => !value); setMessage('') }}>
      {creating ? 'I already have an account' : 'New here? Create an account'}
    </button>
  </div></div>
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="auth-screen"><div className="auth-card">{children}</div></div>
}

const tabs = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/history', label: 'History', icon: 'history' },
  { href: '/leave', label: 'Leave', icon: 'leave' },
  { href: '/corrections', label: 'Corrections', icon: 'fix' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
] as const

export function AppShell({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<SupabaseClient>()
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [account, setAccount] = useState<'checking' | 'pending' | 'approved' | 'error'>('checking')
  const [operator, setOperator] = useState(false)
  const [mfa, setMfa] = useState(false)
  const [recheck, setRecheck] = useState(0)
  const path = usePathname()
  // The tab just tapped, so the pill moves immediately instead of waiting for the route to load.
  const [tapped, setTapped] = useState<string | null>(null)
  useEffect(() => setTapped(null), [path])
  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    if (!url || !key) { setSession(null); return }
    const client = createClient(url, key)
    setAuth(client)
    void client.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = client.auth.onAuthStateChange((event, next) => { setSession(next); if (event === 'SIGNED_OUT') setMfa(false) })
    return () => data.subscription.unsubscribe()
  }, [])
  const token = session?.access_token
  useEffect(() => {
    setAccount('checking')
    if (!token || !session) return
    const controller = new AbortController()
    const meta = session.user.user_metadata as { name?: unknown }
    const displayName = typeof meta?.name === 'string' && meta.name.trim() ? meta.name.trim() : (session.user.email ?? 'Employee').split('@')[0]
    api<{ state: 'pending' | 'approved', operator: boolean }>('/api/signup', token, { method: 'POST', body: JSON.stringify({ displayName }), signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setAccount(result.state); setOperator(result.operator) } })
      .catch(() => { if (!controller.signal.aborted) setAccount('error') })
    return () => controller.abort()
  }, [token, recheck])

  if (session === undefined) return <Centered><p>Loading…</p></Centered>
  if (!auth) return <Centered><h1>Not configured</h1><p>Sign-in has not been configured on this server. Contact HR.</p></Centered>
  if (!session || !token) return <SignIn auth={auth} />
  const signOut = () => { void auth.auth.signOut() }
  if (account === 'checking') return <Centered><p>Loading your account…</p></Centered>
  if (account === 'error') return <Centered><h1>Can’t reach attendance</h1><p>Check your connection and try again.</p><button onClick={() => setRecheck(n => n + 1)}>Try again</button><button className="link-button" onClick={signOut}>Sign out</button></Centered>
  if (account === 'pending') return <Centered>
    <div className="pending-badge">Pending approval</div>
    <h1>You’re on the list</h1>
    <p>An admin needs to approve your account. After that you get your Employee ID and can register your face at the kiosk.</p>
    <button onClick={() => setRecheck(n => n + 1)}>Check again</button>
    <button className="link-button" onClick={signOut}>Sign out</button>
  </Centered>
  if (mfa) return <Centered>
    <p>Admin accounts confirm sign-in with the 6-digit code from an authenticator app.</p>
    <SecondFactor auth={auth} onVerified={() => { void auth.auth.refreshSession().then(({ data }) => { setSession(data.session); setMfa(false) }) }} />
    <button className="link-button" onClick={signOut}>Sign out</button>
  </Centered>

  const value: Auth = { auth, token, email: session.user.email ?? '', operator, signOut, requireMfa: () => setMfa(true) }
  const active = tabs.findIndex(tab => tab.href === (tapped ?? path))
  return <AuthContext.Provider value={value}>
    <div className="shell">
      <nav className="tabs" aria-label="App sections">
        {/* One pill that slides under the active tab; hidden on pages outside the tab bar (e.g. Admin). */}
        <span className="tab-pill" aria-hidden="true" style={{ opacity: active < 0 ? 0 : 1, transform: `translateX(${Math.max(active, 0) * 100}%)` }} />
        {tabs.map((tab, i) => <Link key={tab.href} href={tab.href} className={i === active ? 'on' : undefined} aria-current={path === tab.href ? 'page' : undefined} onClick={() => setTapped(tab.href)}><Icon name={tab.icon} /><span>{tab.label}</span></Link>)}
      </nav>
      <main>
        <header className="topbar">
          <details className="menu" key={path}>
            <summary aria-label="Menu"><Icon name="menu" /></summary>
            <div className="menu-panel">
              <p className="menu-email">{value.email}</p>
              {operator && <Link href="/admin"><Icon name="admin" size={20} />Admin</Link>}
              <button type="button" onClick={signOut}><Icon name="logout" size={20} />Sign out</button>
            </div>
          </details>
          <Link href="/" className="wordmark" aria-label="Hr Flow home">Hr <span>Flow</span></Link>
        </header>
        {children}
      </main>
    </div>
  </AuthContext.Provider>
}
