import { PlaybookLoadError } from './errors.js';
import type {
  Ballot,
  MemberSpec,
  PlaybookDefinition,
  PlaybookNode,
  VoteRule,
} from './definition.js';

/**
 * Pattern expansion (ORC-4, DESIGN §4.1).
 *
 * Pattern nodes are declarations. This turns them into an ordinary task graph
 * before anything is dispatched, so the scheduler, the context assembler, the
 * event log and replay all deal in tasks — there is no "panel mode" anywhere
 * downstream. Expansion is a pure function of the playbook, which is what lets
 * a replayed run reconstruct the same graph without re-reading the file.
 */

/** A step the kernel dispatches to an agent session. */
export interface SessionStep {
  readonly kind: 'session';
  readonly id: string;
  /** The declared node this step came from. */
  readonly node: string;
  readonly role: string;
  readonly description: string;
  readonly prompt: string;
  /** Step ids that must complete first. */
  readonly dependsOn: readonly string[];
  /** Input artifact ids this step reads. */
  readonly consumes: readonly string[];
  readonly produces?: string;
}

/**
 * A step the kernel computes itself: counting a panel's ballots.
 *
 * It has no role and no prompt because it makes no model call. Keeping it in
 * the same graph as the sessions means the gate reads a panel's decision the
 * same way it reads anything else.
 */
export interface TallyStep {
  readonly kind: 'tally';
  readonly id: string;
  readonly node: string;
  readonly description: string;
  readonly dependsOn: readonly string[];
  readonly ballot: Ballot;
  readonly vote: VoteRule;
  readonly produces?: string;
}

export type GraphStep = SessionStep | TallyStep;

export interface TaskGraph {
  readonly steps: readonly GraphStep[];
  /** Step ids in a dependency-respecting order. */
  readonly order: readonly string[];
  /** Node id → the step whose result *is* that node's result. */
  readonly terminal: Readonly<Record<string, string>>;
  /** Node id → every step it expanded to, in declaration order. */
  readonly members: Readonly<Record<string, readonly string[]>>;
}

/** A loaded, validated, expanded playbook. */
export interface Playbook extends PlaybookDefinition {
  /** Where it was loaded from, for error messages and audit. */
  readonly sourcePath: string;
  /** The declared nodes, expanded into ordinary steps. */
  readonly graph: TaskGraph;
  /** Step ids in a dependency-respecting order. Shorthand for `graph.order`. */
  readonly order: readonly string[];
}

/** How many members a fan-out or panel declares, however it declares them. */
export function memberCount(spec: MemberSpec): number {
  return spec.lenses?.length ?? spec.count ?? 0;
}

function memberPrompt(spec: MemberSpec, index: number, total: number): string {
  const lens = spec.lenses?.[index];
  if (lens !== undefined) {
    return (
      `${spec.prompt.trim()}\n\n` +
      `Your assigned lens is: ${lens}. Cover it thoroughly and only it — the ` +
      `other ${String(total - 1)} member(s) of this group cover the rest, and ` +
      `work you duplicate is work nobody does.`
    );
  }
  return (
    `${spec.prompt.trim()}\n\n` +
    `You are member ${String(index + 1)} of ${String(total)} working this ` +
    `independently. You cannot see the others and must not assume what they ` +
    `will conclude; reaching the same answer separately is the point.`
  );
}

function ballotInstruction(ballot: Ballot): string {
  if (ballot.type === 'approval') {
    return (
      `Record your vote in the \`${ballot.field}\` field of your output: true to ` +
      `approve, false to reject. The kernel counts that field directly, so it is ` +
      `your vote and not a summary of your reasoning.`
    );
  }
  return (
    `Record your vote in the \`${ballot.field}\` field of your output, set to ` +
    `exactly one of: ${ballot.options.join(', ')}. Any other value is a spoiled ` +
    `ballot and counts as an abstention.`
  );
}

/** The step id a fan-out or panel member is given. */
function memberId(nodeId: string, kindWord: string, index: number): string {
  return `${nodeId}-${kindWord}-${String(index + 1)}`;
}

function checkMemberSpec(sourcePath: string, nodeId: string, spec: MemberSpec): void {
  const hasCount = spec.count !== undefined;
  const hasLenses = spec.lenses !== undefined;
  if (hasCount && hasLenses) {
    throw new PlaybookLoadError(
      sourcePath,
      `node '${nodeId}' declares both 'count' and 'lenses'. Lenses already say how ` +
        `many members there are; a count beside them can only disagree with it.`,
    );
  }
  if (!hasCount && !hasLenses) {
    throw new PlaybookLoadError(
      sourcePath,
      `node '${nodeId}' declares neither 'count' nor 'lenses', so how many members ` +
        `it dispatches is unstated`,
    );
  }
}

/** Resolve which step carries each node's result, before any are emitted. */
function terminalIds(
  sourcePath: string,
  nodes: readonly PlaybookNode[],
): Record<string, string> {
  const terminal: Record<string, string> = {};
  for (const node of nodes) {
    switch (node.kind) {
      case 'task':
      case 'critic-of':
        terminal[node.id] = node.id;
        break;
      case 'fan-out':
        terminal[node.id] = `${node.id}-collect`;
        break;
      case 'panel':
        terminal[node.id] = `${node.id}-tally`;
        break;
      case 'pipeline': {
        const last = node.stages.at(-1);
        if (last === undefined) {
          throw new PlaybookLoadError(sourcePath, `pipeline '${node.id}' has no stages`);
        }
        terminal[node.id] = `${node.id}-${last.id}`;
        break;
      }
    }
  }
  return terminal;
}

/**
 * Order steps so every dependency precedes its dependants, and reject cycles.
 *
 * The kernel dispatches steps whose dependencies are complete (DESIGN §4.1).
 * A cycle means nothing ever becomes ready, which would present as a phase
 * that silently does nothing — far harder to diagnose than a load failure.
 * Cycles are reported in terms of the nodes the author wrote, not the steps
 * expansion generated.
 */
function topologicalOrder(
  sourcePath: string,
  steps: readonly GraphStep[],
): readonly string[] {
  const remaining = new Map(steps.map((step) => [step.id, new Set(step.dependsOn)]));
  const nodeOf = new Map(steps.map((step) => [step.id, step.node]));
  const order: string[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([id]) => id)
      .sort();

    if (ready.length === 0) {
      const involved = [
        ...new Set([...remaining.keys()].map((id) => nodeOf.get(id) ?? id)),
      ].sort();
      throw new PlaybookLoadError(
        sourcePath,
        `task dependencies form a cycle among: ${involved.join(', ')}`,
      );
    }

    for (const id of ready) {
      order.push(id);
      remaining.delete(id);
    }
    for (const deps of remaining.values()) {
      for (const id of ready) {
        deps.delete(id);
      }
    }
  }

  return order;
}

/**
 * Expand a playbook's declared nodes into an ordinary task graph.
 *
 * Throws `PlaybookLoadError` on anything expansion cannot make sense of: an
 * unknown dependency, a generated id that collides with a declared one, a
 * critic reviewing its own role. Failing here costs nothing; failing at
 * dispatch costs whatever the phase already spent getting there.
 */
export function expandPlaybook(
  sourcePath: string,
  definition: PlaybookDefinition,
): TaskGraph {
  const nodes = definition.tasks;
  const declared = new Set(nodes.map((node) => node.id));
  const terminal = terminalIds(sourcePath, nodes);

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!declared.has(dependency)) {
        throw new PlaybookLoadError(
          sourcePath,
          `task '${node.id}' depends on '${dependency}', which is not a task in this ` +
            `playbook`,
        );
      }
    }
    if (node.kind === 'critic-of' && !declared.has(node.target)) {
      throw new PlaybookLoadError(
        sourcePath,
        `critic '${node.id}' targets '${node.target}', which is not a task in this ` +
          `playbook`,
      );
    }
  }

  const steps: GraphStep[] = [];
  const members: Record<string, string[]> = {};
  const emit = (step: GraphStep): void => {
    steps.push(step);
    (members[step.node] ??= []).push(step.id);
  };
  const resolve = (ids: readonly string[]): string[] =>
    ids.map((id) => terminal[id] ?? id);

  for (const node of nodes) {
    const inherited = resolve(node.dependsOn);

    switch (node.kind) {
      case 'task':
        emit({
          kind: 'session',
          id: node.id,
          node: node.id,
          role: node.role,
          description: node.description,
          prompt: node.prompt,
          dependsOn: inherited,
          consumes: node.consumes,
          ...(node.produces === undefined ? {} : { produces: node.produces }),
        });
        break;

      case 'critic-of': {
        const target = nodes.find((candidate) => candidate.id === node.target);
        assertIndependent(sourcePath, node.id, node.role, target);
        emit({
          kind: 'session',
          id: node.id,
          node: node.id,
          role: node.role,
          description: node.description,
          prompt:
            `${node.prompt.trim()}\n\n` +
            `You are reviewing the result of '${node.target}', which you did not ` +
            `produce. Do not rewrite it; report what is wrong with it.`,
          // The target is the dependency, whether or not it was also listed.
          dependsOn: [...new Set([terminal[node.target] ?? node.target, ...inherited])],
          consumes: node.consumes,
          ...(node.produces === undefined ? {} : { produces: node.produces }),
        });
        break;
      }

      case 'fan-out': {
        checkMemberSpec(sourcePath, node.id, node.workers);
        const total = memberCount(node.workers);
        const workerIds: string[] = [];
        for (let index = 0; index < total; index += 1) {
          const id = memberId(node.id, 'worker', index);
          workerIds.push(id);
          emit({
            kind: 'session',
            id,
            node: node.id,
            role: node.workers.role,
            description: `${node.description} (worker ${String(index + 1)} of ${String(total)})`,
            prompt: memberPrompt(node.workers, index, total),
            dependsOn: inherited,
            consumes: node.consumes,
          });
        }
        emit({
          kind: 'session',
          id: `${node.id}-collect`,
          node: node.id,
          role: node.collect.role,
          description: `${node.description} (collect)`,
          prompt:
            `${node.collect.prompt.trim()}\n\n` +
            `The ${String(total)} results below were produced independently. Where ` +
            `they agree, say so once; where they disagree, say what the disagreement ` +
            `is rather than picking a side silently.`,
          dependsOn: workerIds,
          consumes: node.consumes,
          ...(node.collect.produces === undefined
            ? {}
            : { produces: node.collect.produces }),
        });
        break;
      }

      case 'pipeline': {
        const stageIds = new Set<string>();
        let previous: string[] = inherited;
        for (const stage of node.stages) {
          if (stageIds.has(stage.id)) {
            throw new PlaybookLoadError(
              sourcePath,
              `pipeline '${node.id}' has two stages named '${stage.id}'`,
            );
          }
          stageIds.add(stage.id);
          const id = `${node.id}-${stage.id}`;
          emit({
            kind: 'session',
            id,
            node: node.id,
            role: stage.role,
            description: stage.description,
            prompt: stage.prompt,
            dependsOn: previous,
            consumes: node.consumes,
            ...(stage.produces === undefined ? {} : { produces: stage.produces }),
          });
          previous = [id];
        }
        break;
      }

      case 'panel': {
        checkMemberSpec(sourcePath, node.id, node.judges);
        checkVoteRule(sourcePath, node.id, node.ballot, node.vote);
        const total = memberCount(node.judges);
        const judgeIds: string[] = [];
        for (let index = 0; index < total; index += 1) {
          const id = memberId(node.id, 'judge', index);
          judgeIds.push(id);
          emit({
            kind: 'session',
            id,
            node: node.id,
            role: node.judges.role,
            description: `${node.description} (judge ${String(index + 1)} of ${String(total)})`,
            prompt: `${memberPrompt(node.judges, index, total)}\n\n${ballotInstruction(node.ballot)}`,
            dependsOn: inherited,
            consumes: node.consumes,
          });
        }
        emit({
          kind: 'tally',
          id: `${node.id}-tally`,
          node: node.id,
          description: `${node.description} (tally, ${node.vote})`,
          dependsOn: judgeIds,
          ballot: node.ballot,
          vote: node.vote,
          ...(node.produces === undefined ? {} : { produces: node.produces }),
        });
        break;
      }
    }
  }

  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new PlaybookLoadError(
        sourcePath,
        `two tasks would both be called '${step.id}'. Pattern nodes generate ids of ` +
          `the form '<node>-worker-<n>', '<node>-collect', '<node>-judge-<n>', ` +
          `'<node>-tally' and '<node>-<stage>'; rename the node or the task that ` +
          `collides with one.`,
      );
    }
    seen.add(step.id);
  }

  return {
    steps,
    order: topologicalOrder(sourcePath, steps),
    terminal,
    members,
  };
}

function assertIndependent(
  sourcePath: string,
  criticId: string,
  criticRole: string,
  target: PlaybookNode | undefined,
): void {
  const targetRoles = new Set<string>();
  switch (target?.kind) {
    case 'task':
    case 'critic-of':
      targetRoles.add(target.role);
      break;
    case 'fan-out':
      targetRoles.add(target.collect.role);
      break;
    case 'pipeline': {
      const last = target.stages.at(-1);
      if (last !== undefined) {
        targetRoles.add(last.role);
      }
      break;
    }
    case 'panel':
      // A tally has no role: nothing to be independent of.
      break;
    default:
      break;
  }

  if (targetRoles.has(criticRole)) {
    throw new PlaybookLoadError(
      sourcePath,
      `critic '${criticId}' runs role '${criticRole}', which also produced its ` +
        `target '${target?.id ?? '(unknown)'}'. A reviewer sharing the author's role ` +
        `shares its blind spots, so its approval shows consistency rather than ` +
        `correctness (IMP-3). Give the critic a different role.`,
    );
  }
}

function checkVoteRule(
  sourcePath: string,
  nodeId: string,
  ballot: Ballot,
  vote: VoteRule,
): void {
  if (ballot.type === 'approval' && vote === 'plurality') {
    throw new PlaybookLoadError(
      sourcePath,
      `panel '${nodeId}' counts an approval ballot by plurality. With two outcomes ` +
        `that is 'majority' under another name; say which you mean.`,
    );
  }
  if (ballot.type === 'choice' && vote !== 'plurality') {
    throw new PlaybookLoadError(
      sourcePath,
      `panel '${nodeId}' counts a choice ballot by '${vote}'. A majority over more ` +
        `than two options is undefined — use 'plurality', which reports a tie as a ` +
        `tie rather than inventing a winner.`,
    );
  }
}
