/**
 * Gates Module
 *
 * Barrel export for gate definitions and gate evaluations.
 */

// Gate definitions seeder and queries
export {
  type BuiltInGate,
  type GateDefinition,
  BUILT_IN_GATES,
  ensureBuiltInGateDefinitions,
  getGateDefinition,
  listGateDefinitions,
} from './gate-definitions.js';

// Gate evaluations CRUD and derived state
export {
  type GateEvaluation,
  type CreateGateEvaluationInput,
  generateGateEvaluationId,
  createGateEvaluation,
  getLatestGateEvaluation,
  listGateEvaluations,
  deriveGateState,
  getRunsAwaitingGates,
} from './gate-evaluations.js';
