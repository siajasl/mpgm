import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { playbookSchema, type Playbook, type TaskTemplate } from './definition.js';

/**
 * A playbook could not be loaded. As with role files, the message names the
 * file and the offending element: a playbook that fails to load stops a phase
 * before it starts, so the error has to be enough to fix it.
 */
export class PlaybookLoadError extends Error {
  constructor(
    readonly sourcePath: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`${sourcePath}: ${detail}`, options);
    this.name = 'PlaybookLoadError';
  }
}

/**
 * Order tasks so every dependency precedes its dependants, and reject cycles.
 *
 * The kernel dispatches tasks whose dependencies are complete (DESIGN §4.1).
 * A cycle means no task ever becomes ready, which would present as a phase
 * that silently does nothing — far harder to diagnose than a load failure.
 */
function topologicalOrder(sourcePath: string, tasks: readonly TaskTemplate[]): string[] {
  const remaining = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn)]));
  const order: string[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([id]) => id)
      .sort();

    if (ready.length === 0) {
      throw new PlaybookLoadError(
        sourcePath,
        `task dependencies form a cycle among: ${[...remaining.keys()].sort().join(', ')}`,
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

/** Parse a playbook from YAML text. Exposed so callers can validate before writing. */
export function parsePlaybook(sourcePath: string, contents: string): Playbook {
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

  const parsed = playbookSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new PlaybookLoadError(sourcePath, `invalid playbook:\n${issues}`);
  }

  const definition = parsed.data;
  const taskIds = new Set<string>();

  for (const task of definition.tasks) {
    if (taskIds.has(task.id)) {
      throw new PlaybookLoadError(sourcePath, `duplicate task id '${task.id}'`);
    }
    taskIds.add(task.id);
  }

  // Cross-references are checked here rather than left to fail at dispatch:
  // a phase that dies halfway through because a task names an artifact that
  // was never declared has already burned budget getting there.
  for (const task of definition.tasks) {
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency)) {
        throw new PlaybookLoadError(
          sourcePath,
          `task '${task.id}' depends on '${dependency}', which is not a task in this playbook`,
        );
      }
    }
    if (task.produces !== undefined && !(task.produces in definition.artifacts)) {
      throw new PlaybookLoadError(
        sourcePath,
        `task '${task.id}' produces '${task.produces}', which is not a declared artifact ` +
          `(declared: ${Object.keys(definition.artifacts).join(', ') || 'none'})`,
      );
    }
  }

  const criterionIds = new Set<string>();
  for (const criterion of definition.gate.criteria) {
    if (criterionIds.has(criterion.id)) {
      throw new PlaybookLoadError(
        sourcePath,
        `duplicate gate criterion id '${criterion.id}'`,
      );
    }
    criterionIds.add(criterion.id);

    if (
      criterion.kind === 'artifact-exists' &&
      !(criterion.artifact in definition.artifacts)
    ) {
      throw new PlaybookLoadError(
        sourcePath,
        `gate criterion '${criterion.id}' names artifact '${criterion.artifact}', ` +
          `which is not declared`,
      );
    }
    if (criterion.kind === 'agent-assertion' && !taskIds.has(criterion.fromTask)) {
      throw new PlaybookLoadError(
        sourcePath,
        `gate criterion '${criterion.id}' names task '${criterion.fromTask}', ` +
          `which is not a task in this playbook`,
      );
    }
  }

  // Every declared artifact must have a producer, or the gate can wait forever
  // on something nothing was ever going to write.
  const produced = new Set(
    definition.tasks.map((task) => task.produces).filter((id) => id !== undefined),
  );
  for (const artifactId of Object.keys(definition.artifacts)) {
    if (!produced.has(artifactId)) {
      throw new PlaybookLoadError(
        sourcePath,
        `artifact '${artifactId}' is declared but no task produces it`,
      );
    }
  }

  return {
    ...definition,
    sourcePath,
    order: topologicalOrder(sourcePath, definition.tasks),
  };
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
