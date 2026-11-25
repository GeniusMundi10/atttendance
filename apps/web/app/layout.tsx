// PURPOSE: Provide the layout shared by the employee and HR receipt views.
import type { ReactNode } from 'react'
import './styles.css'
export const metadata = {title:'Attendance · ELT Corporate'}
export default function Layout({children}: {children:ReactNode}) {
  return <html lang="en"><body><aside><img src="/elt.png" alt="ELT Corporate"/><strong>Attendance</strong><small>ELT Corporate</small><nav aria-label="Portal sections"><a href="/">Attendance</a><a href="/corrections">Corrections</a><a href="/leave">Paid leave</a></nav></aside><main>{children}</main></body></html>
}
