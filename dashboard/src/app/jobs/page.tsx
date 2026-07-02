'use client';
import Topbar from '@/components/layout/Topbar';
import { relativeTime, jobStateBadge, jobStateDotColor, fmtMs } from '@/lib/utils';
import { Search, Filter } from 'lucide-react';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { getJobs } from '@/lib/api';

export default function JobsPage() {
  const [jobsData, setJobsData] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const raw = await getJobs();
        if (active && raw) {
          setJobsData(raw);
        }
      } catch (err) {
        if (active) {
          setJobsData([]);
        }
      }
    }
    load();
    const interval = setInterval(load, 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const filteredJobs = jobsData.filter(job => {
    const term = searchTerm.toLowerCase();
    if (!term) return true;
    return (
      job.id?.toLowerCase().includes(term) ||
      job.name?.toLowerCase().includes(term) ||
      job.queueName?.toLowerCase().includes(term) ||
      job.failedReason?.toLowerCase().includes(term)
    );
  });

  return (
    <>
      <Topbar title="Job Inspector" subtitle="Search and inspect individual jobs" />
      <div className="page-content" style={{ padding: 12 }}>
        <div className="panel">
          <div className="panel-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
              <Search size={13} color="var(--text-muted)" />
              <input
                placeholder="Search by job ID, name, queue, or error message…"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                style={{
                  background: 'transparent', border: 'none', outline: 'none',
                  color: 'var(--text-primary)', fontSize: 13, flex: 1, fontFamily: 'var(--font-mono)',
                }}
              />
            </div>
            <button className="btn btn-ghost" style={{ fontSize: 11 }}><Filter size={11} /> Filters</button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Job ID</th>
                  <th>Name</th>
                  <th>Queue</th>
                  <th>State</th>
                  <th>Attempts</th>
                  <th>Duration</th>
                  <th>Age</th>
                  <th>Failure Reason</th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '36px 0', fontSize: 13 }}>
                      {searchTerm ? 'No jobs match your search filter' : 'No jobs found in the queue database'}
                    </td>
                  </tr>
                ) : (
                  filteredJobs.map(job => (
                    <tr key={job.id}>
                      <td>
                        <Link href={`/jobs/${job.id}`} style={{ color: 'var(--accent-blue)', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
                          {job.id}
                        </Link>
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{job.name}</td>
                      <td><span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-muted)' }}>{job.queueName}</span></td>
                      <td>
                        <span className={`badge ${jobStateBadge(job.state)}`}>
                          <span className="badge-dot" style={{ background: jobStateDotColor(job.state) }} />
                          {job.state}
                        </span>
                      </td>
                      <td style={{ fontVariantNumeric: 'tabular-nums', color: job.attempts >= job.maxAttempts ? '#ef4444' : 'inherit' }}>
                        {job.attempts}/{job.maxAttempts}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                        {job.duration ? fmtMs(job.duration) : '—'}
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 11 }} suppressHydrationWarning>{relativeTime(job.timestamp)}</td>
                      <td style={{ maxWidth: 260 }}>
                        {job.failedReason && (
                          <span style={{ fontSize: 11, color: '#ef4444', fontFamily: 'var(--font-mono)', display: 'block',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
                            {job.failedReason}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
