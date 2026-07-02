import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import AppShell from '@/components/layout/AppShell';

export const metadata: Metadata = {
  title: 'TaurusMQ — Observability Dashboard',
  description: 'Production-grade distributed job queue monitoring. Queue health, worker status, job inspection, and real-time analytics.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
