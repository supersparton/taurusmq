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
  
  // Pagination State
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

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

  // Reset page when search term changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm]);

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

  // Calculate pagination boundaries
  const totalItems = filteredJobs.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  const paginatedJobs = filteredJobs.slice(startIndex, endIndex);

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
                {paginatedJobs.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '36px 0', fontSize: 13 }}>
                      {searchTerm ? 'No jobs match your search filter' : 'No jobs found in the queue database'}
                    </td>
                  </tr>
                ) : (
                  paginatedJobs.map(job => (
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

          {/* Pagination Controls */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 16px',
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-surface)',
            fontSize: 12,
            color: 'var(--text-muted)',
            flexWrap: 'wrap',
            gap: 12
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span>
                Showing <strong>{totalItems > 0 ? startIndex + 1 : 0}</strong> to <strong>{endIndex}</strong> of <strong>{totalItems}</strong> jobs
              </span>
              <select
                value={pageSize}
                onChange={e => {
                  setPageSize(Number(e.target.value));
                  setCurrentPage(1);
                }}
                style={{
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border)',
                  borderRadius: 3,
                  color: 'var(--text-primary)',
                  padding: '2px 6px',
                  fontSize: 11,
                  outline: 'none',
                }}
              >
                {[10, 25, 50, 100].map(sz => (
                  <option key={sz} value={sz}>{sz} / page</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                disabled={currentPage === 1}
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                className="btn btn-ghost"
                style={{
                  padding: '4px 10px',
                  fontSize: 11,
                  opacity: currentPage === 1 ? 0.4 : 1,
                  cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
                }}
              >
                Previous
              </button>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
                Page {currentPage} of {totalPages}
              </span>
              <button
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                className="btn btn-ghost"
                style={{
                  padding: '4px 10px',
                  fontSize: 11,
                  opacity: currentPage === totalPages ? 0.4 : 1,
                  cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
                }}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
