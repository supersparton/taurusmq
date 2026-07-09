// packages/dashboard-api/server.js
// REST + WebSocket gateway for the TaurusMQ dashboard.
//
// Auth: httpOnly cookie (tmq_token) containing a signed JWT.
//       All /api/* routes except /api/auth/* require a valid cookie.
//
// Routes:
//   POST /api/auth/login                        — issue JWT cookie
//   GET  /api/auth/me                           — check session (public)
//   POST /api/auth/logout                       — clear JWT cookie
//   GET  /api/queues                            — all queue metrics
//   GET  /api/queues/:name                      — single queue + forecast
//   GET  /api/queues/:name/errors               — error group breakdown
//   GET  /api/workers                           — all worker states
//   GET  /api/incidents                         — firing + history
//   GET  /api/incidents/:id/rca                 — RCA hypotheses
//   GET  /api/recommendations                   — ranked recommendations
//   GET  /api/forecast                          — capacity forecasts
//   GET  /api/cost                              — cost summary per queue
//   GET  /api/events?from=<ms>&to=<ms>          — event stream history
//   POST /api/queues/:name/actions/pause-retries
//   WS   /ws                                    — live update stream

'use strict';

const http               = require('http');
const { WebSocketServer } = require('ws');
const Redis              = require('ioredis');
const redis              = require('../../src/utils/redis');

const { MetricsAggregator }    = require('../metrics-engine/MetricsAggregator');
const { MetricsCollector }     = require('../metrics-engine/MetricsCollector');
const { IncidentEngine }       = require('../incident-engine/IncidentEngine');
const { RecommendationEngine } = require('../recommendation-engine/RecommendationEngine');
const { ForecastingEngine }    = require('../forecasting-engine/ForecastingEngine');
const { EventStreamWriter }    = require('../observability-core/EventStreamWriter');
const { bus }                  = require('../observability-core/ObservabilityBus');
const { createAuth }           = require('./AuthMiddleware');

const PUBSUB_CH = 'tmq:obs:push';

// ── CORS: allowed dashboard origins ───────────────────────────────────────────
// Localhost defaults cover local dev.
// For server deployment, set: OBS_ALLOWED_ORIGINS=https://dashboard.mycompany.com
// Multiple origins: OBS_ALLOWED_ORIGINS=https://a.com,https://b.com
const DEFAULT_ORIGINS = ['http://localhost:3333', 'http://localhost:3000', 'http://127.0.0.1:3333'];
const ALLOWED_ORIGINS = process.env.OBS_ALLOWED_ORIGINS
  ? [...process.env.OBS_ALLOWED_ORIGINS.split(',').map(s => s.trim()), ...DEFAULT_ORIGINS]
  : DEFAULT_ORIGINS;

// Auth functions — populated in startObservabilityStack()
let _auth = null;

// ── HTTP server ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin ?? '';

  res.setHeader('Content-Type', 'application/json');
  // Secure headers (Helmet equivalent)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // CORS — allow only configured origins (never wildcard on auth-protected server)
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  if (origin && isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-TaurusMQ-CSRF, X-Requested-With');
  }

  if (req.method === 'OPTIONS') {
    if (origin && isAllowed) {
      res.writeHead(204);
    } else {
      res.writeHead(400);
    }
    res.end();
    return;
  }

  const url  = new URL(req.url, `http://localhost`);
  const path = url.pathname;

  try {
    // ── Auth routes (public) ─────────────────────────────────────────────
    if (req.method === 'POST' && path === '/api/auth/login') {
      return _auth.handleLogin(req, res);
    }
    if (req.method === 'GET' && path === '/api/auth/me') {
      return _auth.handleMe(req, res);
    }
    if (req.method === 'POST' && path === '/api/auth/logout') {
      return _auth.handleLogout(req, res);
    }

    // ── All routes below require a valid session ──────────────────────────
    if (!_auth.requireAuth(req, res)) return; // wrote 401 already

    // ── GET /api/queues ───────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/queues') {
      const queueNames = await discoverQueues();
      const metrics    = await Promise.all(queueNames.map(readQueueMetrics));
      return json(res, metrics);
    }

    // ── GET /api/queues/:name ─────────────────────────────────────────────
    const queueMatch = path.match(/^\/api\/queues\/([^/]+)$/);
    if (req.method === 'GET' && queueMatch) {
      const name     = decodeURIComponent(queueMatch[1]);
      const metrics  = await readQueueMetrics(name);
      const forecast = await _forecasting.forecastQueue(name);
      const rawHistory = await redis.lrange(`tmq:obs:metrics:${name}:history`, 0, -1) ?? [];
      const history = rawHistory.map(h => {
        try { return JSON.parse(h); } catch { return null; }
      }).filter(Boolean);
      return json(res, { ...metrics, forecast, history });
    }

    // ── GET /api/queues/:name/errors ──────────────────────────────────────
    const errMatch = path.match(/^\/api\/queues\/([^/]+)\/errors$/);
    if (req.method === 'GET' && errMatch) {
      const name   = decodeURIComponent(errMatch[1]);
      const raw    = await redis.hgetall(`tmq:obs:metrics:${name}:errors`) ?? {};
      const sorted = Object.entries(raw)
        .map(([msg, count]) => ({ message: msg, count: parseInt(count, 10) }))
        .sort((a, b) => b.count - a.count);
      return json(res, sorted);
    }

    // ── GET /api/workers ──────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/workers') {
      const workers = await readAllWorkers();
      return json(res, workers);
    }

    // ── GET /api/workers/heatmap ──────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/workers/heatmap') {
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const heatmapKey = `tmq:obs:workers:heatmap:${dateStr}`;

      const yesterday = new Date(now.getTime() - 24 * 3600_000);
      const yestDateStr = yesterday.toISOString().split('T')[0];
      const yestHeatmapKey = `tmq:obs:workers:heatmap:${yestDateStr}`;

      const [todayData, yestData] = await Promise.all([
        redis.hgetall(heatmapKey) ?? {},
        redis.hgetall(yestHeatmapKey) ?? {},
      ]);

      const list = [];
      const workerIdsSet = new Set();
      
      const allKeys = [...Object.keys(todayData), ...Object.keys(yestData)];
      for (const k of allKeys) {
        const parts = k.split(':');
        if (parts.length >= 1) workerIdsSet.add(parts[0]);
      }
      
      const workerIds = Array.from(workerIdsSet);
      const currentHour = now.getHours();
      
      for (const workerId of workerIds) {
        for (let i = 0; i < 24; i++) {
          const targetHour = (currentHour - 23 + i + 24) % 24;
          const isToday = (currentHour - 23 + i) >= 0;
          const data = isToday ? todayData : yestData;
          
          const cpuSum = parseInt(data[`${workerId}:cpu_sum:${targetHour}`] ?? '0', 10);
          const cpuCount = parseInt(data[`${workerId}:cpu_count:${targetHour}`] ?? '0', 10);
          const memSum = parseInt(data[`${workerId}:mem_sum:${targetHour}`] ?? '0', 10);
          const memCount = parseInt(data[`${workerId}:mem_count:${targetHour}`] ?? '0', 10);
          const failures = parseInt(data[`${workerId}:failures:${targetHour}`] ?? '0', 10);
          
          const cpuAvg = cpuCount > 0 ? cpuSum / cpuCount : 0;
          
          list.push({
            workerId,
            hour: targetHour,
            utilization: Math.round(cpuAvg),
            failures
          });
        }
      }
      return json(res, list);
    }

    // ── GET /api/queues/dependencies ───────────────────────────────────────
    if (req.method === 'GET' && path === '/api/queues/dependencies') {
      const deps = await inferQueueDependencies();
      return json(res, deps);
    }

    // ── GET /api/incidents ────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/incidents') {
      const all    = await _incidents.getIncidentHistory(100);
      const firing = await _incidents.getFiringIncidents();
      return json(res, { firing, history: all });
    }

    // ── GET /api/incidents/:id/rca ────────────────────────────────────────
    const rcaMatch = path.match(/^\/api\/incidents\/([^/]+)\/rca$/);
    if (req.method === 'GET' && rcaMatch) {
      const all      = await _incidents.getIncidentHistory(200);
      const incident = all.find(i => i.id === rcaMatch[1]);
      if (!incident) { res.writeHead(404); return res.end(JSON.stringify({ error: 'not found' })); }
      return json(res, await _recommendations.generateRCA(incident));
    }

    // ── GET /api/recommendations ──────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/recommendations') {
      const firing = await _incidents.getFiringIncidents();
      return json(res, await _recommendations.generate(firing));
    }

    // ── GET /api/alerts/rules ─────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/alerts/rules') {
      const raw = await redis.hgetall('taurusmq:obs:alert_rules') ?? {};
      const rules = Object.values(raw).map(v => {
        try { return JSON.parse(v); } catch (_) { return null; }
      }).filter(Boolean);
      return json(res, rules);
    }

    // ── POST /api/alerts/rules ────────────────────────────────────────────
    if (req.method === 'POST' && path === '/api/alerts/rules') {
      let bodyData = {};
      try {
        const buffers = [];
        for await (const chunk of req) {
          buffers.push(chunk);
        }
        const data = Buffer.concat(buffers).toString();
        if (data) {
          bodyData = JSON.parse(data);
        }
      } catch (_) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }

      const { queue, metric, threshold, windowMs, webhook, severity, name } = bodyData;
      if (!queue || !metric || threshold === undefined) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Missing required fields: queue, metric, threshold' }));
      }

      const ruleId = bodyData.id || `rule_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      const rule = {
        id: ruleId,
        name: name || `${metric} alert on ${queue}`,
        queue,
        metric,
        threshold: parseFloat(threshold),
        windowMs: parseInt(windowMs || '60000', 10),
        webhook: webhook || '',
        severity: severity || 'critical',
      };

      await redis.hset('taurusmq:obs:alert_rules', ruleId, JSON.stringify(rule));
      return json(res, { ok: true, rule });
    }

    // ── DELETE /api/alerts/rules/:id ───────────────────────────────────────
    const ruleDeleteMatch = path.match(/^\/api\/alerts\/rules\/([^/]+)$/);
    if (req.method === 'DELETE' && ruleDeleteMatch) {
      const ruleId = decodeURIComponent(ruleDeleteMatch[1]);
      await redis.hdel('taurusmq:obs:alert_rules', ruleId);
      await redis.hdel('tmq:obs:alerts', ruleId);
      return json(res, { ok: true });
    }

    // ── GET /api/settings ─────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/settings') {
      const startMs = Date.now();
      let latencyStr = '0.5ms';
      let status = 'disconnected';
      try {
        await redis.ping();
        latencyStr = `${Date.now() - startMs}ms`;
        status = 'connected';
      } catch (err) {
        latencyStr = 'unknown';
      }
      
      const configStr = await redis.get('tmq:obs:settings:config');
      const config = configStr ? JSON.parse(configStr) : {
        retentionDays: '7',
        maxMemory: '512MB',
        alertEmail: 'admin@taurusmq.local'
      };

      return json(res, {
        host: redis.options.host || '127.0.0.1',
        port: redis.options.port || 6379,
        status,
        latency: latencyStr,
        ...config
      });
    }

    // ── POST /api/settings ────────────────────────────────────────────────
    if (req.method === 'POST' && path === '/api/settings') {
      let bodyData = {};
      try {
        const buffers = [];
        for await (const chunk of req) {
          buffers.push(chunk);
        }
        const data = Buffer.concat(buffers).toString();
        if (data) {
          bodyData = JSON.parse(data);
        }
      } catch (_) {}

      await redis.set('tmq:obs:settings:config', JSON.stringify({
        retentionDays: bodyData.retentionDays || '7',
        maxMemory: bodyData.maxMemory || '512MB',
        alertEmail: bodyData.alertEmail || 'admin@taurusmq.local'
      }));

      return json(res, { ok: true });
    }

    // ── GET /api/forecast ─────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/forecast') {
      const names = await discoverQueues();
      return json(res, await _forecasting.forecastAll(names));
    }

    // ── GET /api/queues/:name/analytics ──────────────────────────────────
    const analyticsMatch = path.match(/^\/api\/queues\/([^/]+)\/analytics$/);
    if (req.method === 'GET' && analyticsMatch) {
      const name = decodeURIComponent(analyticsMatch[1]);
      const range = url.searchParams.get('range') || '24h';
      
      if (range === '1h') {
        const rawHistory = await redis.lrange(`tmq:obs:metrics:${name}:history`, 0, -1) ?? [];
        const data = rawHistory.map(h => {
          try {
            const pt = JSON.parse(h);
            return {
              timestamp: new Date(pt.t).toISOString(),
              processed: pt.throughput || 0,
              failed: 0,
              avgLatencyMs: pt.latency || 0,
              avgWaitMs: 0
            };
          } catch (_) {
            return null;
          }
        }).filter(Boolean);
        return json(res, data);
      }
      
      const hoursCount = range === '7d' ? 168 : 24;
      const now = new Date();
      const buckets = [];
      for (let i = hoursCount - 1; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 60 * 60 * 1000);
        const yyyymmdd = d.toISOString().slice(0, 10);
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const hourKey = `taurusmq:obs:metrics:${name}:${yyyymmdd}:hour-${hh}`;
        buckets.push({
          timestamp: d.toISOString(),
          key: hourKey,
        });
      }

      const pipe = redis.pipeline();
      for (const b of buckets) {
        pipe.hgetall(b.key);
      }
      const results = await pipe.exec();

      const data = buckets.map((b, idx) => {
        const hash = results[idx][1] || {};
        const processed = parseInt(hash.processed ?? '0', 10);
        const failed = parseInt(hash.failed ?? '0', 10);
        const totalDuration = parseFloat(hash.total_duration ?? '0');
        const totalWait = parseFloat(hash.total_wait ?? '0');

        return {
          timestamp: b.timestamp,
          processed,
          failed,
          avgLatencyMs: processed + failed > 0 ? Number((totalDuration / (processed + failed)).toFixed(2)) : 0,
          avgWaitMs: processed + failed > 0 ? Number((totalWait / (processed + failed)).toFixed(2)) : 0,
        };
      });

      return json(res, data);
    }

    // ── GET /api/events ───────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/events') {
      const from   = parseInt(url.searchParams.get('from') ?? String(Date.now() - 3_600_000), 10);
      const to     = parseInt(url.searchParams.get('to')   ?? String(Date.now()), 10);
      const count  = parseInt(url.searchParams.get('count') ?? '200', 10);
      return json(res, await _eventWriter.readRange(from, to, count));
    }

    // ── GET /api/analytics ────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/analytics') {
      const range = url.searchParams.get('range') || '1h';
      const names = await discoverQueues();

      if (range === '1h') {
        const allHistories = [];
        for (const name of names) {
          const rawHistory = await redis.lrange(`tmq:obs:metrics:${name}:history`, 0, -1) ?? [];
          const history = rawHistory.map(h => {
            try { return JSON.parse(h); } catch { return null; }
          }).filter(Boolean);
          allHistories.push(history);
        }

        const timeBuckets = {};

        for (const history of allHistories) {
          for (const pt of history) {
            const ts = pt.t || Date.now();
            const bucketKey = Math.floor(ts / 10000) * 10000;
            
            if (!timeBuckets[bucketKey]) {
              timeBuckets[bucketKey] = {
                t: bucketKey,
                throughput: 0,
                waiting: 0,
                failed: 0,
                completed: 0,
                totalLatency: 0,
                latencyCount: 0,
                p50: 0,
                p95: 0,
                p99: 0,
                errorSum: 0,
                errorCount: 0,
                retrySum: 0,
                retryCount: 0
              };
            }
            
            const b = timeBuckets[bucketKey];
            b.throughput += pt.throughput || 0;
            b.waiting += pt.waiting || 0;
            b.failed += pt.failed || 0;
            b.completed += pt.completed || 0;
            
            if (pt.latency) {
              b.totalLatency += pt.latency;
              b.latencyCount++;
            }
          }
        }

        const sortedBuckets = Object.values(timeBuckets)
          .sort((a, b) => a.t - b.t)
          .map(b => {
            const avgLatency = b.latencyCount > 0 ? Number((b.totalLatency / b.latencyCount).toFixed(0)) : 0;
            const avgError = b.errorCount > 0 ? Number((b.errorSum / b.errorCount).toFixed(1)) : 0;
            const avgRetry = b.retryCount > 0 ? Number((b.retrySum / b.retryCount).toFixed(1)) : 0;
            
            return {
              t: b.t,
              throughput: Number(b.throughput.toFixed(1)),
              waiting: b.waiting,
              avgLatency,
              p50: b.p50 || avgLatency,
              p95: b.p95 || avgLatency,
              p99: b.p99 || avgLatency,
              errorRate: avgError,
              retryRate: avgRetry,
              successRate: Number((100 - avgError).toFixed(1))
            };
          });

        return json(res, sortedBuckets);
      } else {
        // range is '24h' or '7d' -> retrieve hourly rollup metrics for all queues
        const hoursCount = range === '7d' ? 168 : 24;
        const now = new Date();
        const buckets = [];
        for (let i = hoursCount - 1; i >= 0; i--) {
          const d = new Date(now.getTime() - i * 60 * 60 * 1000);
          const yyyymmdd = d.toISOString().slice(0, 10);
          const hh = String(d.getUTCHours()).padStart(2, '0');
          buckets.push({
            t: Math.floor(d.getTime() / 3600000) * 3600000,
            yyyymmdd,
            hh
          });
        }

        const timeBuckets = {};
        for (const b of buckets) {
          timeBuckets[b.t] = {
            t: b.t,
            throughput: 0,
            waiting: 0,
            failed: 0,
            completed: 0,
            totalLatency: 0,
            latencyCount: 0,
            p50: 0,
            p95: 0,
            p99: 0,
            errorSum: 0,
            errorCount: 0,
            retrySum: 0,
            retryCount: 0
          };
        }

        const pipe = redis.pipeline();
        const queryList = [];
        for (const name of names) {
          for (const b of buckets) {
            const key = `taurusmq:obs:metrics:${name}:${b.yyyymmdd}:hour-${b.hh}`;
            pipe.hgetall(key);
            queryList.push({ t: b.t });
          }
        }

        const results = await pipe.exec();
        results.forEach((res, idx) => {
          const t = queryList[idx].t;
          const hash = res[1] || {};
          const processed = parseInt(hash.processed ?? '0', 10);
          const failed = parseInt(hash.failed ?? '0', 10);
          const totalDuration = parseFloat(hash.total_duration ?? '0');
          const totalWait = parseFloat(hash.total_wait ?? '0');

          const b = timeBuckets[t];
          if (b) {
            b.throughput += (processed + failed) / 60; // jobs/min from hourly total
            b.waiting += processed;
            b.completed += processed;
            b.failed += failed;
            if (processed + failed > 0) {
              b.totalLatency += totalDuration / (processed + failed);
              b.latencyCount++;
            }
          }
        });

        const sortedBuckets = Object.values(timeBuckets)
          .sort((a, b) => a.t - b.t)
          .map(b => {
            const avgLatency = b.latencyCount > 0 ? Number((b.totalLatency / b.latencyCount).toFixed(0)) : 0;
            const totalJobs = b.completed + b.failed;
            const errorRate = totalJobs > 0 ? Number((b.failed / totalJobs * 100).toFixed(1)) : 0;

            return {
              t: b.t,
              throughput: Number(b.throughput.toFixed(1)),
              waiting: b.waiting,
              avgLatency,
              p50: avgLatency,
              p95: Math.round(avgLatency * 1.5),
              p99: Math.round(avgLatency * 2.2),
              errorRate,
              retryRate: 0,
              successRate: Number((100 - errorRate).toFixed(1))
            };
          });

        return json(res, sortedBuckets);
      }
    }

    // ── GET /api/flows ─────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/flows') {
      const names = await discoverQueues();
      const flowJobs = [];
      for (const name of names) {
        const raw = await redis.hgetall(`taurusmq:jobs:${name}`) || {};
        for (const [id, jobStr] of Object.entries(raw)) {
          try {
            const p = JSON.parse(jobStr);
            const hasParent = p.parent && p.parent.length > 0;
            if (hasParent || p.flow) {
              flowJobs.push({
                id: p.id,
                name: p.name || 'default',
                queueName: name,
                state: p.status === 'dead' ? 'failed' : p.status,
                timestamp: p.timestamp ?? Date.now(),
                childrenCount: p.parent ? p.parent.length : 0
              });
            }
          } catch (_) {}
        }
      }
      flowJobs.sort((a, b) => b.timestamp - a.timestamp);
      return json(res, flowJobs.slice(0, 50));
    }

    // ── GET /api/flows/:id ──────────────────────────────────────────────────
    const flowMatch = path.match(/^\/api\/flows\/([^/]+)$/);
    if (req.method === 'GET' && flowMatch) {
      const id = decodeURIComponent(flowMatch[1]);
      
      const names = await discoverQueues();
      let nodeJob = null;
      for (const name of names) {
        const rawJson = await redis.hget(`taurusmq:jobs:${name}`, id);
        if (rawJson) {
          try {
            const p = JSON.parse(rawJson);
            nodeJob = {
              id: p.id,
              name: p.name || 'default',
              queueName: name,
              state: p.status === 'dead' ? 'failed' : p.status,
              attempts: p.attempts ?? 0,
              maxAttempts: p.maxretries ?? 3,
              timestamp: p.timestamp ?? Date.now(),
              data: p.data || {},
              parent: p.parent || []
            };
            break;
          } catch (_) {}
        }
      }

      if (!nodeJob) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Job not found' }));
      }

      // Combine direct parent set + reverse job scan parent mappings
      const parentSet = await redis.smembers(`taurusmq:dependent:${id}:children:`) || [];
      const parentIds = [...parentSet];
      if (parentIds.length === 0) {
        for (const name of names) {
          const raw = await redis.hgetall(`taurusmq:jobs:${name}`) || {};
          for (const [pId, jobStr] of Object.entries(raw)) {
            try {
              const p = JSON.parse(jobStr);
              if (p.parent && p.parent.includes(id)) {
                parentIds.push(pId);
              }
            } catch (_) {}
          }
        }
      }
      const uniqueParentIds = Array.from(new Set(parentIds));

      // Combine direct child set + parent's static children definitions
      const childrenSet = await redis.smembers(`taurusmq:dependent:${id}:parent:`) || [];
      const childrenArr = nodeJob.parent || [];
      const uniqueChildrenIds = Array.from(new Set([...childrenSet, ...childrenArr]));

      const parents = [];
      for (const pId of uniqueParentIds) {
        let pJob = null;
        for (const name of names) {
          const raw = await redis.hget(`taurusmq:jobs:${name}`, pId);
          if (raw) {
            try {
              const p = JSON.parse(raw);
              pJob = {
                id: p.id,
                name: p.name || 'default',
                queueName: name,
                state: p.status === 'dead' ? 'failed' : p.status
              };
              break;
            } catch (_) {}
          }
        }
        parents.push(pJob || { id: pId, name: 'Parent Job', queueName: 'unknown', state: 'unknown' });
      }

      const children = [];
      for (const cId of uniqueChildrenIds) {
        let cJob = null;
        for (const name of names) {
          const raw = await redis.hget(`taurusmq:jobs:${name}`, cId);
          if (raw) {
            try {
              const p = JSON.parse(raw);
              cJob = {
                id: p.id,
                name: p.name || 'default',
                queueName: name,
                state: p.status === 'dead' ? 'failed' : p.status
              };
              break;
            } catch (_) {}
          }
        }
        children.push(cJob || { id: cId, name: 'Child Job', queueName: 'unknown', state: 'unknown' });
      }

      return json(res, {
        node: nodeJob,
        parents,
        children
      });
    }

    // ── POST /api/queues/:name/actions/pause-retries ──────────────────────
    const pauseMatch = path.match(/^\/api\/queues\/([^/]+)\/actions\/pause-retries$/);
    if (req.method === 'POST' && pauseMatch) {
      const name = decodeURIComponent(pauseMatch[1]);
      const Queue = require('../../src/core/queue');
      const q = new Queue(name);
      const isPaused = await q.isPaused();
      if (isPaused) {
        await q.resume();
        await redis.del(`tmq:obs:paused-retries:${name}`);
        return json(res, { ok: true, queue: name, action: 'resume-retries', isPaused: false });
      } else {
        await q.pause();
        await redis.set(`tmq:obs:paused-retries:${name}`, '1');
        return json(res, { ok: true, queue: name, action: 'pause-retries', isPaused: true });
      }
    }

    // ── GET /api/queues/:name/jobs ─────────────────────────────────────────
    const queueJobsMatch = path.match(/^\/api\/queues\/([^/]+)\/jobs$/);
    if (req.method === 'GET' && queueJobsMatch) {
      const name = decodeURIComponent(queueJobsMatch[1]);
      const [rawJobs, rawDlq] = await Promise.all([
        redis.hgetall(`taurusmq:jobs:${name}`).catch(() => ({})),
        redis.hgetall(`taurusmq:dlq:${name}`).catch(() => ({}))
      ]);

      const jobsMap = new Map();

      // Parse and add jobs from taurusmq:jobs:${name}
      if (rawJobs) {
        for (const [jobId, j] of Object.entries(rawJobs)) {
          try {
            const p = JSON.parse(j);
            jobsMap.set(jobId, {
              id: p.id,
              name: p.name || 'default',
              queueName: name,
              state: p.status === 'dead' ? 'failed' : p.status,
              attempts: p.attempts ?? 0,
              maxAttempts: p.maxretries ?? 3,
              timestamp: p.timestamp ?? Date.now(),
              failedReason: p.error || p.failedReason || '',
              opts: p.opts || {},
              data: p.data || {}
            });
          } catch (_) {}
        }
      }

      // Parse and add/merge jobs from taurusmq:dlq:${name}
      if (rawDlq) {
        for (const [jobId, j] of Object.entries(rawDlq)) {
          try {
            const p = JSON.parse(j);
            jobsMap.set(jobId, {
              id: p.id,
              name: p.name || 'default',
              queueName: name,
              state: 'failed',
              attempts: p.attempts ?? 0,
              maxAttempts: p.maxretries ?? 3,
              timestamp: p.timestamp ?? Date.now(),
              failedReason: p.error || p.failedReason || 'Failed (DLQ)',
              opts: p.opts || {},
              data: p.data || {}
            });
          } catch (_) {}
        }
      }

      const jobs = Array.from(jobsMap.values());
      return json(res, jobs);
    }

    // ── GET /api/jobs/:id ──────────────────────────────────────────────────
    const singleJobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && singleJobMatch) {
      const id = decodeURIComponent(singleJobMatch[1]);
      const names = await discoverQueues();
      for (const name of names) {
        const rawJson = await redis.hget(`taurusmq:jobs:${name}`, id);
        if (rawJson) {
          const p = JSON.parse(rawJson);
          const rawLogs = await redis.lrange(`taurusmq:logs:${name}:${id}`, 0, -1);
          const logs = (rawLogs || []).map(l => {
            try { return JSON.parse(l); } catch (_) { return { level: 'log', message: l, ts: Date.now() }; }
          });
          return json(res, {
            id: p.id,
            name: p.name || 'default',
            queueName: name,
            state: p.status === 'dead' ? 'failed' : p.status,
            attempts: p.attempts ?? 0,
            maxAttempts: p.maxretries ?? 3,
            timestamp: p.timestamp ?? Date.now(),
            failedReason: p.error || p.failedReason || '',
            opts: p.opts || { maxretries: p.maxretries, parent: p.parent, repeat: p.repeat, batchid: p.batchid },
            data: p.data || {},
            processedOn: p.processedOn || null,
            finishedOn: p.finishedOn || null,
            duration: p.duration || null,
            progress: p.progress ?? null,
            returnvalue: p.returnvalue ?? null,
            stacktrace: p.stacktrace || (p.stack ? p.stack.split('\n') : []),
            timeline: p.timeline || [],
            snapshot: p.snapshot || null,
            logs
          });
        }
      }
      res.writeHead(404);
      return res.end(JSON.stringify({ error: 'Job not found' }));
    }

    // ── POST /api/queues/:name/jobs/:id/replay ──────────────────────────────
    const replayJobMatch = path.match(/^\/api\/queues\/([^/]+)\/jobs\/([^/]+)\/replay$/);
    if (req.method === 'POST' && replayJobMatch) {
      const name = decodeURIComponent(replayJobMatch[1]);
      const jobId = decodeURIComponent(replayJobMatch[2]);
      
      let bodyData = null;
      try {
        const buffers = [];
        for await (const chunk of req) {
          buffers.push(chunk);
        }
        const data = Buffer.concat(buffers).toString();
        if (data) {
          const parsed = JSON.parse(data);
          bodyData = parsed.data;
        }
      } catch (_) {}

      const jobjson = await redis.hget(`taurusmq:jobs:${name}`, jobId);
      if (!jobjson) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Original job not found' }));
      }
      
      const originalJob = JSON.parse(jobjson);
      const payload = (bodyData !== null && bodyData !== undefined) ? bodyData : originalJob.data;
      
      const Queue = require('../../src/core/queue');
      const q = new Queue(name);
      
      const newJobId = await q.add(originalJob.name, payload, {
        maxretries: originalJob.maxretries,
        parent: originalJob.parent,
        batchid: originalJob.batchid
      });
      
      return json(res, { ok: true, newJobId });
    }

    // ── GET /api/jobs ──────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/jobs') {
      const names = await discoverQueues();
      const allJobs = [];
      for (const name of names) {
        const [rawJobs, rawDlq] = await Promise.all([
          redis.hgetall(`taurusmq:jobs:${name}`).catch(() => ({})),
          redis.hgetall(`taurusmq:dlq:${name}`).catch(() => ({}))
        ]);

        const jobsMap = new Map();

        if (rawJobs) {
          for (const [jobId, j] of Object.entries(rawJobs)) {
            try {
              const p = JSON.parse(j);
              jobsMap.set(jobId, {
                id: p.id,
                name: p.name || 'default',
                queueName: name,
                state: p.status === 'dead' ? 'failed' : p.status,
                attempts: p.attempts ?? 0,
                maxAttempts: p.maxretries ?? 3,
                timestamp: p.timestamp ?? Date.now(),
                failedReason: p.error || p.failedReason || '',
                opts: p.opts || {},
                data: p.data || {}
              });
            } catch (_) {}
          }
        }

        if (rawDlq) {
          for (const [jobId, j] of Object.entries(rawDlq)) {
            try {
              const p = JSON.parse(j);
              jobsMap.set(jobId, {
                id: p.id,
                name: p.name || 'default',
                queueName: name,
                state: 'failed',
                attempts: p.attempts ?? 0,
                maxAttempts: p.maxretries ?? 3,
                timestamp: p.timestamp ?? Date.now(),
                failedReason: p.error || p.failedReason || 'Failed (DLQ)',
                opts: p.opts || {},
                data: p.data || {}
              });
            } catch (_) {}
          }
        }

        allJobs.push(...jobsMap.values());
      }
      return json(res, allJobs);
    }

    // ── POST /api/queues/:name/jobs/:id/retry ──────────────────────────────
    const retryJobMatch = path.match(/^\/api\/queues\/([^/]+)\/jobs\/([^/]+)\/retry$/);
    if (req.method === 'POST' && retryJobMatch) {
      const name = decodeURIComponent(retryJobMatch[1]);
      const jobId = decodeURIComponent(retryJobMatch[2]);
      let jobjson = await redis.hget(`taurusmq:dlq:${name}`, jobId);
      if (!jobjson) {
        jobjson = await redis.hget(`taurusmq:jobs:${name}`, jobId);
      }
      if (!jobjson) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Job not found in dead letter queue or jobs list' }));
      }
      const job = JSON.parse(jobjson);
      job.status = "waiting";
      job.attempts = 0;
      await redis.retry(
        `taurusmq:dlq:${name}`, 
        `taurusmq:${name}`, 
        `taurusmq:signal:${name}`, 
        `taurusmq:jobs:${name}`, 
        `taurusmq:prioritized:${name}`,
        JSON.stringify(job), 
        jobId
      );
      return json(res, { ok: true });
    }

    // ── POST /api/queues/:name/actions/retry-failed ────────────────────────
    const retryAllMatch = path.match(/^\/api\/queues\/([^/]+)\/actions\/retry-failed$/);
    if (req.method === 'POST' && retryAllMatch) {
      const name = decodeURIComponent(retryAllMatch[1]);
      const dlq = await redis.hgetall(`taurusmq:dlq:${name}`) ?? {};
      const dlqJobIds = Object.keys(dlq);
      
      const mainJobs = await redis.hgetall(`taurusmq:jobs:${name}`) ?? {};
      const failedJobIds = [];
      for (const [jobId, jobStr] of Object.entries(mainJobs)) {
        try {
          const p = JSON.parse(jobStr);
          if (p.status === 'dead' || p.status === 'failed') {
            if (!dlq[jobId]) {
              failedJobIds.push(jobId);
              dlq[jobId] = jobStr;
            }
          }
        } catch (_) {}
      }

      const allJobIds = [...dlqJobIds, ...failedJobIds];

      for (const jobId of allJobIds) {
        const jobjson = dlq[jobId];
        if (jobjson) {
          const job = JSON.parse(jobjson);
          job.status = "waiting";
          job.attempts = 0;
          await redis.retry(
            `taurusmq:dlq:${name}`, 
            `taurusmq:${name}`, 
            `taurusmq:signal:${name}`, 
            `taurusmq:jobs:${name}`, 
            `taurusmq:prioritized:${name}`,
            JSON.stringify(job), 
            jobId
          );
        }
      }
      return json(res, { ok: true, retriedCount: allJobIds.length });
    }

    // ── POST /api/queues/:name/actions/clean ───────────────────────────────
    const cleanMatch = path.match(/^\/api\/queues\/([^/]+)\/actions\/clean$/);
    if (req.method === 'POST' && cleanMatch) {
      const name = decodeURIComponent(cleanMatch[1]);
      const Queue = require('../../src/core/queue');
      const q = new Queue(name);
      await q.obliterate();
      await redis.del(`tmq:obs:paused-retries:${name}`);
      return json(res, { ok: true });
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));

  } catch (err) {
    console.error('[api] Error:', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

// ── WebSocket server ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
const _subscribers = new Set();

wss.on('connection', (ws, req) => {
  // Validate JWT cookie on WebSocket upgrade too
  if (_auth) {
    const mock = { headers: { cookie: req.headers.cookie ?? '' } };
    const user = _auth.requireAuth(mock, { writeHead: () => {}, end: () => {} });
    if (!user) { ws.close(4001, 'Unauthorized'); return; }
  }

  _subscribers.add(ws);
  console.log('[ws] Client connected, total:', _subscribers.size);
  ws.on('close', () => { _subscribers.delete(ws); });
  _pushSnapshot(ws);
});

function _broadcast(message) {
  const payload = JSON.stringify(message);
  for (const ws of _subscribers) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

async function _pushSnapshot(ws) {
  try {
    const names   = await discoverQueues();
    const metrics = await Promise.all(names.map(readQueueMetrics));
    const firing  = await _incidents.getFiringIncidents();
    const workers = await readAllWorkers();
    ws.send(JSON.stringify({ type: 'snapshot', metrics, incidents: firing, workers }));
  } catch (err) {
    console.error('[ws] Snapshot error:', err.message);
  }
}

// ── Redis Pub/Sub bridge ───────────────────────────────────────────────────────
function setupPubSubBridge() {
  const pubClient = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  const subClient = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

  const PUSH_EVENTS = new Set([
    'job.completed', 'job.failed', 'worker.heartbeat',
    'alert.fired', 'alert.resolved', 'worker.stalled',
  ]);

  bus.on('*', (event) => {
    if (PUSH_EVENTS.has(event.type)) {
      pubClient.publish(PUBSUB_CH, JSON.stringify(event)).catch(() => {});
    }
  });

  subClient.subscribe(PUBSUB_CH, (err) => {
    if (err) console.error('[ws] PubSub subscribe error:', err.message);
  });

  subClient.on('message', (_ch, msg) => {
    try { _broadcast({ type: 'event', event: JSON.parse(msg) }); } catch {}
  });

  return { pubClient, subClient };
}

// ── Helpers ────────────────────────────────────────────────────────────────────
async function discoverQueues() {
  const [obsKeys, jobsKeys] = await Promise.all([
    redis.keys('tmq:obs:materialized:*'),
    redis.keys('*:jobs:*')
  ]);
  const set = new Set([
    ...(obsKeys ?? []).map(k => k.replace('tmq:obs:materialized:', '')),
    ...(jobsKeys ?? []).map(k => k.split(':jobs:')[1])
  ]);
  return Array.from(set);
}

async function readQueueMetrics(name) {
  const pipe = redis.pipeline();
  pipe.hgetall(`tmq:obs:materialized:${name}`);
  pipe.get(`tmq:obs:paused-retries:${name}`);
  const results = await pipe.exec();
  
  const m = results[0][1] ?? {};
  const pausedVal = results[1][1];
  const f = (k, d = '0') => m[k] ?? d;
  return {
    name,
    waiting:        parseInt(f('waiting'),       10),
    active:         parseInt(f('active'),        10),
    delayed:        parseInt(f('delayed'),       10),
    failed:         parseInt(f('failed'),        10),
    completed:      parseInt(f('completed'),     10),
    throughput:     parseFloat(f('throughput')),
    enqueueRate:    parseFloat(f('enqueueRate')),
    completionRate: parseFloat(f('completionRate')),
    errorRate:      parseFloat(f('errorRate')),
    retryRate:      parseFloat(f('retryRate')),
    avgLatencyMs:   parseInt(f('avgLatencyMs'),  10),
    p50LatencyMs:   parseInt(f('p50LatencyMs'),  10),
    p95LatencyMs:   parseInt(f('p95LatencyMs'),  10),
    p99LatencyMs:   parseInt(f('p99LatencyMs'),  10),
    netGrowthRate:  parseFloat(f('netGrowthRate')),
    healthScore:    parseInt(f('healthScore'),   10),
    updatedAt:      parseInt(f('updatedAt'),     10),
    isPaused:       pausedVal === '1',
  };
}

async function inferQueueDependencies() {
  try {
    const queues = await discoverQueues();
    const deps = [];
    const jobToQueue = new Map();
    const allJobs = [];

    for (const queue of queues) {
      const raw = await redis.hgetall(`taurusmq:jobs:${queue}`) ?? {};
      for (const [jobId, jobStr] of Object.entries(raw)) {
        jobToQueue.set(jobId, queue);
        try {
          const job = JSON.parse(jobStr);
          allJobs.push({ id: jobId, queue, parent: job.parent || [] });
        } catch (_) {}
      }
    }

    const pairSet = new Set();
    for (const job of allJobs) {
      for (const parentId of job.parent) {
        const parentQueue = jobToQueue.get(parentId);
        if (parentQueue && parentQueue !== job.queue) {
          const pairKey = `${parentQueue}:${job.queue}`;
          if (!pairSet.has(pairKey)) {
            pairSet.add(pairKey);
            deps.push({
              from: parentQueue,
              to: job.queue,
              label: 'flow-dep',
              isCritical: false
            });
          }
        }
      }
    }

    // Fallback default topology for out-of-the-box demo visualization
    if (deps.length === 0 && queues.length > 0) {
      if (queues.includes('image-processing') && queues.includes('pdf-export')) {
        deps.push({ from: 'image-processing', to: 'pdf-export', label: 'flow-dep', isCritical: true });
      }
    }

    return deps;
  } catch (err) {
    console.error('[api] Failed to infer queue dependencies:', err.message);
    return [];
  }
}

async function readAllWorkers() {
  const keys = await redis.keys('tmq:obs:worker:*:state');
  if (!keys || keys.length === 0) return [];

  const pipe = redis.pipeline();
  for (const key of keys) {
    const workerId = key.split(':')[3];
    pipe.hgetall(key);
    pipe.hgetall(`tmq:obs:worker:${workerId}:res`);
    pipe.get(`tmq:obs:worker:${workerId}:hb`);
  }

  const results = await pipe.exec();
  const workers = [];

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const workerId = key.split(':')[3];
    
    const state = results[i * 3][1] || {};
    const res   = results[i * 3 + 1][1] || {};
    const hbRaw = results[i * 3 + 2][1];

    workers.push({
      id:            workerId,
      queue:         state.queue             ?? '',
      host:          state.host              ?? '',
      pid:           parseInt(state.pid      ?? '0', 10),
      concurrency:   parseInt(state.concurrency ?? '1', 10),
      state:         state.state             ?? 'unknown',
      startedAt:     parseInt(state.startedAt   ?? '0', 10),
      lastHeartbeat: parseInt(hbRaw             ?? '0', 10),
      activeJobs:    JSON.parse(state.activeJobs ?? '[]'),
      memoryBytes:   parseInt(res.memoryBytes    ?? '0', 10),
      heapUsed:      parseInt(res.heapUsed       ?? '0', 10),
      heapTotal:     parseInt(res.heapTotal      ?? '0', 10),
      cpuPercent:    parseFloat(res.cpuPercent   ?? '0'),
      processedJobs: parseInt(state.processed    ?? '0', 10),
      failedJobs:    parseInt(state.failed       ?? '0', 10),
    });
  }
  return workers;
}

function json(res, data) {
  res.writeHead(200);
  res.end(JSON.stringify(data));
}

// ── Engine instances ───────────────────────────────────────────────────────────
let _incidents;
let _recommendations;
let _forecasting;
let _eventWriter;

/**
 * @param {string[]} queueNames
 * @param {import('../observability-core/SetupManager').SetupManager} setup
 * @param {string} jwtSecret
 * @param {number} port
 */
async function startObservabilityStack(queueNames = [], setup, jwtSecret, port = 4000) {
  // Wire auth
  _auth = createAuth(setup, jwtSecret, ALLOWED_ORIGINS);

  // Wire engines
  const collector  = new MetricsCollector(bus);
  const aggregator = new MetricsAggregator(queueNames);
  _incidents       = new IncidentEngine(queueNames, bus);
  _recommendations = new RecommendationEngine();
  _forecasting     = new ForecastingEngine();
  _eventWriter     = new EventStreamWriter();

  collector.start();
  aggregator.start();
  _incidents.start();
  _eventWriter.start();

  setupPubSubBridge();

  // Worker heatmap telemetry collection
  bus.on('worker.memory', async (event) => {
    try {
      const { workerId, memoryBytes } = event;
      if (!workerId) return;
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const hour = now.getHours();
      const heatmapKey = `tmq:obs:workers:heatmap:${dateStr}`;
      
      const memMb = Math.round((memoryBytes || 0) / 1024 / 1024);
      await redis.pipeline()
        .hincrby(heatmapKey, `${workerId}:mem_sum:${hour}`, memMb)
        .hincrby(heatmapKey, `${workerId}:mem_count:${hour}`, 1)
        .expire(heatmapKey, 172800)
        .exec();
    } catch (_) {}
  });

  bus.on('worker.cpu', async (event) => {
    try {
      const { workerId, cpuPercent } = event;
      if (!workerId) return;
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const hour = now.getHours();
      const heatmapKey = `tmq:obs:workers:heatmap:${dateStr}`;

      await redis.pipeline()
        .hincrby(heatmapKey, `${workerId}:cpu_sum:${hour}`, Math.round(cpuPercent || 0))
        .hincrby(heatmapKey, `${workerId}:cpu_count:${hour}`, 1)
        .expire(heatmapKey, 172800)
        .exec();
    } catch (_) {}
  });

  bus.on('job.failed', async (event) => {
    try {
      const { workerId } = event;
      if (!workerId) return;
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const hour = now.getHours();
      const heatmapKey = `tmq:obs:workers:heatmap:${dateStr}`;

      await redis.pipeline()
        .hincrby(heatmapKey, `${workerId}:failures:${hour}`, 1)
        .expire(heatmapKey, 172800)
        .exec();
    } catch (_) {}
  });

  server.listen(port, () => {
    console.log(`[api] TaurusMQ Dashboard API → http://localhost:${port}`);
    console.log(`[api] Login at               → POST http://localhost:${port}/api/auth/login`);
  });

  // Auto-discover queues from events
  bus.on('*', (event) => {
    if (event.queueName) {
      aggregator.addQueue(event.queueName);
      _incidents.addQueue(event.queueName);
    }
  });

  return { collector, aggregator };
}

module.exports = { startObservabilityStack, server };
