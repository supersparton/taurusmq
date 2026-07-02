// packages/recommendation-engine/RecommendationEngine.js
// Generates ranked action recommendations from active incidents + live metrics.
// Output is fully deterministic: same incidents + same metrics = same recommendations.

'use strict';

const redis      = require('../../src/utils/redis');
const { PLAYBOOK } = require('./playbook');

class RecommendationEngine {
  /**
   * Generate recommendations for all currently firing incidents.
   *
   * @param {Object[]} firingIncidents  - from IncidentEngine.getFiringIncidents()
   * @returns {Promise<Object[]>}       - sorted by priority ascending
   */
  async generate(firingIncidents) {
    const recommendations = [];

    for (const incident of firingIncidents) {
      // Load live metrics for context
      const metrics = incident.scope === 'queue'
        ? await redis.hgetall(`tmq:obs:materialized:${incident.scopeTarget}`) ?? {}
        : {};

      const matchingRules = PLAYBOOK.filter(p => p.ruleId === incident.ruleId);

      for (const rule of matchingRules) {
        recommendations.push({
          id:               `${incident.id}:${rule.ruleId}:${rule.priority}`,
          priority:         rule.priority,
          urgency:          rule.urgency,
          type:             rule.type,
          title:            rule.title,
          incidentId:       incident.id,
          incidentName:     incident.ruleName,
          scopeTarget:      incident.scopeTarget,
          why:              rule.buildWhy(incident, metrics),
          how:              rule.buildHow(incident, metrics),
          estimatedImpact:  rule.buildImpact(incident, metrics),
          estimatedTimeMin: rule.estimatedTimeMin,
          evidence:         incident.evidence,
          firedAt:          incident.firedAt,
        });
      }
    }

    // Sort: first by priority, then by urgency weight
    const urgencyWeight = { immediate: 0, within_15m: 1, within_1h: 2, planned: 3 };
    return recommendations.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (urgencyWeight[a.urgency] ?? 9) - (urgencyWeight[b.urgency] ?? 9);
    });
  }

  /**
   * Generate RCA hypotheses for a specific incident.
   * Evidence is pulled from Redis at query time — not cached.
   *
   * RCA scoring: confidence = matched evidence items / total evidence items for the rule.
   *
   * @param {Object} incident
   * @returns {Promise<Object[]>} sorted by confidence descending
   */
  async generateRCA(incident) {
    const metrics = incident.scope === 'queue'
      ? await redis.hgetall(`tmq:obs:materialized:${incident.scopeTarget}`) ?? {}
      : {};

    const errorGroups = incident.scope === 'queue'
      ? await redis.hgetall(`tmq:obs:metrics:${incident.scopeTarget}:errors`) ?? {}
      : {};

    const topError = Object.entries(errorGroups)
      .sort(([, a], [, b]) => parseInt(b, 10) - parseInt(a, 10))[0];

    const hypotheses = [];

    // Build hypotheses based on rule + available evidence
    if (incident.ruleId === 'high_failure_rate' || incident.ruleId === 'queue_no_drain') {
      const errorRate = parseFloat(metrics.errorRate ?? '0');
      const failed    = parseInt(metrics.failed      ?? '0', 10);
      const waiting   = parseInt(metrics.waiting     ?? '0', 10);

      const evidence = incident.evidence;
      const topErrorStr = topError ? `Top error: "${topError[0]}" (${topError[1]} occurrences)` : null;

      if (topError) {
        hypotheses.push({
          rank:       1,
          hypothesis: `All failures share a common error: "${topError[0].slice(0, 80)}"`,
          confidence: this._evidenceScore(evidence, [
            errorRate > 0.1,
            failed > 5,
            !!topError,
            parseInt(topError[1], 10) / Math.max(failed, 1) > 0.5,
          ]),
          evidence: [
            topErrorStr,
            ...evidence,
          ].filter(Boolean),
          immediateAction:       `Fix the root cause of: ${topError[0].slice(0, 100)}`,
          immediateActionDetail: `Inspect recent failed jobs in queue ${incident.scopeTarget} for this error pattern`,
          preventionAction:      `Add input validation or circuit breaker to prevent re-occurrence`,
          estimatedResolutionMins: 30,
          affectedJobs: failed,
        });
      }

      hypotheses.push({
        rank:       topError ? 2 : 1,
        hypothesis: `Worker resource exhaustion causing systematic job failure`,
        confidence: this._evidenceScore(evidence, [
          errorRate > 0.3,
          waiting > 500,
          parseFloat(metrics.netGrowthRate ?? '0') > 0,
        ]),
        evidence,
        immediateAction:       `Check worker memory and CPU via /api/workers`,
        immediateActionDetail: `If workers are at >85% memory, scale container resources`,
        preventionAction:      `Implement resource limits and pre-flight job admission checks`,
        estimatedResolutionMins: 15,
        affectedJobs: failed,
      });
    }

    if (incident.ruleId === 'worker_memory_pressure') {
      const heapPct = parseFloat((incident.labels.heapPct ?? '0%').replace('%', ''));
      hypotheses.push({
        rank:       1,
        hypothesis: `Job payload too large for current worker memory allocation`,
        confidence: this._evidenceScore(incident.evidence, [heapPct > 85, heapPct > 90]),
        evidence:   incident.evidence,
        immediateAction:       `Increase container memory limit to 2x current allocation`,
        immediateActionDetail: `Update resources.limits.memory in deployment manifest, then rolling restart`,
        preventionAction:      `Add payload size gate at queue admission time`,
        estimatedResolutionMins: 10,
        affectedJobs: 0,
      });
    }

    return hypotheses.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Evidence confidence scoring.
   * confidence = (matched predicates / total predicates) * 100, rounded.
   */
  _evidenceScore(evidence, predicates) {
    const trueCount = predicates.filter(Boolean).length;
    const base = evidence.length > 0 ? 0.5 : 0;
    return Math.round((base + (trueCount / Math.max(predicates.length, 1)) * 0.5) * 100);
  }
}

module.exports = { RecommendationEngine };
