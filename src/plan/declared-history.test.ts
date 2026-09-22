import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ArtifactStore } from '../artifact/store.js';
import { planSchema, projectArtifactSchemas } from '../schemas.js';
import { declaredTaskIds, planEverDeclared } from './declared-history.js';

/**
 * Evidence that a Plan once declared a task id (T4.3.7, CONV-4).
 *
 * The narrowing step is git's pickaxe on the bare id, which is recall, not
 * proof: a plan that merely *writes about* an id in a completion criterion
 * changes the occurrence count exactly as one that declares it does. These
 * cases pin down that only a structural declaration counts, because that is
 * the difference between `supersede` refusing a mistyped dispatch and
 * retiring one.
 */
describe('planEverDeclared', () => {
  const BASE_PATH = 'artifacts/plan/plan.md';

  function planWith(taskIds: readonly string[], criterion: string) {
    return planSchema.parse({
      summary: 'One phase, one milestone.',
      risks: [{ id: 'R1', assumption: 'It works.', validatedBy: ['M4.1'] }],
      phases: [
        {
          id: 'P4',
          title: 'Implement',
          intent: 'Build it.',
          milestones: [
            {
              id: 'M4.1',
              title: 'A milestone',
              verification: 'It works.',
              validatesRisk: 'R1',
              tasks: taskIds.map((id) => ({
                id,
                title: `Task ${id}`,
                completionCriteria: [criterion],
                dependsOn: [],
                tracesTo: ['PLN-4'],
              })),
            },
          ],
        },
      ],
    });
  }

  function project(): { root: string; store: ArtifactStore } {
    const root = mkdtempSync(join(tmpdir(), 'mpgm-plan-history-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '--quiet');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    return {
      root,
      store: new ArtifactStore({ root, schemas: projectArtifactSchemas() }),
    };
  }

  function commit(root: string, message: string): void {
    execFileSync('git', ['add', '--all'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '--quiet', '-m', message], {
      cwd: root,
      stdio: 'ignore',
    });
  }

  it('reads task ids structurally, not wherever the string appears', () => {
    const ids = declaredTaskIds(planWith(['T4.1.4a'], 'Supersedes T4.1.4 entirely.'));

    expect([...ids]).toEqual(['T4.1.4a']);
    // The milestone id, the requirement id in `tracesTo` and the prose
    // mention of T4.1.4 all sit in the same document and none of them is a
    // declaration of a task.
    expect(ids.has('T4.1.4')).toBe(false);
    expect(ids.has('M4.1')).toBe(false);
    expect(ids.has('PLN-4')).toBe(false);
  });

  it('finds an id an earlier committed revision of the same file declared', () => {
    const { root, store } = project();
    store.write({
      id: 'plan',
      basePath: BASE_PATH,
      schema: 'plan',
      data: planWith(['T4.1.4'], 'One undivided task.'),
      producedBy: { task: 'plan', role: 'planner', model: 'm', runId: 'r1' },
    });
    commit(root, 'Plan T4.1.4');
    store.overwrite(
      {
        id: 'plan',
        basePath: BASE_PATH,
        schema: 'plan',
        data: planWith(['T4.1.4a'], 'One third of it.'),
        producedBy: { task: 'plan', role: 'planner', model: 'm', runId: 'r1' },
      },
      1,
    );
    commit(root, 'Split it');

    const found = planEverDeclared({
      root,
      artifacts: store,
      basePath: BASE_PATH,
      taskId: 'T4.1.4',
    });

    expect(found.declared).toBe(true);
    expect(found.detail).toContain('plan.v1.md at commit');
  });

  it('does not take a prose mention of an id for a declaration of it', () => {
    const { root, store } = project();
    // Every revision mentions T4.1.4 in a completion criterion — the pickaxe
    // narrows to these commits — and no revision ever declared it.
    store.write({
      id: 'plan',
      basePath: BASE_PATH,
      schema: 'plan',
      data: planWith(['T4.1.4a'], 'Carries the part of T4.1.4 that was drafting.'),
      producedBy: { task: 'plan', role: 'planner', model: 'm', runId: 'r1' },
    });
    commit(root, 'Plan the successors');
    store.overwrite(
      {
        id: 'plan',
        basePath: BASE_PATH,
        schema: 'plan',
        data: planWith(['T4.1.4b'], 'Carries the rest of T4.1.4.'),
        producedBy: { task: 'plan', role: 'planner', model: 'm', runId: 'r1' },
      },
      1,
    );
    commit(root, 'Rename the successor');

    const found = planEverDeclared({
      root,
      artifacts: store,
      basePath: BASE_PATH,
      taskId: 'T4.1.4',
    });

    expect(found.declared).toBe(false);
    expect(found.detail).toContain('every committed revision');
  });

  it('reports what it searched when there is no Plan at all (CONV-3)', () => {
    const { root, store } = project();

    const found = planEverDeclared({
      root,
      artifacts: store,
      basePath: BASE_PATH,
      taskId: 'draft',
    });

    expect(found.declared).toBe(false);
    expect(found.detail).toContain(BASE_PATH);
  });
});
