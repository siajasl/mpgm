/**
 * Write mpgm's own Plan artifact from `scripts/mpgm-plan.mjs`.
 *
 * Run after editing PLAN.md section 3 for P3-P5, then commit the result:
 *
 *   npm run build && node scripts/plan-artifact.mjs
 *
 * The artifact is what T3.1.8 loads, and what `demo:ingest` schedules. This
 * script exists so the two cannot be hand-edited apart — the artifact is
 * generated, never authored.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactStore, projectArtifactSchemas } from '../dist/index.js';
import { MPGM_PLAN } from './mpgm-plan.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const store = new ArtifactStore({
  root: projectRoot,
  schemas: projectArtifactSchemas(),
});

const basePath = 'artifacts/plan/plan.md';
const version = store.latestVersion(basePath);
const request = {
  id: 'mpgm-plan',
  basePath,
  schema: 'plan',
  data: MPGM_PLAN,
  producedBy: {
    task: 'T2.2.7',
    role: 'operator',
    model: '(hand-authored)',
    runId: 'bootstrap',
  },
  tracesTo: ['PLN-1', 'PLN-2', 'PLN-3'],
};

// Overwrite v1 rather than stacking successors: this is a generated file being
// regenerated, not a plan being revised. A real revision goes through the
// replan classifier (PLN-4), which is a different thing entirely.
const artifact = version === 0 ? store.write(request) : store.overwrite(request, 1);

process.stdout.write(`${artifact.path} (v${String(artifact.version)})\n`);
