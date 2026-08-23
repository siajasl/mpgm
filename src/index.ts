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
  TaskStatus,
  Usage,
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
  PathPolicy,
  Role,
  RoleFrontmatter,
  ToolPolicy,
} from './role/definition.js';
export {
  budgetSchema,
  outputSchema,
  pathPolicySchema,
  roleFrontmatterSchema,
  toolPolicySchema,
} from './role/definition.js';
export { loadRoleFile, parseRole, RoleLoadError, RoleRegistry } from './role/loader.js';
export type {
  ArtifactTemplate,
  GateCriterion,
  GateDefinition,
  Playbook,
  PlaybookDefinition,
  TaskTemplate,
} from './playbook/definition.js';
export {
  artifactTemplateSchema,
  gateCriterionSchema,
  gateSchema,
  playbookSchema,
  taskTemplateSchema,
} from './playbook/definition.js';
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
export type {
  AssembledContext,
  AssembleRequest,
  WithheldItem,
} from './context/assembler.js';
export { assembleContext } from './context/assembler.js';
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
