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
} from './gate-definitions.ts';

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
} from './gate-evaluations.ts';

// Gate evaluators
export {
  type GateResult,
  type GateEvaluatorFn,
  evaluateGatePure,
} from './evaluators/index.ts';
export { evaluatePlanApproval } from './evaluators/plan-approval.ts';
export { evaluateTestsPass, getTestExecutionTruth } from './evaluators/tests-pass.ts';
