import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { playbookSchema, type PlaybookDefinition } from './definition.js';
import { PlaybookLoadError } from './errors.js';
import { expandPlaybook, type Playbook, type TaskGraph } from './graph.js';

export { PlaybookLoadError } from './errors.js';

function parseYamlMapping(sourcePath: string, contents: string): object {
  let raw: unknown;
  try {
    raw = parseYaml(contents);
  } catch (cause) {
    const where =
      cause instanceof YAMLParseError && cause.linePos !== undefined
        ? ` at line ${String(cause.linePos[0].line)}`
        : '';
    throw new PlaybookLoadError(
      sourcePath,
      `not valid YAML${where}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  if (raw === null || typeof raw !== 'object') {
    throw new PlaybookLoadError(sourcePath, 'a playbook must be a YAML mapping');
  }
  return raw;
}

/**
 * Cross-references that the schema cannot express, checked before dispatch.
 *
 * Deferring them to run time means a phase dies halfway through because a task
 * names an artifact nobody declared — having already burned the budget of
 * every task before it.
 */
function checkReferences(
  sourcePath: string,
  definition: PlaybookDefinition,
  graph: TaskGraph,
): void {
  const producers = new Map<string, string[]>();

  for (const step of graph.steps) {
    if (step.kind === 'session') {
      for (const consumed of step.consumes) {
        if (!(consumed in definition.inputs) && !(consumed in definition.artifacts)) {
          throw new PlaybookLoadError(
            sourcePath,
            `task '${step.node}' consumes '${consumed}', which is neither a declared ` +
              `input nor an artifact this phase produces`,
          );
        }
      }
    }
    if (step.produces !== undefined) {
      if (!(step.produces in definition.artifacts)) {
        throw new PlaybookLoadError(
          sourcePath,
          `task '${step.id}' produces '${step.produces}', which is not a declared ` +
            `artifact (declared: ${Object.keys(definition.artifacts).join(', ') || 'none'})`,
        );
      }
      const writers = producers.get(step.produces) ?? [];
      writers.push(step.id);
      producers.set(step.produces, writers);
    }
  }

  for (const artifactId of Object.keys(definition.artifacts)) {
    const writers = producers.get(artifactId) ?? [];
    if (writers.length === 0) {
      // A gate waiting on an artifact nothing was ever going to write waits
      // forever.
      throw new PlaybookLoadError(
        sourcePath,
        `artifact '${artifactId}' is declared but no task produces it`,
      );
    }
    if (writers.length > 1) {
      // The artifact store keeps one version chain per artifact. Two writers
      // race to be v1, and the loser's work becomes a superseded version that
      // nothing asked for — silently, since both tasks succeeded.
      throw new PlaybookLoadError(
        sourcePath,
        `artifact '${artifactId}' is produced by more than one task ` +
          `(${writers.join(', ')}). Exactly one task writes each artifact; to combine ` +
          `several tasks' work, collect it in one task and produce it there.`,
      );
    }
  }
}

function checkGate(
  sourcePath: string,
  definition: PlaybookDefinition,
  graph: TaskGraph,
): void {
  const criterionIds = new Set<string>();
  const nodeKinds = new Map(definition.tasks.map((node) => [node.id, node.kind]));
  const stepIds = new Set(graph.steps.map((step) => step.id));

  for (const criterion of definition.gate.criteria) {
    if (criterionIds.has(criterion.id)) {
      throw new PlaybookLoadError(
        sourcePath,
        `duplicate gate criterion id '${criterion.id}'`,
      );
    }
    criterionIds.add(criterion.id);

    switch (criterion.kind) {
      case 'artifact-exists':
        if (!(criterion.artifact in definition.artifacts)) {
          throw new PlaybookLoadError(
            sourcePath,
            `gate criterion '${criterion.id}' names artifact '${criterion.artifact}', ` +
              `which is not declared`,
          );
        }
        break;

      case 'agent-assertion':
        if (!nodeKinds.has(criterion.fromTask) && !stepIds.has(criterion.fromTask)) {
          throw new PlaybookLoadError(
            sourcePath,
            `gate criterion '${criterion.id}' names task '${criterion.fromTask}', ` +
              `which is not a task in this playbook`,
          );
        }
        if (nodeKinds.get(criterion.fromTask) === 'panel') {
          // A tally is arithmetic, not an assertion. Reading it as one would
          // dress a kernel computation up as something an agent attested to.
          throw new PlaybookLoadError(
            sourcePath,
            `gate criterion '${criterion.id}' reads '${criterion.fromTask}' as an ` +
              `agent assertion, but it is a panel: its result is counted by the ` +
              `kernel, not asserted by an agent. Use kind 'vote-carried'.`,
          );
        }
        break;

      case 'vote-carried':
        if (nodeKinds.get(criterion.panel) !== 'panel') {
          throw new PlaybookLoadError(
            sourcePath,
            `gate criterion '${criterion.id}' names '${criterion.panel}' as a panel, ` +
              `but ${nodeKinds.has(criterion.panel) ? 'it is a ' + String(nodeKinds.get(criterion.panel)) + ' node' : 'no such task is declared'}`,
          );
        }
        break;
    }
  }
}

/** Parse a playbook from YAML text. Exposed so callers can validate before writing. */
export function parsePlaybook(sourcePath: string, contents: string): Playbook {
  const raw = parseYamlMapping(sourcePath, contents);

  const parsed = playbookSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new PlaybookLoadError(sourcePath, `invalid playbook:\n${issues}`);
  }

  const definition = parsed.data;
  const nodeIds = new Set<string>();
  for (const node of definition.tasks) {
    if (nodeIds.has(node.id)) {
      throw new PlaybookLoadError(sourcePath, `duplicate task id '${node.id}'`);
    }
    nodeIds.add(node.id);
  }

  const graph = expandPlaybook(sourcePath, definition);
  checkReferences(sourcePath, definition, graph);
  checkGate(sourcePath, definition, graph);

  return { ...definition, sourcePath, graph, order: graph.order };
}

export function loadPlaybookFile(sourcePath: string): Playbook {
  let contents: string;
  try {
    contents = readFileSync(sourcePath, 'utf8');
  } catch (cause) {
    throw new PlaybookLoadError(sourcePath, 'could not be read', { cause });
  }

  const playbook = parsePlaybook(sourcePath, contents);
  const expected = basename(sourcePath).replace(/\.ya?ml$/, '');

  if (playbook.phase !== expected) {
    throw new PlaybookLoadError(
      sourcePath,
      `declares phase '${playbook.phase}' but the file is named '${expected}.yaml'. ` +
        `Phases are referenced by file name, so the two must agree.`,
    );
  }

  return playbook;
}

export class PlaybookRegistry {
  readonly #playbooks: ReadonlyMap<string, Playbook>;

  constructor(playbooks: readonly Playbook[]) {
    const map = new Map<string, Playbook>();
    for (const playbook of playbooks) {
      const existing = map.get(playbook.phase);
      if (existing !== undefined) {
        throw new PlaybookLoadError(
          playbook.sourcePath,
          `duplicate playbook for phase '${playbook.phase}', already defined by ${existing.sourcePath}`,
        );
      }
      map.set(playbook.phase, playbook);
    }
    this.#playbooks = map;
  }

  static fromDirectory(directory: string): PlaybookRegistry {
    let entries: string[];
    try {
      entries = readdirSync(directory)
        .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
        .sort();
    } catch (cause) {
      throw new PlaybookLoadError(directory, 'playbook directory could not be read', {
        cause,
      });
    }

    return new PlaybookRegistry(
      entries.map((entry) => loadPlaybookFile(join(directory, entry))),
    );
  }

  get phases(): readonly string[] {
    return [...this.#playbooks.keys()];
  }

  has(phase: string): boolean {
    return this.#playbooks.has(phase);
  }

  get(phase: string): Playbook {
    const playbook = this.#playbooks.get(phase);
    if (playbook === undefined) {
      throw new PlaybookLoadError(
        phase,
        `no playbook for this phase. Loaded: ${this.phases.join(', ') || '(none)'}`,
      );
    }
    return playbook;
  }
}
