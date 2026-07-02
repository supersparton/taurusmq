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
const { CostAnalyticsEngine }  = require('../metrics-engine/CostAnalyticsEngine');
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

  // CORS — allow only configured origins (never wildcard on auth-protected server)
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

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
      return json(res, { ...metrics, forecast });
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

    // ── GET /api/forecast ─────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/forecast') {
      const names = await discoverQueues();
      return json(res, await _forecasting.forecastAll(names));
    }

    // ── GET /api/cost ─────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/cost') {
      const names = await discoverQueues();
      return json(res, await Promise.all(names.map(n => _cost.getCostSummary(n))));
    }

    // ── GET /api/events ───────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/events') {
      const from   = parseInt(url.searchParams.get('from') ?? String(Date.now() - 3_600_000), 10);
      const to     = parseInt(url.searchParams.get('to')   ?? String(Date.now()), 10);
      const count  = parseInt(url.searchParams.get('count') ?? '200', 10);
      return json(res, await _eventWriter.readRange(from, to, count));
    }

    // ── POST /api/queues/:name/actions/pause-retries ──────────────────────
    const pauseMatch = path.match(/^\/api\/queues\/([^/]+)\/actions\/pause-retries$/);
    if (req.method === 'POST' && pauseMatch) {
      const name = decodeURIComponent(pauseMatch[1]);
      const current = await redis.get(`tmq:obs:paused-retries:${name}`);
      if (current === '1') {
        await redis.del(`tmq:obs:paused-retries:${name}`);
        await redis.del(`taurusmq:paused:${name}`);
        return json(res, { ok: true, queue: name, action: 'resume-retries', isPaused: false });
      } else {
        await redis.set(`tmq:obs:paused-retries:${name}`, '1');
        await redis.set(`taurusmq:paused:${name}`, '1');
        return json(res, { ok: true, queue: name, action: 'pause-retries', isPaused: true });
      }
    }

    // ── GET /api/queues/:name/jobs ─────────────────────────────────────────
    const queueJobsMatch = path.match(/^\/api\/queues\/([^/]+)\/jobs$/);
    if (req.method === 'GET' && queueJobsMatch) {
      const name = decodeURIComponent(queueJobsMatch[1]);
      const raw = await redis.hgetall(`taurusmq:jobs:${name}`) ?? {};
      const jobs = Object.values(raw).map(j => {
        try {
          const p = JSON.parse(j);
          return {
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
          };
        } catch {
          return null;
        }
      }).filter(Boolean);
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
          return json(res, {
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
        }
      }
      res.writeHead(404);
      return res.end(JSON.stringify({ error: 'Job not found' }));
    }

    // ── GET /api/jobs ──────────────────────────────────────────────────────
    if (req.method === 'GET' && path === '/api/jobs') {
      const names = await discoverQueues();
      const allJobs = [];
      for (const name of names) {
        const raw = await redis.hgetall(`taurusmq:jobs:${name}`) ?? {};
        const jobs = Object.values(raw).map(j => {
          try {
            const p = JSON.parse(j);
            return {
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
            };
          } catch {
            return null;
          }
        }).filter(Boolean);
        allJobs.push(...jobs);
      }
      return json(res, allJobs);
    }

    // ── POST /api/queues/:name/jobs/:id/retry ──────────────────────────────
    const retryJobMatch = path.match(/^\/api\/queues\/([^/]+)\/jobs\/([^/]+)\/retry$/);
    if (req.method === 'POST' && retryJobMatch) {
      const name = decodeURIComponent(retryJobMatch[1]);
      const jobId = decodeURIComponent(retryJobMatch[2]);
      const jobjson = await redis.hget(`taurusmq:dlq:${name}`, jobId);
      if (!jobjson) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Job not found in dead letter queue' }));
      }
      const job = JSON.parse(jobjson);
      job.status = "waiting";
      job.attempts = 0;
      await redis.retry(`taurusmq:dlq:${name}`, `taurusmq:${name}`, `taurusmq:signal:${name}`, `taurusmq:jobs:${name}`, JSON.stringify(job), jobId);
      return json(res, { ok: true });
    }

    // ── POST /api/queues/:name/actions/retry-failed ────────────────────────
    const retryAllMatch = path.match(/^\/api\/queues\/([^/]+)\/actions\/retry-failed$/);
    if (req.method === 'POST' && retryAllMatch) {
      const name = decodeURIComponent(retryAllMatch[1]);
      const dlq = await redis.hgetall(`taurusmq:dlq:${name}`) ?? {};
      const jobIds = Object.keys(dlq);
      for (const jobId of jobIds) {
        const jobjson = dlq[jobId];
        if (jobjson) {
          const job = JSON.parse(jobjson);
          job.status = "waiting";
          job.attempts = 0;
          await redis.retry(`taurusmq:dlq:${name}`, `taurusmq:${name}`, `taurusmq:signal:${name}`, `taurusmq:jobs:${name}`, JSON.stringify(job), jobId);
        }
      }
      return json(res, { ok: true, retriedCount: jobIds.length });
    }

    // ── POST /api/queues/:name/actions/clean ───────────────────────────────
    const cleanMatch = path.match(/^\/api\/queues\/([^/]+)\/actions\/clean$/);
    if (req.method === 'POST' && cleanMatch) {
      const name = decodeURIComponent(cleanMatch[1]);
      await redis.del(`taurusmq:${name}`);
      await redis.del(`taurusmq:signal:${name}`);
      await redis.del(`taurusmq:delayed:${name}`);
      await redis.del(`taurusmq:active:${name}`);
      await redis.del(`taurusmq:dlq:${name}`);
      await redis.del(`taurusmq:blocked:${name}`);
      await redis.del(`taurusmq:jobs:${name}`);
      await redis.del(`taurusmq:paused:${name}`);
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
    redis.keys('taurusmq:jobs:*')
  ]);
  const set = new Set([
    ...(obsKeys ?? []).map(k => k.replace('tmq:obs:materialized:', '')),
    ...(jobsKeys ?? []).map(k => k.replace('taurusmq:jobs:', ''))
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
let _cost;
let _eventWriter;

/**
 * @param {string[]} queueNames
 * @param {import('../observability-core/SetupManager').SetupManager} setup
 * @param {string} jwtSecret
 * @param {number} port
 */
async function startObservabilityStack(queueNames = [], setup, jwtSecret, port = 4000) {
  // Wire auth
  _auth = createAuth(setup, jwtSecret);

  // Wire engines
  const collector  = new MetricsCollector(bus);
  const aggregator = new MetricsAggregator(queueNames);
  _incidents       = new IncidentEngine(queueNames, bus);
  _recommendations = new RecommendationEngine();
  _forecasting     = new ForecastingEngine();
  _cost            = new CostAnalyticsEngine();
  _eventWriter     = new EventStreamWriter();

  collector.start();
  aggregator.start();
  _incidents.start();
  _cost.start();
  _eventWriter.start();

  setupPubSubBridge();

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
