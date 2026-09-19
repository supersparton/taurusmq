// packages/incident-engine/IncidentEngine.js
// Read-view over incident state. Alert evaluation is push-based in
// MetricsAggregator (the old periodic RULES pull loop was deleted);
// this engine only serves firing/history reads to the dashboard API.
//
// Incident state stored in Redis:
//   tmq:obs:incidents hash:  incidentId → JSON
//   tmq:obs:alerts    hash:  alertId    → JSON (current active alerts)
//
// Incident state model:
// {
//   id:          string,
//   ruleId:      string,
//   ruleName:    string,
//   severity:    string,
//   scope:       'queue'|'worker',
//   scopeTarget: string,        // queueName or workerId
//   state:       'firing'|'resolved',
//   firedAt:     number,
//   resolvedAt:  number|null,
//   evidence:    string[],
//   labels:      Record<string,string>,
//   consecutiveTicks: number,  // how many ticks this rule has been firing
// }

'use strict';

const redis          = require('../../src/utils/redis');

const INCIDENTS_KEY      = 'tmq:obs:incidents';
const ALERTS_KEY         = 'tmq:obs:alerts';

class IncidentEngine {
  /**
   * @param {string[]} queueNames
   * @param {import('../observability-core/ObservabilityBus').ObservabilityBus} bus
   * (bus kept for signature compat; evaluation is push-based, no emits here)
   */
  constructor(queueNames, bus) {
    this.queueNames = queueNames;
    this.bus        = bus;
  }

  start() {
    console.log('[obs] IncidentEngine (dynamic alerts view) active');
  }

  stop() {}

  addQueue(q) { if (!this.queueNames.includes(q)) this.queueNames.push(q); }

  /** Get all currently firing incidents */
  async getFiringIncidents() {
    const raw = await redis.hgetall(ALERTS_KEY) ?? {};
    return Object.values(raw).map(v => JSON.parse(v));
  }

  /** Get incident history (all, including resolved) */
  async getIncidentHistory(limit = 100) {
    const raw    = await redis.hgetall(INCIDENTS_KEY) ?? {};
    const all    = Object.values(raw).map(v => JSON.parse(v));
    return all
      .sort((a, b) => b.firedAt - a.firedAt)
      .slice(0, limit);
  }
}

module.exports = { IncidentEngine };
