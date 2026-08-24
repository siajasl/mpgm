#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defaultValueRules } from '../dist/index.js';

/**
 * Secret scanning for the `scan` merge check (SAF-5).
 *
 * The patterns are the *same* ones the kernel redacts with at log-write time
 * (SAF-6). That is the whole reason this is a script in this repository rather
 * than an off-the-shelf scanner: one definition of what a credential looks
 * like, used both to keep secrets out of the log and to keep them out of the
 * repository. A pattern added for one is a pattern added for the other.
 *
 * A line ending in `mpgm-secret-scan: allow` is skipped, which is how the
 * rules themselves and their tests survive being scanned. The marker has to be
 * written deliberately on the offending line, so nothing is exempted quietly.
 */

const ALLOW = 'mpgm-secret-scan: allow';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((path) => path !== '');

const findings = [];

for (const path of tracked) {
  if (path === 'scripts/scan-secrets.mjs') {
    continue;
  }
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    continue; // unreadable or binary; nothing to match against
  }
  if (content.includes('\0')) {
    continue;
  }
  const lines = content.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.includes(ALLOW)) {
      continue;
    }
    for (const rule of defaultValueRules) {
      // The rules are global regexes and therefore stateful; reset before use.
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(line)) {
        findings.push({ path, line: index + 1, rule: rule.name });
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`secret scan found ${findings.length} match(es):\n`);
  for (const finding of findings) {
    console.error(`  ${finding.path}:${finding.line}  ${finding.rule}`);
  }
  console.error(
    `\nIf a match is a deliberate example, end the line with '${ALLOW}'.\n` +
      `If it is a real credential, rotate it — it is in the repository history.`,
  );
  process.exit(1);
}

console.log(
  `secret scan clean (${tracked.length} tracked files, ${defaultValueRules.length} rules)`,
);
