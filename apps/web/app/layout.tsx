// PURPOSE: Provide the layout shared by the employee and HR receipt views.
import type { ReactNode } from 'react'
import './styles.css'
export const metadata = {title:'Attendance · ELT Corporate'}
export default function Layout({children}: {children:ReactNode}) {
  return <html lang="en"><body><aside><img src="/elt.png" alt="ELT Corporate"/><strong>Attendance</strong><small>ELT Corporate</small></aside><main>{children}</main></body></html>
}
