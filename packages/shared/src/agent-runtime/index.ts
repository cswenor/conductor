/**
 * Agent Runtime Module
 *
 * Barrel export for all agent runtime sub-modules.
 */

// Credential types and requirements
export {
  type CredentialMode,
  type StepCredentialRequirement,
  getStepCredentialRequirement,
} from './credentials.js';

// Credential resolution
export {
  type ResolvedCredentials,
  type ResolveCredentialsInput,
  resolveCredentials,
} from './resolver.js';

// Agent invocations CRUD
export {
  type AgentInvocation,
  type AgentInvocationStatus,
  type CreateAgentInvocationInput,
  type CompleteAgentInvocationInput,
  type FailAgentInvocationInput,
  generateAgentInvocationId,
  createAgentInvocation,
  getAgentInvocation,
  listAgentInvocations,
  markAgentRunning,
  completeAgentInvocation,
  failAgentInvocation,
} from './invocations.js';

// Artifact storage
export {
  type Artifact,
  type CreateArtifactInput,
  generateArtifactId,
  createArtifact,
  getArtifact,
  getLatestArtifact,
  getValidArtifact,
  listArtifacts,
  updateValidationStatus,
} from './artifacts.js';

// Provider abstraction, factory, and executor
export {
  type AgentInput,
  type AgentOutput,
  type AgentProvider,
  type ExecuteAgentInput,
  type ExecuteAgentResult,
  AgentError,
  AgentAuthError,
  AgentRateLimitError,
  AgentContextLengthError,
  AgentUnsupportedProviderError,
  AgentTimeoutError,
  AnthropicProvider,
  createProvider,
  executeAgent,
  getDefaultTimeout,
} from './provider.js';

// Context assembly
export {
  type AgentContext,
  type AssembleContextInput,
  SENSITIVE_FILE_PATTERNS,
  isSensitiveFile,
  redactSecretPatterns,
  assembleFileTree,
  readRelevantFiles,
  assembleContext,
  formatContextForPrompt,
} from './context.js';

// Planner agent
export {
  type PlannerInput,
  type PlannerResult,
  runPlanner,
} from './agents/planner.js';

// Reviewer agent
export {
  type ReviewerInput,
  type ReviewerResult,
  parseVerdict,
  runPlanReviewer,
  runCodeReviewer,
} from './agents/reviewer.js';

// Implementer agent
export {
  type FileOperation,
  type ImplementerInput,
  type ImplementerResult,
  isValidFilePath,
  parseFileOperations,
  applyFileOperations,
  runImplementer,
  runImplementerWithTools,
} from './agents/implementer.js';

// Tool system (WP7)
export * from './tools/index.js';

// Tool invocations CRUD
export {
  type ToolInvocation,
  type ToolInvocationStatus,
  type CreateToolInvocationInput,
  generateToolInvocationId,
  createToolInvocation,
  completeToolInvocation,
  failToolInvocation,
  blockToolInvocation,
  getToolInvocation,
  listToolInvocations,
  listToolInvocationsByRun,
} from './tool-invocations.js';

// Policy definitions seeder
export {
  type BuiltInPolicy,
  BUILT_IN_POLICIES,
  ensureBuiltInPolicyDefinitions,
} from './policy-definitions.js';

// Executor (tool-use loop)
export {
  MAX_TOOL_ITERATIONS,
  runToolLoop,
  type ExecutorInput,
  type ExecutorResult,
} from './executor.js';
