// packages/observability-core/types.js
// Complete observability event type system for TaurusMQ
// Every runtime action maps to one of these typed events.

'use strict';

/**
 * All event types emitted by the TaurusMQ runtime.
 * These are the only valid values for ObsEvent.type.
 */
const EventType = Object.freeze({
  // Queue lifecycle
  QUEUE_CREATED:  'queue.created',
  QUEUE_PAUSED:   'queue.paused',
  QUEUE_RESUMED:  'queue.resumed',
  QUEUE_CLEANED:  'queue.cleaned',

  // Job lifecycle
  JOB_CREATED:    'job.created',
  JOB_WAITING:    'job.waiting',
  JOB_ACTIVE:     'job.active',
  JOB_COMPLETED:  'job.completed',
  JOB_FAILED:     'job.failed',
  JOB_RETRY:      'job.retry',
  JOB_DELAYED:    'job.delayed',
  JOB_REMOVED:    'job.removed',
  JOB_PROMOTED:   'job.promoted',

  // Worker lifecycle
  WORKER_STARTED:    'worker.started',
  WORKER_STOPPED:    'worker.stopped',
  WORKER_STALLED:    'worker.stalled',
  WORKER_HEARTBEAT:  'worker.heartbeat',
  WORKER_MEMORY:     'worker.memory',
  WORKER_CPU:        'worker.cpu',

  // Flow (DAG) lifecycle
  FLOW_STARTED:        'flow.started',
  FLOW_NODE_COMPLETED: 'flow.node.completed',
  FLOW_NODE_FAILED:    'flow.node.failed',
  FLOW_COMPLETED:      'flow.completed',

  // Alert lifecycle
  ALERT_FIRED:    'alert.fired',
  ALERT_RESOLVED: 'alert.resolved',
});

/**
 * @typedef {Object} BaseEvent
 * @property {string} id         - UUID v4
 * @property {string} type       - EventType value
 * @property {number} ts         - Unix ms timestamp
 * @property {string} queueName  - Queue the event belongs to (empty string for global)
 */

/**
 * @typedef {BaseEvent & {
 *   jobId:       string,
 *   jobName:     string,
 *   data:        any,
 *   attempts:    number,
 *   maxRetries:  number,
 *   batchId:     string|null,
 *   parentIds:   string[],
 *   repeatExpr:  string|null,
 * }} JobCreatedEvent
 */

/**
 * @typedef {BaseEvent & {
 *   jobId:       string,
 *   jobName:     string,
 *   workerId:    string,
 *   workerHost:  string,
 *   attempt:     number,
 * }} JobActiveEvent
 */

/**
 * @typedef {BaseEvent & {
 *   jobId:        string,
 *   jobName:      string,
 *   workerId:     string,
 *   durationMs:   number,   // wall clock from active → completed
 *   attempt:      number,
 *   result:       any,
 * }} JobCompletedEvent
 */

/**
 * @typedef {BaseEvent & {
 *   jobId:         string,
 *   jobName:       string,
 *   workerId:      string,
 *   durationMs:    number,
 *   attempt:       number,
 *   failedReason:  string,
 *   stack:         string|null,
 *   willRetry:     boolean,
 *   retryDelayMs:  number,
 * }} JobFailedEvent
 */

/**
 * @typedef {BaseEvent & {
 *   workerId:    string,
 *   workerHost:  string,
 *   concurrency: number,
 *   pid:         number,
 * }} WorkerStartedEvent
 */

/**
 * @typedef {BaseEvent & {
 *   workerId:     string,
 *   memoryBytes:  number,   // process.memoryUsage().rss
 *   heapUsed:     number,
 *   heapTotal:    number,
 *   ts:           number,
 * }} WorkerMemoryEvent
 */

/**
 * @typedef {BaseEvent & {
 *   workerId:     string,
 *   cpuUser:      number,   // microseconds (process.cpuUsage())
 *   cpuSystem:    number,
 *   cpuPercent:   number,   // derived: delta / interval
 * }} WorkerCpuEvent
 */

/**
 * @typedef {BaseEvent & {
 *   workerId:    string,
 *   activeJobs:  string[],  // job IDs currently being processed
 * }} WorkerHeartbeatEvent
 */

/**
 * @typedef {BaseEvent & {
 *   workerId:    string,
 *   lastSeenMs:  number,    // ms since last heartbeat
 *   orphanedJobIds: string[],
 * }} WorkerStalledEvent
 */

/**
 * @typedef {BaseEvent & {
 *   flowId:   string,
 *   nodeId:   string,
 *   nodeName: string,
 *   durationMs: number,
 * }} FlowNodeCompletedEvent
 */

/**
 * @typedef {BaseEvent & {
 *   incidentId:  string,
 *   alertName:   string,
 *   severity:    'critical'|'high'|'medium'|'low',
 *   labels:      Record<string,string>,
 *   description: string,
 * }} AlertFiredEvent
 */

module.exports = { EventType };
