/**
 * mpgm — an agentic harness driving the full SDLC via Claude Agent SDK
 * sessions under a single operator.
 *
 * The event log (ADR-2, DESIGN §5) is the kernel's single authoritative write
 * path. The state fold and snapshots land at T1.1.3, blob offload at T1.1.4,
 * and intent-before-effect at T1.1.5.
 */

export type { EventInput, JsonValue, StoredEvent } from './event/envelope.js';
export {
  AppendOnlyViolationError,
  EventLogError,
  EventValidationError,
  UnknownEventTypeError,
  UpcastError,
} from './event/errors.js';
export type { EventDefinition, Upcaster } from './event/registry.js';
export { defineEvent, EventRegistry } from './event/registry.js';
export type { ArtifactRef } from './event/catalog.js';
export {
  artifactRefSchema,
  blobRefSchema,
  kernelEvents,
  kernelRegistry,
} from './event/catalog.js';
export type { BlobRef, GetOptions } from './blob/store.js';
export {
  BlobIntegrityError,
  BlobNotFoundError,
  BlobStore,
  HASH_ALGORITHM,
  hashContent,
} from './blob/store.js';
export type { RedactionRule, RedactorOptions } from './redaction.js';
export { defaultKeyRules, defaultValueRules, marker, Redactor } from './redaction.js';
export type { Clock, EventLogOptions, ReadOptions } from './event/store.js';
export { EventLog } from './event/store.js';
export { MEMORY, openDatabase } from './database.js';
export type {
  GateState,
  GateStatus,
  KernelState,
  RunState,
  TaskState,
  PlanRevisionState,
  TaskStatus,
  Usage,
  VoteState,
} from './state/kernel-state.js';
export { emptyState, zeroUsage } from './state/kernel-state.js';
export type { PayloadOf } from './state/reduce.js';
export {
  fold,
  reduce,
  REDUCER_VERSION,
  UnhandledEventError,
  UnknownRunError,
} from './state/reduce.js';
export type { Snapshot } from './state/snapshot-store.js';
export { SnapshotStore } from './state/snapshot-store.js';
export type { ProjectorOptions } from './state/projector.js';
export { DEFAULT_SNAPSHOT_INTERVAL, Projector } from './state/projector.js';
export type { EffectState, EffectStatus } from './state/kernel-state.js';
export { pendingEffects } from './state/reduce.js';
export type { EffectContract, EffectIntent, EffectSemantics } from './effect/contract.js';
export { EffectContractRegistry, intentOf } from './effect/contract.js';
export type {
  EffectJournalOptions,
  EffectRequest,
  Resolution,
  ResolutionReport,
} from './effect/journal.js';
export { EffectJournal } from './effect/journal.js';

/** Package version. Kept in step with package.json by test. */
export const VERSION = '0.1.0';

export type {
  Budget,
  NetworkPolicy,
  PathPolicy,
  Role,
  RoleFrontmatter,
  ToolPolicy,
} from './role/definition.js';
export {
  budgetSchema,
  networkPolicySchema,
  outputSchema,
  pathPolicySchema,
  roleFrontmatterSchema,
  toolPolicySchema,
} from './role/definition.js';
export { loadRoleFile, parseRole, RoleLoadError, RoleRegistry } from './role/loader.js';
export type {
  ArtifactTemplate,
  Ballot,
  CriticNode,
  FanOutNode,
  GateCriterion,
  GateDefinition,
  InputTemplate,
  MemberSpec,
  PanelNode,
  PipelineNode,
  PipelineStage,
  PlaybookDefinition,
  PlaybookNode,
  TaskTemplate,
  VoteRule,
} from './playbook/definition.js';
export {
  artifactTemplateSchema,
  ballotSchema,
  criticNodeSchema,
  fanOutNodeSchema,
  gateCriterionSchema,
  gateSchema,
  inputTemplateSchema,
  panelNodeSchema,
  pipelineNodeSchema,
  pipelineStageSchema,
  playbookNodeSchema,
  playbookSchema,
  taskTemplateSchema,
  voteRuleSchema,
} from './playbook/definition.js';
export type {
  GraphStep,
  Playbook,
  SessionStep,
  TallyStep,
  TaskGraph,
} from './playbook/graph.js';
export { expandPlaybook, memberCount } from './playbook/graph.js';
export type {
  BlockedStep,
  DispatchDecision,
  SchedulableStep,
  ScheduleReport,
  ScheduleRequest,
  StepOutcome,
} from './orchestrator/scheduler.js';
export { schedule, SchedulerError } from './orchestrator/scheduler.js';
export type {
  ApprovalTally,
  CastBallot,
  ChoiceTally,
  Tally,
} from './orchestrator/tally.js';
export { tally, TallyError } from './orchestrator/tally.js';
export {
  loadPlaybookFile,
  parsePlaybook,
  PlaybookLoadError,
  PlaybookRegistry,
} from './playbook/loader.js';
export type { ArtifactMigration, ArtifactSchema } from './artifact/schema-registry.js';
export {
  ArtifactSchemaError,
  ArtifactSchemaRegistry,
  defineArtifactSchema,
} from './artifact/schema-registry.js';
export type {
  Artifact,
  ArtifactStoreOptions,
  GateOracle,
  Provenance,
  WriteRequest,
} from './artifact/store.js';
export type { EgressClass, EgressPolicy } from './context/egress.js';
export {
  classOf,
  DEFAULT_EGRESS_POLICY,
  EGRESS_CLASSES,
  egressClassSchema,
  permitted,
} from './context/egress.js';
export type { KbDocument } from './context/knowledge-base.js';
export { loadKnowledgeBase, parseKbDocument } from './context/knowledge-base.js';
export type { Convention } from './context/conventions.js';
export {
  CONVENTIONS_KIND,
  duplicateConventionIds,
  isConventionsDocument,
  parseConventions,
  undeclaredDeviations,
} from './context/conventions.js';
export type {
  AssembledContext,
  AssembleRequest,
  TaskSpec,
  UpstreamResult,
  WithheldItem,
} from './context/assembler.js';
export { assembleContext } from './context/assembler.js';
export type {
  Conclusions,
  ElicitationOptions,
  ElicitationResult,
  ElicitationTurn,
  Exchange,
  OperatorIo,
} from './elicit/session.js';
export {
  conclusionsSchema,
  DEFAULT_MAX_QUESTIONS,
  elicit,
  ElicitationError,
  elicitationOutputSchema,
  elicitationTurnSchema,
  exchangeSchema,
} from './elicit/session.js';
export { ScriptedIo, TerminalIo, type ScriptedIoOptions } from './elicit/io.js';
export type {
  ApprovalPacket,
  CriterionResult,
  GateEvidence,
  GateManagerOptions,
  PacketNarrative,
} from './gate/manager.js';
export {
  canProceed,
  GateError,
  GateManager,
  gateOracleFromState,
  isApproved,
} from './gate/manager.js';
export type {
  GateVerdict,
  ReopenOptions,
  ReopenPlan,
  ReopenRequest,
} from './gate/reopen.js';
export { planReopen, reopenPhase } from './gate/reopen.js';
export {
  ArtifactStore,
  ArtifactStoreError,
  frontmatterSchema,
  GatedArtifactError,
  provenanceSchema,
  renderBody,
  StaticGateOracle,
} from './artifact/store.js';
export type {
  AgentSessionProvider,
  SessionRequest,
  SessionResult,
  SessionTermination,
  SessionUsageReport,
  ToolDecision,
  ToolDenial,
  ToolGate,
} from './agent/session.js';
export type { BudgetBreach, BudgetKind, Now } from './agent/budget.js';
export { BudgetLedger, runWithWallClock } from './agent/budget.js';
export { OutputSchemaRegistry } from './agent/output-registry.js';
export { ScriptedProvider, scriptedSuccess } from './agent/scripted-provider.js';
export { ClaudeAgentProvider } from './agent/claude-provider.js';
export type { RolePolicyOptions } from './policy/role-policy.js';
export { RolePolicy } from './policy/role-policy.js';
export type {
  RunTaskRequest,
  SessionRunnerOptions,
  TaskOutcome,
} from './agent/runner.js';
export { DEFAULT_MAX_VALIDATION_ATTEMPTS, SessionRunner } from './agent/runner.js';
export { demoTimestamp, syntheticRun } from './demo/workload.js';
export { demoSchemaRegistry, toySummarySchema } from './demo/schemas.js';
export {
  adrSchema,
  changeSchema,
  codeReviewSchema,
  kbCurationSchema,
  milestoneSchema,
  planPhaseSchema,
  planSchema,
  planTaskSchema,
  definitionSchema,
  designCandidateSchema,
  designCandidatesSchema,
  designElementIds,
  designSchema,
  designStances,
  designVerdictSchema,
  elicitationSchema,
  findingsSchema,
  priorArtSchema,
  priorities,
  requiredConcerns,
  requirementSchema,
  scopeSchema,
  thresholdSchema,
  projectArtifactSchemas,
  projectOutputSchemas,
} from './schemas.js';
export type { PhaseOutcome, PhaseResult, PhaseRunOptions } from './phase/runner.js';
export { DEFAULT_CONCURRENCY, runPhase } from './phase/runner.js';
export type { CliContext, CommandResult } from './cli/commands.js';
export {
  approve,
  attest,
  confirm,
  chat,
  intervene,
  reopen,
  replay,
  run,
  status,
  trace,
} from './cli/commands.js';
export type { Verb } from './cli/main.js';
export { parseArgs, runCli, USAGE, VERBS } from './cli/main.js';
export type {
  CommitRecord,
  ExtractedLinks,
  TraceLink,
  TraceNode,
  TraceNodeKind,
  TraceRelation,
} from './trace/links.js';
export {
  artifactNodeId,
  extractArtifactLinks,
  extractCommitLinks,
  looksLikeId,
  TRACE_ID_PATTERN,
} from './trace/links.js';
export type { CoverageRow, Declaration, DanglingReference } from './trace/index-store.js';
export { TraceIndex } from './trace/index-store.js';
export { TRACE_DDL } from './trace/ddl.js';
export type { IndexerOptions, IndexReport } from './trace/indexer.js';
export { TraceIndexer } from './trace/indexer.js';
export {
  changedPaths,
  GitHistoryError,
  headCommit,
  readCommits,
} from './trace/git-history.js';
export type {
  DeclaredSplit,
  DeltaKind,
  Plan,
  PlanDelta,
  ReplanClassification,
  ReplanProposal,
  ReplanVerdict,
} from './plan/replan.js';
export { classifyReplan } from './plan/replan.js';
export type { DryRunReport, IngestedTask, PlanGraph } from './plan/ingest.js';
export {
  dependencyWaves,
  dryRunPlan,
  ingestPlan,
  PlanIngestError,
} from './plan/ingest.js';
export { readyTasks } from './plan/ingest.js';
export type { RoleDrift, RoleFreeze } from './role/freeze.js';
export {
  assertRolesFrozen,
  digestOf,
  loadRoleFreeze,
  roleDigests,
  roleDrift,
  roleFreezeSchema,
  RoleFreezeError,
  unapprovedDrift,
} from './role/freeze.js';
export type {
  ImplementOptions,
  ImplementResult,
  ImplementStatus,
  ImplementTask,
} from './implement/loop.js';
export { implementTask } from './implement/loop.js';
export type { ApplyReplanOptions, ReplanOutcome } from './plan/apply.js';
export { applyReplan, completedTasks } from './plan/apply.js';
export type { GateTagRequest } from './git/tag.js';
export {
  gateTagName,
  GitTagError,
  isGitRepository,
  listGateTags,
  tagGate,
} from './git/tag.js';
export type { ChecksState, RunControl } from './state/kernel-state.js';
export { runControl } from './state/reduce.js';
export type {
  ReleaseOptions,
  ReleaseResult,
  Worktree,
  WorktreeManagerOptions,
} from './implement/worktree.js';
export {
  assertUsableTaskId,
  branchNameFor,
  DEFAULT_BRANCH_PREFIX,
  taskIdFromBranch,
  WorktreeError,
  WorktreeManager,
} from './implement/worktree.js';
export type {
  ContractSpec,
  OperationEffects,
  OperationSpec,
  Provider,
} from './contract/capability.js';
export {
  BoundContract,
  CapabilityRegistry,
  ContractError,
} from './contract/capability.js';
export type {
  CheckKind,
  CheckMapping,
  CheckRun,
  KindProblem,
  KindVerdict,
  MergeVerdict,
  MergeVerdictInput,
} from './implement/checks.js';
export {
  blockingReasons,
  CHECK_KINDS,
  checkMappingSchema,
  checkRunSchema,
  ciChecksContract,
  DEFAULT_CHECK_MAPPING,
  failed,
  MergeBlockedError,
  mergeVerdict,
  passed,
  pending,
  requireMergeable,
  REQUIRED_CHECK_KINDS,
} from './implement/checks.js';
export type { GitHubApi, GitHubChecksOptions } from './implement/github-checks.js';
export {
  fetchCheckRuns,
  ghCli,
  GitHubChecksError,
  githubChecksProvider,
} from './implement/github-checks.js';
export type { ModelTier } from './agent/models.js';
export { canEscalate, escalateModel, MODEL_TIERS, tierOf } from './agent/models.js';
export type { AwaitChecksOptions, SettledChecks } from './implement/checks.js';
export {
  awaitChecks,
  DEFAULT_CHECKS_INTERVAL_MS,
  DEFAULT_CHECKS_TIMEOUT_MS,
} from './implement/checks.js';
export { fetchCheckLog, jobIdFromUrl } from './implement/github-checks.js';
export type {
  AttemptRecord,
  RepairOptions,
  RepairOutcome,
  RepairReport,
  RepairRequest,
  RepairStatus,
} from './implement/repair.js';
export {
  DEFAULT_LOG_LINES,
  DEFAULT_REPAIR_ATTEMPTS,
  renderFeedback,
  repairUntilGreen,
  tail,
} from './implement/repair.js';
export type { MergeState, ReviewState } from './state/kernel-state.js';
export type {
  MergeChangeOptions,
  MergeDecision,
  MergeDecisionRequest,
  MergeRefusal,
  MergeResult,
  ReviewRecord,
} from './implement/merge.js';
export {
  changeReviewed,
  decideMerge,
  GIT_MERGE_CONTRACT,
  GIT_MERGE_OPERATION,
  gitMergeContract,
  mergeChange,
  MergeError,
  mergeMessage,
} from './implement/merge.js';
export type {
  RefusalReason,
  Resolution as SecretResolution,
  SecretBrokerOptions,
  SecretDeclaration,
  SecretDeclarationInput,
  SecretRefusal,
} from './secret/broker.js';
export {
  MIN_SECRET_LENGTH,
  referencedSecrets,
  SECRET_REFERENCE,
  SecretBroker,
  SecretError,
  secretDeclarationSchema,
  secretReference,
} from './secret/broker.js';
export type { DestructiveCallState } from './state/kernel-state.js';
export type {
  ConfirmationRequest,
  DestructiveGuardOptions,
  DestructiveOperation,
  DestructiveOperationInput,
  DryRunRecord,
  ShellDenial,
} from './policy/destructive.js';
export {
  DEFAULT_SHELL_DENIALS,
  DestructiveGuard,
  DestructiveGuardError,
  destructiveOperationSchema,
  fingerprint,
  stateLedger,
} from './policy/destructive.js';
export type {
  DesiredIssue,
  DesiredLabel,
  DesiredMilestone,
  DesiredProjection,
  ProjectionOptions,
  TaskColumn,
} from './pm/projection.js';
export {
  columnFor,
  desiredProjection,
  TASK_COLUMNS,
  taskIdFromBody,
  taskMarker,
} from './pm/projection.js';
export type { ObservedIssue, ObservedProjection, PmOperation } from './pm/reconcile.js';
export {
  applyOperations,
  EMPTY_PROJECTION,
  pmGithubContract,
  reconcile,
} from './pm/reconcile.js';
export type { PmProjectorOptions, SyncReport } from './pm/projector.js';
export { PmProjector } from './pm/projector.js';
export type { GitHubPmOptions } from './pm/github-provider.js';
export {
  BOARD_TITLE_MARKER,
  githubPmProvider,
  observeBoard,
} from './pm/github-provider.js';
