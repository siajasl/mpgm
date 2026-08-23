import { createInterface } from 'node:readline/promises';
import type { OperatorIo } from './session.js';

/** Reads the operator's answers from the terminal. */
export class TerminalIo implements OperatorIo {
  async ask(question: string, rationale: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (rationale.trim() !== '') {
        process.stdout.write(`\n  (${rationale.trim()})\n`);
      }
      return (await rl.question(`\n${question}\n> `)).trim();
    } finally {
      rl.close();
    }
  }

  notify(message: string): void {
    process.stdout.write(`${message}\n`);
  }
}

/** Replays scripted answers. Used by tests and by the M1.3 demo. */
export class ScriptedIo implements OperatorIo {
  readonly #answers: string[];
  readonly asked: { question: string; rationale: string }[] = [];
  readonly notices: string[] = [];

  constructor(answers: readonly string[]) {
    this.#answers = [...answers];
  }

  ask(question: string, rationale: string): Promise<string> {
    this.asked.push({ question, rationale });
    const next = this.#answers.shift();
    if (next === undefined) {
      throw new Error(`ScriptedIo ran out of answers at: ${question}`);
    }
    return Promise.resolve(next);
  }

  notify(message: string): void {
    this.notices.push(message);
  }
}
