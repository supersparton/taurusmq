'use client';
// dashboard/src/app/login/page.tsx
// Login page — shown when user is not authenticated.
// Submits to API POST /api/auth/login.
// On success, the API sets an httpOnly cookie and redirects to dashboard.

import { useState, FormEvent } from 'react';
import { login } from '@/lib/api';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState<string | null>(null);
  const [loading,  setLoading]  = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await login(username, password);
      // Cookie is now set — redirect to dashboard (or intended destination)
      const params = new URLSearchParams(window.location.search);
      window.location.href = params.get('from') ?? '/';
    } catch {
      setError('Invalid username or password');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg-base)',
      fontFamily: 'var(--font-sans)',
    }}>
      <div style={{
        width: 380,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '36px 32px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.4)',
      }}>

        {/* Logo / title */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 10, marginBottom: 12,
          }}>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <circle cx="14" cy="14" r="13" stroke="#06b6d4" strokeWidth="2"/>
              <path d="M8 14 L14 8 L20 14 L14 20 Z" fill="#06b6d4" opacity="0.8"/>
              <circle cx="14" cy="14" r="3" fill="#06b6d4"/>
            </svg>
            <span style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
              TaurusMQ
            </span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Observability Dashboard
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label style={{
              display: 'block', fontSize: 11.5, fontWeight: 600,
              color: 'var(--text-muted)', textTransform: 'uppercase',
              letterSpacing: '0.07em', marginBottom: 6,
            }}>
              Username
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '9px 12px',
                background: 'var(--bg-base)',
                border: `1px solid ${error ? '#ef4444' : 'var(--border)'}`,
                borderRadius: 4,
                color: 'var(--text-primary)',
                fontSize: 13.5,
                fontFamily: 'var(--font-mono)',
                outline: 'none',
                transition: 'border-color 0.15s',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent-cyan)'; }}
              onBlur={e  => { e.currentTarget.style.borderColor = error ? '#ef4444' : 'var(--border)'; }}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <label style={{
              display: 'block', fontSize: 11.5, fontWeight: 600,
              color: 'var(--text-muted)', textTransform: 'uppercase',
              letterSpacing: '0.07em', marginBottom: 6,
            }}>
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '9px 12px',
                background: 'var(--bg-base)',
                border: `1px solid ${error ? '#ef4444' : 'var(--border)'}`,
                borderRadius: 4,
                color: 'var(--text-primary)',
                fontSize: 13.5,
                fontFamily: 'var(--font-mono)',
                outline: 'none',
                transition: 'border-color 0.15s',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent-cyan)'; }}
              onBlur={e  => { e.currentTarget.style.borderColor = error ? '#ef4444' : 'var(--border)'; }}
            />
          </div>

          {/* Error message */}
          {error && (
            <div style={{
              marginBottom: 16, padding: '8px 12px',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 4,
              fontSize: 12.5, color: '#ef4444',
            }}>
              {error}
            </div>
          )}

          <button
            id="login-submit"
            type="submit"
            disabled={loading || !username || !password}
            style={{
              width: '100%', padding: '10px',
              background: loading ? 'var(--bg-base)' : 'var(--accent-cyan)',
              color: loading ? 'var(--text-muted)' : '#000',
              border: 'none', borderRadius: 4,
              fontSize: 13.5, fontWeight: 700,
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'opacity 0.15s',
              letterSpacing: '0.02em',
            }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {/* Footer note */}
        <div style={{
          marginTop: 24, paddingTop: 20,
          borderTop: '1px solid var(--border-subtle)',
          fontSize: 11, color: 'var(--text-dim)',
          textAlign: 'center', lineHeight: 1.6,
        }}>
          Credentials stored locally in <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>.taurusmq/</code><br />
          No cloud. No telemetry. Entirely local.
        </div>
      </div>
    </div>
  );
}
