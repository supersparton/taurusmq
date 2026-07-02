// dashboard/src/app/settings/page.tsx
'use client';
import { useState } from 'react';
import Topbar from '@/components/layout/Topbar';
import { Settings, Database, HardDrive, Key, Eye, EyeOff, Save, Check } from 'lucide-react';

export default function SettingsPage() {
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);

  // Settings state
  const [retentionDays, setRetentionDays] = useState('7');
  const [maxMemory, setMaxMemory] = useState('512MB');
  const [alertEmail, setAlertEmail] = useState('admin@taurusmq.local');

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <>
      <Topbar title="Settings" subtitle="Configure system limits, Redis connections, and API keys" />
      <div className="page-content" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 800 }}>
        
        {/* Redis Status Panel */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Database size={14} style={{ color: 'var(--accent-blue)' }} /> Redis Connection Configuration
            </span>
          </div>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 600, display: 'block', marginBottom: 4 }}>HOST / URI</label>
                <input type="text" readOnly value="127.0.0.1" 
                  style={{ width: '100%', padding: '6px 10px', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-mono)' }} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 600, display: 'block', marginBottom: 4 }}>PORT</label>
                <input type="text" readOnly value="6379" 
                  style={{ width: '100%', padding: '6px 10px', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-mono)' }} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)', padding: '8px 12px', borderRadius: 3, marginTop: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981' }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: '#10b981' }}>Connection Status: Active</span>
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>Ping latency: 1.4ms</span>
            </div>
          </div>
        </div>

        {/* API Credentials Panel */}
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Key size={14} style={{ color: 'var(--accent-cyan)' }} /> API Credentials
            </span>
          </div>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
              Use this secret key to authenticate your jobs and queue workers with the TaurusMQ API. Keep this key confidential.
            </p>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type={showKey ? 'text' : 'password'} readOnly value="tmq_sec_9F8H2S820DKS910398FJS82" 
                style={{ flex: 1, padding: '6px 10px', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'var(--font-mono)' }} />
              <button className="btn btn-ghost" onClick={() => setShowKey(!showKey)} style={{ width: 34, height: 32, padding: 0, justifyContent: 'center' }}>
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
        </div>

        {/* Metrics & System Limits */}
        <form onSubmit={handleSave} className="panel">
          <div className="panel-header">
            <span className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <HardDrive size={14} style={{ color: 'var(--accent-orange)' }} /> Metrics Retention & System Settings
            </span>
          </div>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 600, display: 'block', marginBottom: 4 }}>METRIC RETENTION LIMIT (DAYS)</label>
                <select value={retentionDays} onChange={e => setRetentionDays(e.target.value)}
                  style={{ width: '100%', padding: '6px 10px', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-secondary)', fontSize: 12, outline: 'none' }}>
                  <option value="1">1 Day</option>
                  <option value="3">3 Days</option>
                  <option value="7">7 Days</option>
                  <option value="14">14 Days</option>
                  <option value="30">30 Days</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 600, display: 'block', marginBottom: 4 }}>MAX METRIC MEMORY LIMIT</label>
                <select value={maxMemory} onChange={e => setMaxMemory(e.target.value)}
                  style={{ width: '100%', padding: '6px 10px', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-secondary)', fontSize: 12, outline: 'none' }}>
                  <option value="128MB">128 MB</option>
                  <option value="256MB">256 MB</option>
                  <option value="512MB">512 MB (Default)</option>
                  <option value="1GB">1 GB</option>
                </select>
              </div>
            </div>
            <div>
              <label style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 600, display: 'block', marginBottom: 4 }}>ALERT NOTIFICATION EMAIL</label>
              <input type="email" value={alertEmail} onChange={e => setAlertEmail(e.target.value)}
                style={{ width: '100%', padding: '6px 10px', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-secondary)', fontSize: 12 }} />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
              <button type="submit" className="btn btn-primary" style={{ gap: 6 }}>
                {saved ? <><Check size={14} /> Saved!</> : <><Save size={14} /> Save Configuration</>}
              </button>
            </div>
          </div>
        </form>

      </div>
    </>
  );
}
