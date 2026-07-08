// dashboard/src/lib/features.ts
// Feature flag configuration for TaurusMQ Dashboard.
// Controls the visibility and availability of Phase 1 vs Post-MVP features.

export const FEATURES = {
  // Phase 1: Core Observability (MVP) - ENABLED
  PHASE_1_MVP: true,

  // Phase 2: Debugger (Execution timeline, in-UI logs, stack traces, replay, failure groups) - ENABLED
  PHASE_2_DEBUGGER: true,

  // Phase 3: Incident Center (Playbook recommendations, firing incidents, alerts history) - ENABLED
  PHASE_3_INCIDENT_CENTER: true,

  // Phase 4: Analytics (Capacity forecasting, Net growth rates) - ENABLED
  PHASE_4_ANALYTICS: true,

  // Phase 5: Flow Visualization (Visual parent-child DAG map) - ENABLED
  PHASE_5_FLOW_VISUALIZATION: true,
};

/**
 * Helper to check if a feature is enabled.
 * Can be extended to check localStorage overrides if needed during development.
 */
export function isFeatureEnabled(featureName: keyof typeof FEATURES): boolean {
  return FEATURES[featureName] === true;
}
