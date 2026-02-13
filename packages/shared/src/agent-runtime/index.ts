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
} from './credentials.ts';

// Credential resolution
export {
  type ResolvedCredentials,
  type ResolveCredentialsInput,
  resolveCredentials,
} from './resolver.ts';

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
} from './invocations.ts';

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
} from './artifacts.ts';

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
  AgentCancelledError,
  AnthropicProvider,
  createProvider,
  executeAgent,
  getDefaultTimeout,
} from './provider.ts';

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
} from './context.ts';

// Planner agent
export {
  type PlannerInput,
  type PlannerResult,
  runPlanner,
} from './agents/planner.ts';

// Reviewer agent
export {
  type ReviewerInput,
  type ReviewerResult,
  parseVerdict,
  runPlanReviewer,
  runCodeReviewer,
} from './agents/reviewer.ts';

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
} from './agents/implementer.ts';

// Tool system (WP7)
export * from './tools/index.ts';

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
} from './tool-invocations.ts';

// Policy definitions seeder
export {
  type BuiltInPolicy,
  BUILT_IN_POLICIES,
  ensureBuiltInPolicyDefinitions,
} from './policy-definitions.ts';

// Executor (tool-use loop)
export {
  MAX_TOOL_ITERATIONS,
  runToolLoop,
  type ExecutorInput,
  type ExecutorResult,
} from './executor.ts';

// Agent messages CRUD
export {
  type AgentMessage,
  type CreateAgentMessageInput,
  generateAgentMessageId,
  createAgentMessage,
  listAgentMessages,
  listAgentMessagesPaginated,
  countAgentMessages,
  listAgentMessagesByRun,
  getAgentMessageCountsByRun,
  pruneAgentMessages,
} from './agent-messages.ts';
