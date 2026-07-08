# TaurusMQ Management Dashboard Documentation

This document describes the architecture, layout pages, and API endpoints of the TaurusMQ Dashboard & Gateway API (`packages/dashboard-api/` and `dashboard/`).

---

## Architecture

The dashboard is split into two independent modules:
1. **Next.js Web UI Client (`dashboard/`)**: A Single Page Application (SPA) built using Next.js (App Router), styled with TailwindCSS, and displaying live system metrics.
2. **Dashboard REST API Gateway (`packages/dashboard-api/`)**: A lightweight Node.js HTTP/WebSocket server that interfaces directly with Redis. It acts as an API gateway for telemetry counters, alerts, and operational controls.

### Telemetry Subscription Flow
* The gateway listens to the Redis Pub/Sub channel `tmq:obs:push`.
* Live queue events (metrics ticks, active incidents, worker registrations) are broadcast to the browser client using Server-Sent Events (SSE) via the `/api/stream` endpoint.
* This ensures that charts, logs, and counters auto-refresh in real time without polling.

---

## Authentication & Security

* **JWT Cookies**: Authentication is managed using HTTP-Only cookies (`tmq_token`) signed with a JWT secret key. This prevents access to session tokens via client-side scripts.
* **CSRF Protection**: All state-mutating requests (`POST`, `PUT`, `DELETE`) require a custom header `x-taurusmq-csrf` or `x-requested-with: XMLHttpRequest` to protect against cross-site request forgery attacks.
* **Origins Verification**: Mutations verify that the HTTP `Origin` header matches allowed origins configured at gateway startup.
* **Bcrypt Credentials**: Plaintext passwords are comparison-checked against hashed keys stored in the SetupManager.

---

## Dashboard Pages Guide

### 1. Login Page (`/login`)
User authentication gate. Sets the `tmq_token` cookie on success.

### 2. Queues Overview Page (`/queues`)
The primary system health board. Displays:
* Materialized health scores (calculated via `MetricsAggregator`).
* Live throughput speeds (jobs/minute).
* Counters for wait, active, delayed, completed, and failed jobs.
* Bulk operations: Pause, Resume, and Drain buttons.

### 3. Queue Details & Jobs Page (`/jobs`)
A list view of jobs within a specific queue, with state-based filter tabs:
* **Wait**: Jobs queued for processing.
* **Active**: Jobs currently locked by a worker. Shows elapsed processing duration.
* **Completed**: Successfully finished jobs.
* **Failed**: Jobs that threw handler errors. Shows stack trace and retry controls.
* **Delayed**: Delayed or repeatable cron schedules. Shows scheduled timestamps.
* **Dead (DLQ)**: Jobs that exhausted retries or stalled. Shows failed reasons.
* **Operations**: Details drawer, structured console log list, and job removal.

### 4. Workers Page (`/workers`)
A inventory board of active worker processes:
* Displays hostname, process ID (PID), and concurrency slots.
* Dynamic CPU load and Memory usage percentages (RSS vs Heap).
* List of job IDs currently locked and executing on each worker.

### 5. Alerts & Incidents Page (`/alerts`)
Proactive telemetry monitoring:
* Displays firing incidents flagged by the `IncidentEngine` (e.g. latency SLA breaches, stuck queues, memory pressure).
* Step-by-step diagnostic recommendation playbooks with COPY-paste CLI solutions.
* Custom alert rule manager (define custom metric thresholds and Slack/Discord webhook hooks).

### 6. Analytics Page (`/analytics`)
Historical trends:
* Interactive latency charts (P50, P95, P99).
* Historical backlog depth growth trends.
* Error rate percentage breakdown.

### 7. Event Stream Page (`/stream`)
Real-time JSON event feed:
* Raw stream of structured telemetry events (e.g. `job.created`, `worker.heartbeat`, `flow.completed`) as they are written to the Redis stream.

---

## REST API Reference

All routes require a valid `tmq_token` cookie unless marked otherwise.

### Authentication Endpoints

#### 1. `POST /api/auth/login` (Public)
* **Purpose**: Authenticates credentials and sets session cookie.
* **Request Body**:
  ```json
  {
    "username": "admin",
    "password": "yourpassword"
  }
  ```
* **Response (200 OK)**:
  ```json
  {
    "ok": true,
    "username": "admin",
    "project": "local"
  }
  ```

#### 2. `GET /api/auth/me` (Public)
* **Purpose**: Decodes cookie to verify session status.
* **Response (200 OK - Authenticated)**:
  ```json
  {
    "authenticated": true,
    "username": "admin",
    "project": "local"
  }
  ```
* **Response (200 OK - Unauthenticated)**:
  ```json
  {
    "authenticated": false
  }
  ```

---

### Queue Operations Endpoints

#### 3. `GET /api/queues`
* **Purpose**: Fetches metrics and health status for all registered queues.
* **Response (200 OK)**:
  ```json
  [
    {
      "name": "emails",
      "healthScore": 98,
      "waiting": 5,
      "active": 2,
      "completed": 1204,
      "failed": 12,
      "throughput": 45.2,
      "errorRate": 0.0098,
      "avgLatencyMs": 345,
      "p99LatencyMs": 1200
    }
  ]
  ```

#### 4. `POST /api/queues/:queue/pause`
* **Purpose**: Pauses job dequeue operations for a queue.
* **Response (200 OK)**:
  ```json
  { "success": true }
  ```

#### 5. `POST /api/queues/:queue/resume`
* **Purpose**: Resumes job dequeue operations for a paused queue.
* **Response (200 OK)**:
  ```json
  { "success": true }
  ```

#### 6. `POST /api/queues/:queue/drain`
* **Purpose**: Purges all lists and deletes job keys from Redis.
* **Response (200 OK)**:
  ```json
  { "success": true }
  ```

---

### Jobs Management Endpoints

#### 7. `GET /api/queues/:queue/jobs`
* **Purpose**: Returns paginated jobs matching filters.
* **Query Parameters**:
  * `state`: string (e.g. `waiting`, `active`, `completed`, `failed`, `delayed`, `dlq`)
  * `start`: number (Default: 0)
  * `limit`: number (Default: 50)
  * `asc`: boolean (Default: false)
* **Response (200 OK)**:
  ```json
  {
    "jobs": [
      {
        "id": "job_01h8x9",
        "name": "sendWelcomeEmail",
        "status": "waiting",
        "attempts": 0,
        "maxretries": 3,
        "timestamp": 1693526400000
      }
    ],
    "total": 1
  }
  ```

#### 8. `GET /api/queues/:queue/jobs/:id`
* **Purpose**: Fetches details for a single job.
* **Response (200 OK)**:
  ```json
  {
    "id": "job_01h8x9",
    "name": "sendWelcomeEmail",
    "data": { "to": "user@example.com" },
    "status": "completed",
    "attempts": 1,
    "timestamp": 1693526400000,
    "processedOn": 1693526405000,
    "finishedOn": 1693526406200,
    "returnvalue": { "sent": true }
  }
  ```

#### 9. `GET /api/queues/:queue/jobs/:id/logs`
* **Purpose**: Fetches stdout/console logs for a job.
* **Response (200 OK)**:
  ```json
  [
    { "level": "log", "message": "SMTP connection established", "ts": 1693526405100 },
    { "level": "log", "message": "Email sent successfully", "ts": 1693526406100 }
  ]
  ```

#### 10. `POST /api/queues/:queue/jobs/:id/retry`
* **Purpose**: Retries a failed or dead job.
* **Response (200 OK)**:
  ```json
  { "success": true }
  ```

#### 11. `POST /api/queues/:queue/jobs/:id/remove`
* **Purpose**: Deletes a job from the queue and job vault.
* **Response (200 OK)**:
  ```json
  { "success": true }
  ```

---

### Observability & Alert Endpoints

#### 12. `GET /api/workers`
* **Purpose**: Returns active worker processes, CPU load, and memory usage.
* **Response (200 OK)**:
  ```json
  [
    {
      "workerId": "wkr_emails_14022",
      "host": "prod-worker-01",
      "pid": 14022,
      "state": "online",
      "concurrency": 10,
      "cpuPercent": 14.5,
      "memoryBytes": 124500000,
      "activeJobs": ["job_01h8x9"]
    }
  ]
  ```

#### 13. `GET /api/incidents`
* **Purpose**: Returns currently firing alerts.
* **Response (200 OK)**:
  ```json
  [
    {
      "id": "inc_01h9y1",
      "ruleId": "high_failure_rate",
      "ruleName": "HighFailureRate",
      "severity": "critical",
      "scopeTarget": "emails",
      "state": "firing",
      "firedAt": 1693526500000,
      "evidence": ["Error rate 14.5% exceeds 10% threshold"]
    }
  ]
  ```

#### 14. `GET /api/recommendations`
* **Purpose**: Returns ranked playbooks for firing alerts.
* **Response (200 OK)**:
  ```json
  [
    {
      "id": "inc_01h9y1:high_failure_rate:1",
      "priority": 1,
      "urgency": "immediate",
      "type": "pause",
      "title": "Pause retries to stop failure amplification",
      "why": "14.5% failure rate detected on emails.",
      "how": "taurusmq queue pause-retries emails --state failed",
      "estimatedImpact": "Stops retry storm. Stabilises worker load."
    }
  ]
  ```

#### 15. `GET /api/recommendations/rca/:incidentId`
* **Purpose**: Returns root cause analysis hypotheses for an incident.
* **Response (200 OK)**:
  ```json
  [
    {
      "rank": 1,
      "hypothesis": "Common error: Connection Timeout",
      "confidence": 85,
      "evidence": ["Top error: SMTP Timeout (12 occurrences)"],
      "immediateAction": "Verify SMTP relay endpoint",
      "preventionAction": "Implement circuit breaker on SMTP calls"
    }
  ]
  ```

#### 16. `GET /api/forecasting`
* **Purpose**: Returns queue horizon projections.
* **Response (200 OK)**:
  ```json
  [
    {
      "queueName": "emails",
      "currentDepth": 120,
      "enqueueRate": 450.0,
      "completionRate": 300.0,
      "netGrowthRate": 150.0,
      "projectedDepth1h": 9120,
      "timeToOverflowMs": 1920000,
      "workersNeeded": 2,
      "recommendation": "Queue growing. Add 2 workers immediately."
    }
  ]
  ```

#### 17. `GET /api/stream` (SSE Gateway)
* **Purpose**: Server-Sent Events gateway for real-time dashboard updates.
* **Header Required**: `Accept: text/event-stream`
* **Example Event Payload**:
  ```
  event: metrics
  data: {"queue":"emails","waiting":5,"active":2,"completed":1204,"failed":12}
  ```
