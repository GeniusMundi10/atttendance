// PURPOSE: Wrap every portal page in the shared sign-in gate and tab navigation.
import type { ReactNode } from 'react'
import { AppShell } from './AppShell'
import './styles.css'
export const metadata = {title:'Attendance · ELT Corporate'}
export const viewport = {width:'device-width',initialScale:1,viewportFit:'cover',themeColor:'#ff6330'}
export default function Layout({children}: {children:ReactNode}) {
  return <html lang="en"><body><AppShell>{children}</AppShell></body></html>
}
