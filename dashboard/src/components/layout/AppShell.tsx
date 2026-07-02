'use client';
// dashboard/src/components/layout/AppShell.tsx
// Wraps the entire app — shows sidebar only on non-login routes.

import { usePathname } from 'next/navigation';
import Sidebar from './Sidebar';

const FULL_SCREEN_ROUTES = ['/login'];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isFullScreen = FULL_SCREEN_ROUTES.includes(pathname);

  if (isFullScreen) {
    return <>{children}</>;
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar />
      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {children}
      </main>
    </div>
  );
}
