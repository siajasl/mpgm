/**
 * One-off generator for T4.3.1: derive artifacts/scope/requirements.v1.md
 * from REQUIREMENTS.md via the real ArtifactStore, so the file on disk is
 * exactly what `write()` would have produced and validates against
 * `scopeSchema` the same way any other Scope artifact would.
 *
 * Not wired into `npm run check` or any playbook — it is a migration tool,
 * run once, and its output is what is committed. Kept in `scripts/` rather
 * than discarded so the derivation is auditable: every requirement id, its
 * REQUIREMENTS.md section, and the two genuinely quantified thresholds
 * (NFR-3, NFR-6) are visible here rather than only in the generated YAML.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactStore, projectArtifactSchemas } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const reqPath = join(root, 'REQUIREMENTS.md');
const text = readFileSync(reqPath, 'utf8');
const lines = text.split('\n');

/** Section heading mapping: area code -> the REQUIREMENTS.md heading it sits under. */
const headingByCode = new Map();
const bullets = [];

const headingPattern = /^#{2,3}\s+(.*)$/;
const codeInHeading = /\(([A-Z]{2,6})\)\s*$/;
// Bold content is captured lazily up to its first closing `**`, since §6's
// bullets carry a sub-title inside the bold ("NFR-3 Performance:") that a
// pattern expecting the id alone right before `**` would miss entirely.
const bulletPattern = /^- \*\*(.+?)\*\*\s*(.*)$/;
const idPattern = /^([A-Z][A-Z0-9]{1,5}-[0-9]+)\s*(.*)$/;

for (const line of lines) {
  const heading = headingPattern.exec(line);
  if (heading) {
    const headingText = heading[1].trim();
    const codeMatch = codeInHeading.exec(headingText);
    if (codeMatch) {
      headingByCode.set(codeMatch[1], headingText);
    }
    continue;
  }
  const bullet = bulletPattern.exec(line);
  if (bullet === null) {
    continue;
  }
  const [, bold, rest] = bullet;
  const idMatch = idPattern.exec(bold);
  if (idMatch === null) {
    // Not a requirement bullet — e.g. `- **Gate:** ...` or `- **Gate (per
    // milestone):** ...`, which state exit criteria, not requirement ids.
    continue;
  }
  const [, id] = idMatch;
  const area = id.split('-')[0];
  bullets.push({ id, area, raw: rest });
}

function statementOf(raw) {
  return raw.trim();
}

// The requirement's own modality is its *first* RFC 2119 keyword, not any
// keyword occurring anywhere in the statement: several requirements (AGT-7
// is the one this matters for) state a SHOULD and then impose a MUST as a
// condition on something the SHOULD produces ("Every adopted refinement
// MUST pass AGT-6 evaluation"), which is a constraint on adoption, not the
// requirement's own priority. Scanning for MUST first — as an earlier
// version of this function did — promoted AGT-7 to `must`, contradicting
// REQUIREMENTS.md (CONV-2). "MUST NOT" and "SHOULD NOT" are matched before
// the bare form so the leftmost match at a given position is the longer,
// correct one.
const keywordPattern = /\b(MUST NOT|MUST|SHOULD NOT|SHOULD|MAY)\b/;

function priorityOf(statement) {
  const match = keywordPattern.exec(statement);
  if (match === null) return 'must';
  const keyword = match[1];
  if (keyword.startsWith('MUST')) return 'must';
  if (keyword.startsWith('SHOULD')) return 'should';
  return 'could';
}

// The only two bullets in REQUIREMENTS.md that state an actual number and
// unit (SCP-1: "non-functional requirements MUST carry quantified
// thresholds"). Every other NFR-* entry in §6 names a quality
// (reliability, cost visibility, security posture, portability) without a
// measurable value — inventing one here would assert something
// REQUIREMENTS.md never said, so those are carried as `functional`
// instead (see `rationale` below), which is the shape the schema allows a
// requirement with no quantified threshold to take at all.
const thresholds = {
  'NFR-3': {
    metric:
      'harness overhead (scheduling, context assembly, validation) as a share of total run wall-clock time',
    value: 10,
    unit: '%',
    measuredBy:
      'sum of scheduling, context-assembly and validation time divided by total run wall-clock time, over one run',
  },
  'NFR-6': {
    metric: 'wall-clock time from install to a first gated Definition artifact',
    value: 1,
    unit: 'hour',
    measuredBy:
      'wall-clock time from a fresh install to the Definition gate being approved, by a competent engineer who has not read harness source',
  },
};

// REQUIREMENTS.md assigns no acceptance criteria to any of its 84 bullets —
// it is prose stating a requirement's modality and behaviour, not a Scope
// artifact's per-requirement criteria list — but the schema demands at
// least one (`requirementCommon.acceptanceCriteria`, CONV-5: it cannot be
// represented without one). Rather than invent one, every requirement here
// carries its own statement as its sole criterion, and says so in its own
// `rationale` so a reader of one requirement sees the substitution without
// reading the artifact summary; deriving a genuine, independently-checkable
// criterion is Scope-revision work this migration does not do.
const acceptanceCriteriaNote =
  'REQUIREMENTS.md assigns no acceptance criteria; its statement stands as its own criterion pending a later Scope revision.';

const requirements = bullets.map(({ id, area, raw }) => {
  const statement = statementOf(raw);
  const priority = priorityOf(statement);
  const heading = headingByCode.get(area) ?? headingByCode.get(id) ?? 'REQUIREMENTS.md';
  const threshold = thresholds[id];

  const common = {
    id,
    statement,
    acceptanceCriteria: [statement],
    tracesTo: [`REQUIREMENTS.md — ${heading}`],
    priority,
  };

  if (threshold) {
    return {
      ...common,
      kind: 'non-functional',
      rationale: `Carried from REQUIREMENTS.md — ${heading}. Its threshold (${String(threshold.value)}${threshold.unit}) is the number REQUIREMENTS.md itself states; SCP-1 binds it to TST-3. ${acceptanceCriteriaNote}`,
      threshold,
    };
  }

  const isNfrArea = area === 'NFR';
  const rationale = isNfrArea
    ? `Carried from REQUIREMENTS.md — ${heading}. REQUIREMENTS.md states this quality but no measurable metric, value and unit for it; SCP-1's schema cannot represent a non-functional requirement without a quantified threshold, so this is carried as functional rather than with an invented number (a quantification gap for a later Scope revision to close, not this migration). ${acceptanceCriteriaNote}`
    : `Carried from REQUIREMENTS.md — ${heading}. ${acceptanceCriteriaNote}`;

  return {
    ...common,
    kind: 'functional',
    rationale,
  };
});

const outOfScope = [
  {
    item: 'Training or fine-tuning models',
    why: 'REQUIREMENTS.md §3 excludes it from v1 scope; the harness consumes hosted model APIs.',
  },
  {
    item: 'Hosting model inference',
    why: 'REQUIREMENTS.md §3 excludes it from v1 scope; inference is via provider APIs (EXT-2).',
  },
  {
    item: "Replacing the operator's judgment at gates",
    why: 'REQUIREMENTS.md §3 excludes it; HIL-1..HIL-5 keep gate and irreversible decisions with the operator.',
  },
  {
    item: 'Project management for non-software work',
    why: 'REQUIREMENTS.md §3 excludes it; PMG-1..PMG-4 project only the SDLC plan/implement loop onto GitHub.',
  },
  {
    item: 'Multi-tenant SaaS operation',
    why: 'REQUIREMENTS.md §3 excludes it; §8 decision 2 fixes v1 to a single operator.',
  },
];

const store = new ArtifactStore({ root, schemas: projectArtifactSchemas() });

const artifact = store.write({
  id: 'mpgm-scope',
  basePath: 'artifacts/scope/requirements.md',
  schema: 'scope',
  producedBy: {
    task: 'T4.3.1',
    role: 'implementer',
    model: 'claude-sonnet-5',
    runId: 'bootstrap',
  },
  tracesTo: ['SCP-1', 'SCP-2', 'SCP-3'],
  egress: 'internal',
  data: {
    summary:
      `mpgm's own requirement set (REQUIREMENTS.md v0.4), derived mechanically ` +
      `so the ${String(requirements.length)} ids REQUIREMENTS.md already assigns carry across ` +
      `unchanged (ORC-1, TST-5, OBS-4 and every other id any commit trailer, ` +
      `ADR or artifact already cites resolve against this artifact rather ` +
      `than against prose). REQUIREMENTS.md names no separate Definition ` +
      `artifact for mpgm's own project, so each requirement's tracesTo cites ` +
      `the REQUIREMENTS.md section it was derived from rather than a ` +
      `Definition id, the same "resolves against the document, not the ` +
      `trace index" reading artifacts/plan/plan.v1.md already uses for ids ` +
      `that predate their own artifacts. Two requirements (NFR-3, NFR-6) ` +
      `state an actual quantified threshold and are carried as ` +
      `non-functional with it; the other four §6 entries (NFR-1, NFR-2, ` +
      `NFR-4, NFR-5) name a quality with no measurable value in the source ` +
      `text, and are carried as functional rather than fitted with an ` +
      `invented number — see each one's rationale. REQUIREMENTS.md assigns ` +
      `no acceptance criteria to any of its ${String(requirements.length)} bullets; the schema ` +
      `demands at least one per requirement (CONV-5), so every requirement ` +
      `here carries its own statement as its sole acceptanceCriteria entry ` +
      `— stated per requirement in its own rationale — pending a later ` +
      `Scope revision to derive genuine, independently-checkable criteria.`,
    requirements,
    outOfScope,
  },
});

console.log(`wrote ${artifact.path}`);
console.log(`${String(requirements.length)} requirements`);
