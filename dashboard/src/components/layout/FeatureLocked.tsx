// dashboard/src/components/layout/FeatureLocked.tsx
'use client';
import Link from 'next/link';
import { Lock, ArrowLeft } from 'lucide-react';

export default function FeatureLocked({ featureName, phase }: { featureName: string; phase: string }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '80vh',
      textAlign: 'center',
      padding: 24,
      gap: 16,
      color: 'var(--text-primary)',
    }}>
      <div style={{
        width: 56,
        height: 56,
        borderRadius: '50%',
        background: 'var(--accent-blue-dim)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--accent-blue)',
        marginBottom: 8,
      }}>
        <Lock size={24} />
      </div>
      <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
        {featureName} is locked
      </h2>
      <p style={{
        fontSize: 13,
        color: 'var(--text-muted)',
        maxWidth: 360,
        margin: '0 0 12px 0',
        lineHeight: 1.5,
      }}>
        This feature is planned for <strong>{phase}</strong> of the TaurusMQ roadmap. 
        Configure your feature flags in <code>src/lib/features.ts</code> to enable it.
      </p>
      <Link href="/">
        <button className="btn btn-ghost" style={{ fontSize: 12, gap: 6 }}>
          <ArrowLeft size={12} /> Back to Overview
        </button>
      </Link>
    </div>
  );
}
