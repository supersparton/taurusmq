// packages/incident-engine/IncidentEngine.js
// Evaluates detection rules every EVAL_INTERVAL_MS against live metrics.
// Manages incident lifecycle: open → active → resolved.
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

const { v4: uuidv4 } = require('uuid');
const redis          = require('../../src/utils/redis');
const { RULES }      = require('./rules');
const { EventType }  = require('../observability-core/types');

const EVAL_INTERVAL_MS   = 15_000;
const INCIDENTS_KEY      = 'tmq:obs:incidents';
const ALERTS_KEY         = 'tmq:obs:alerts';

// Map of ruleId:scopeTarget → current incidentId (in-memory, rebuilt on startup)
const _activeMap = new Map();

class IncidentEngine {
  /**
   * @param {string[]} queueNames
   * @param {import('../observability-core/ObservabilityBus').ObservabilityBus} bus
   */
  constructor(queueNames, bus) {
    this.queueNames = queueNames;
    this.bus        = bus;
    this._timer     = null;
  }

  start() {
    this._timer = setInterval(() => this._evalAll(), EVAL_INTERVAL_MS);
    console.log('[obs] IncidentEngine started, evaluating every', EVAL_INTERVAL_MS / 1000, 's');
  }

  stop() { clearInterval(this._timer); }

  addQueue(q) { if (!this.queueNames.includes(q)) this.queueNames.push(q); }

  async _evalAll() {
    const queueRules  = RULES.filter(r => r.scope === 'queue');
    const workerRules = RULES.filter(r => r.scope === 'worker');

    // Evaluate queue-scope rules
    for (const queue of this.queueNames) {
      const raw = await redis.hgetall(`tmq:obs:materialized:${queue}`);
      if (!raw) continue;
      for (const rule of queueRules) {
        await this._evalRule(rule, { queueName: queue, metrics: raw }, `${queue}`);
      }
    }

    // Evaluate worker-scope rules — discover live workers by key scan
    const workerStateKeys = await redis.keys('tmq:obs:worker:*:state');
    for (const stateKey of workerStateKeys) {
      const workerId  = stateKey.split(':')[3]; // tmq:obs:worker:{workerId}:state
      const wState    = await redis.hgetall(stateKey) ?? {};
      const wRes      = await redis.hgetall(`tmq:obs:worker:${workerId}:res`) ?? {};
      const hbRaw     = await redis.get(`tmq:obs:worker:${workerId}:hb`);
      const lastHbMs  = hbRaw ? parseInt(hbRaw, 10) : 0;

      for (const rule of workerRules) {
        await this._evalRule(rule,
          { workerId, workerState: wState, workerRes: wRes, lastHbMs },
          `${workerId}`
        );
      }
    }
  }

  async _evalRule(rule, context, scopeTarget) {
    const mapKey = `${rule.id}:${scopeTarget}`;

    let result;
    try {
      result = await rule.evaluate(context);
    } catch (err) {
      console.error('[obs] Rule evaluation error', rule.id, err.message);
      return;
    }

    const existing = _activeMap.get(mapKey);

    if (result.triggered) {
      if (!existing) {
        // New incident
        const incident = {
          id:               uuidv4(),
          ruleId:           rule.id,
          ruleName:         rule.name,
          severity:         rule.severity,
          scope:            rule.scope,
          scopeTarget,
          state:            'firing',
          firedAt:          Date.now(),
          resolvedAt:       null,
          evidence:         result.evidence ?? [],
          labels:           result.labels   ?? {},
          consecutiveTicks: 1,
        };
        _activeMap.set(mapKey, incident.id);
        await this._persistIncident(incident);

        // Emit alert.fired event
        this.bus.emit(EventType.ALERT_FIRED, {
          queueName:   context.queueName ?? '',
          incidentId:  incident.id,
          alertName:   rule.name,
          severity:    rule.severity,
          labels:      incident.labels,
          description: incident.evidence[0] ?? rule.name,
        });

        console.log(`[obs] INCIDENT FIRED: ${rule.name} on ${scopeTarget}`);
      } else {
        // Still firing — update evidence with latest values + increment tick
        const stored = await this._loadIncident(existing);
        if (stored) {
          stored.evidence         = result.evidence;
          stored.labels           = result.labels;
          stored.consecutiveTicks = (stored.consecutiveTicks ?? 0) + 1;
          await this._persistIncident(stored);
        }
      }
    } else {
      if (existing) {
        // Resolve
        const stored = await this._loadIncident(existing);
        if (stored) {
          stored.state      = 'resolved';
          stored.resolvedAt = Date.now();
          await this._persistIncident(stored);
          await redis.hdel(ALERTS_KEY, existing);

          this.bus.emit(EventType.ALERT_RESOLVED, {
            queueName:  context.queueName ?? '',
            incidentId: existing,
            alertName:  rule.name,
          });

          console.log(`[obs] INCIDENT RESOLVED: ${rule.name} on ${scopeTarget}`);
        }
        _activeMap.delete(mapKey);
      }
    }
  }

  async _persistIncident(incident) {
    const json = JSON.stringify(incident);
    await redis.pipeline()
      .hset(INCIDENTS_KEY, incident.id, json)
      .hset(ALERTS_KEY,    incident.id, json)
      .exec();
  }

  async _loadIncident(id) {
    const raw = await redis.hget(INCIDENTS_KEY, id);
    return raw ? JSON.parse(raw) : null;
  }

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
