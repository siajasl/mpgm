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

export interface ScriptedIoOptions {
  /**
   * Answer given once the script is spent.
   *
   * How many questions the analyst asks is the model's decision, bounded only
   * by `maxQuestions` — so a fixture holding one answer per expected question
   * breaks whenever the dialogue takes a turn nobody wrote down, and breaks by
   * throwing in the middle of the phase. A real operator does not run out of
   * answers; they say they do not know, which the dialogue already handles by
   * recording an open assumption (DEF-1).
   *
   * Omitted means the old behaviour: exhaustion throws. That is what a test
   * asserting an exact number of questions wants, because a fallback would
   * turn the assertion into one that cannot fail.
   */
  readonly whenExhausted?: string;
}

/** Replays scripted answers. Used by tests and by the M1.3 demo. */
export class ScriptedIo implements OperatorIo {
  readonly #answers: string[];
  readonly #whenExhausted: string | undefined;
  readonly asked: { question: string; rationale: string }[] = [];
  /**
   * Questions the script had no answer for.
   *
   * Kept so the fallback is visible rather than silent: a run where it carried
   * most of the dialogue is one whose fixture no longer describes the project,
   * and a caller that cannot see that would report a passing demo.
   */
  readonly unscripted: string[] = [];
  readonly notices: string[] = [];

  constructor(answers: readonly string[], options: ScriptedIoOptions = {}) {
    this.#answers = [...answers];
    this.#whenExhausted = options.whenExhausted;
  }

  ask(question: string, rationale: string): Promise<string> {
    this.asked.push({ question, rationale });
    const next = this.#answers.shift();
    if (next !== undefined) {
      return Promise.resolve(next);
    }
    if (this.#whenExhausted === undefined) {
      throw new Error(`ScriptedIo ran out of answers at: ${question}`);
    }
    this.unscripted.push(question);
    return Promise.resolve(this.#whenExhausted);
  }

  notify(message: string): void {
    this.notices.push(message);
  }
}
