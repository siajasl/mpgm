import { z } from 'zod';
import type { AgentSessionProvider, SessionRequest } from '../agent/session.js';
import type { Role } from '../role/definition.js';

/**
 * Operator elicitation (DEF-1, DESIGN §4.2).
 *
 * A structured dialogue that ends in a Definition artifact. Each turn is an
 * ordinary session whose structured output is either the next question or the
 * finished conclusions — so interactivity does not bypass validation or audit,
 * which is the property DESIGN §4.2 asks for.
 *
 * The dialogue's own transcript is its input. That is not a CTX-2 violation:
 * CTX-2 forbids building context from *another agent's* transcript, and this
 * is the operator's own conversation, which is the material being elicited.
 */

/** One exchange in the dialogue. */
export const exchangeSchema = z.object({
  question: z.string().min(1),
  answer: z.string(),
});

export type Exchange = z.infer<typeof exchangeSchema>;

/** The elicitation output: the Definition artifact's fields (DEF-1). */
export const conclusionsSchema = z.object({
  problem: z.string().min(1),
  goals: z.array(z.string().min(1)).min(1),
  nonGoals: z.array(z.string()),
  stakeholders: z.array(z.string()),
  constraints: z.array(z.string()),
  assumptions: z.array(z.string()),
  successMetrics: z.array(z.string().min(1)).min(1),
});

export type Conclusions = z.infer<typeof conclusionsSchema>;

/**
 * What a turn produced: another question, or the conclusions.
 *
 * A discriminated union rather than two schemas, so the model cannot return
 * something that is neither and have it pass validation.
 */
export const elicitationTurnSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('question'),
    question: z.string().min(1),
    /** Why this is being asked, shown to the operator. */
    rationale: z.string().default(''),
  }),
  z.object({ kind: z.literal('conclusions'), conclusions: conclusionsSchema }),
]);

export type ElicitationTurn = z.infer<typeof elicitationTurnSchema>;

/**
 * What a session actually returns.
 *
 * The union lives under a key because a structured-output tool schema must be
 * an object at its top level; a bare union has no `type` and the API refuses
 * it. Wrapping keeps the discrimination — a result that is neither a question
 * nor conclusions still cannot validate.
 */
export const elicitationOutputSchema = z.object({ turn: elicitationTurnSchema });

/** How the harness talks to the operator. */
export interface OperatorIo {
  ask(question: string, rationale: string): Promise<string>;
  notify(message: string): void;
}

export interface ElicitationOptions {
  readonly provider: AgentSessionProvider;
  readonly role: Role;
  readonly io: OperatorIo;
  /** Opening statement of intent from the operator, if any. */
  readonly brief?: string;
  /**
   * Maximum questions before the dialogue is cut off. Bounded for the same
   * reason sessions are: an elicitation that will not converge should stop
   * and say so rather than continue indefinitely.
   */
  readonly maxQuestions?: number;
}

export const DEFAULT_MAX_QUESTIONS = 12;

export interface ElicitationResult {
  readonly conclusions: Conclusions;
  readonly transcript: readonly Exchange[];
  readonly turns: number;
}

export class ElicitationError extends Error {}

function renderTranscript(transcript: readonly Exchange[]): string {
  if (transcript.length === 0) {
    return '(nothing asked yet)';
  }
  return transcript
    .map((exchange) => `Q: ${exchange.question}\nA: ${exchange.answer}`)
    .join('\n\n');
}

/**
 * Run the dialogue to completion.
 *
 * Returns the structured conclusions and the transcript. Writing either to an
 * artifact is the caller's job — the artifact store owns versioning and gate
 * immutability, and this has no business duplicating it.
 */
export async function elicit(options: ElicitationOptions): Promise<ElicitationResult> {
  const maxQuestions = options.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
  if (maxQuestions < 1) {
    throw new ElicitationError('maxQuestions must be at least 1');
  }

  const transcript: Exchange[] = [];
  const outputJsonSchema = toJsonSchema();

  for (let turn = 1; turn <= maxQuestions + 1; turn += 1) {
    const request: SessionRequest = {
      model: options.role.model,
      systemPrompt: options.role.systemPrompt,
      prompt: [
        options.brief === undefined || options.brief.trim() === ''
          ? '## Operator brief\n\n(none supplied)'
          : `## Operator brief\n\n${options.brief.trim()}`,
        '',
        '## Dialogue so far',
        '',
        renderTranscript(transcript),
        '',
        '## Your turn',
        '',
        transcript.length >= maxQuestions
          ? 'You have reached the question limit. Return your conclusions now, ' +
            'marking anything still unknown as an assumption.'
          : 'Ask the single most useful next question, or return your conclusions ' +
            'if you have enough to state the problem, goals, non-goals, ' +
            'stakeholders, constraints, assumptions and success metrics.',
      ].join('\n'),
      allowedTools: options.role.tools.allow,
      maxTurns: options.role.budgets.steps,
      maxBudgetUsd: options.role.budgets.costUsd,
      outputJsonSchema,
    };

    const result = await options.provider.run(request);
    if (result.termination !== 'completed') {
      throw new ElicitationError(
        `elicitation session ended: ${result.termination}${result.errorMessage ? ` — ${result.errorMessage}` : ''}`,
      );
    }

    const parsed = elicitationOutputSchema.safeParse(result.structuredOutput);
    if (!parsed.success) {
      throw new ElicitationError(
        `elicitation turn ${String(turn)} returned an unusable result: ` +
          parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; '),
      );
    }

    const next = parsed.data.turn;
    if (next.kind === 'conclusions') {
      return { conclusions: next.conclusions, transcript, turns: turn };
    }

    const answer = await options.io.ask(next.question, next.rationale);
    transcript.push({ question: next.question, answer });
  }

  // Reached only if the model kept asking after being told to conclude.
  throw new ElicitationError(
    `elicitation did not converge within ${String(maxQuestions)} questions`,
  );
}

function toJsonSchema(): Record<string, unknown> {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(elicitationOutputSchema);
  return schema;
}
