import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `.github/workflows/dependency-audit-trunk.yml`'s truncation logic (T4.3.16
 * review, round 2), extracted straight out of the real workflow file and run
 * through `bash` rather than duplicated here — so a future edit to the
 * workflow that reintroduces a pipe is caught by this test reading the
 * actual file, not by a copy of it going stale.
 *
 * The step this guards runs under `set -euo pipefail` and files or comments
 * on a tracking issue with the audit report embedded in its body. GitHub
 * rejects an issue body over 65,536 characters, so a multi-advisory round
 * (T4.3.14 carried seven) needs the report truncated first. The fix this
 * test exercises uses plain bash parameter-expansion substring truncation
 * (`${REPORT:0:$REPORT_LIMIT}`), which has nothing to fail under
 * `pipefail`. The shape it replaced piped `head -c` into a command
 * substitution assignment: `head` closing the pipe early on a long input
 * sends `printf` SIGPIPE, `printf` exits 141, and `set -o pipefail` makes
 * that 141 the whole assignment's exit status — fatal under `set -e`,
 * killing the step before `gh issue create`/`comment` ever ran. Confirmed by
 * hand against that exact shape before this fix existed: the equivalent
 * `REPORT="$(printf '%s' "$REPORT" | head -c "$REPORT_LIMIT")..."` exits 141
 * on a report past the limit.
 */

const WORKFLOW = resolve(
  import.meta.dirname,
  '../../.github/workflows/dependency-audit-trunk.yml',
);

/**
 * Pulls the truncation block (`REPORT_LIMIT=20000` through its closing
 * `fi`) out of the real workflow file, so this test runs the actual script
 * CI runs rather than a copy that can drift from it.
 */
function extractTruncationBlock(): string {
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const match = /REPORT_LIMIT=20000[\s\S]*?\n[ \t]*fi\n/.exec(yaml);
  if (match === null) {
    throw new Error(
      `could not find the truncation block ('REPORT_LIMIT=20000' ... 'fi') in ` +
        `${WORKFLOW} — the workflow step this test guards may have been ` +
        `restructured; update the extraction regex to match`,
    );
  }
  return match[0];
}

function runTruncation(reportLength: number): { code: number; output: string } {
  const script = [
    'set -euo pipefail',
    `REPORT="$(head -c ${String(reportLength)} /dev/zero | tr '\\0' 'a')"`,
    'RUN_URL="https://example.invalid/run/1"',
    extractTruncationBlock(),
    'echo "LEN:${#REPORT}"',
    'echo "TAIL:${REPORT: -70}"',
  ].join('\n');
  try {
    return {
      code: 0,
      output: execFileSync('bash', ['-c', script], { encoding: 'utf8' }),
    };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string; stdout?: string };
    return {
      code: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

describe('dependency-audit-trunk.yml truncation', () => {
  // The shape this guards: a report well past GitHub's issue-body limit
  // must still let the step finish (so `gh issue create`/`comment` run)
  // rather than killing it under `set -euo pipefail`. Fails against the
  // `head -c | printf` pipe this replaced, which exits 141 on exactly this
  // input (confirmed by hand — see the module doc above).
  it('truncates a report past the limit without failing the step under pipefail', () => {
    // Large enough to exceed a pipe's kernel buffer (Linux's default is
    // 65536 bytes) — the `head -c | printf` shape this replaced only
    // raised SIGPIPE/exit 141 once the write could not complete in one
    // syscall before `head` closed its end; a report merely over
    // `REPORT_LIMIT` but still under that buffer size passed either way,
    // which is exactly why the earlier shape went unnoticed until a round
    // with enough advisories (T4.3.14's seven) produced one this large.
    const result = runTruncation(200000);
    expect(result.code).toBe(0);
    expect(result.output).toContain('20000 characters');
    const lenMatch = /LEN:(\d+)/.exec(result.output);
    expect(lenMatch).not.toBeNull();
    // Truncated to the limit, plus the note appended after it — still far
    // short of the original 200000, and nowhere near GitHub's
    // 65,536-character issue-body limit.
    expect(Number(lenMatch?.[1])).toBeGreaterThan(20000);
    expect(Number(lenMatch?.[1])).toBeLessThan(20200);
  });

  it('leaves a report at or under the limit untouched', () => {
    const result = runTruncation(100);
    expect(result.code).toBe(0);
    expect(result.output).toContain('LEN:100');
    expect(result.output).not.toContain('20000 characters');
  });
});
