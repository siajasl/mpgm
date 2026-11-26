#!/usr/bin/env node
/** Operator console entry point. Wiring only; the verbs live in src/cli. */
// T4.3.25: refuses before this script loads a stale dist/.
import './dist-freshness.mjs';
import {
  ClaudeAgentProvider,
  projectArtifactSchemas,
  projectOutputSchemas,
  runCli,
  TerminalIo,
} from '../dist/index.js';

const result = await runCli(process.argv.slice(2), {
  root: process.cwd(),
  provider: new ClaudeAgentProvider(),
  io: new TerminalIo(),
  outputSchemas: projectOutputSchemas(),
  artifactSchemas: projectArtifactSchemas(),
  write: (line) => process.stdout.write(`${line}\n`),
});

process.exit(result.ok ? 0 : 1);
