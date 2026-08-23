#!/usr/bin/env node
/** Operator console entry point. Wiring only; the verbs live in src/cli. */
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
