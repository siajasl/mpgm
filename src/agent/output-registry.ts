import { z, type ZodType } from 'zod';

/**
 * Output schemas, keyed by the id a role's `output.schema` names.
 *
 * The zod schema is the single source of truth: the JSON Schema handed to the
 * SDK is derived from it, and the same zod schema validates whatever comes
 * back. Maintaining two hand-written schemas would let them drift, and the
 * drift would show up as a model that satisfies the SDK and fails the kernel.
 */
export class OutputSchemaRegistry {
  readonly #schemas: ReadonlyMap<string, ZodType>;

  constructor(schemas: Readonly<Record<string, ZodType>>) {
    this.#schemas = new Map(Object.entries(schemas));
  }

  get ids(): readonly string[] {
    return [...this.#schemas.keys()].sort();
  }

  has(id: string): boolean {
    return this.#schemas.has(id);
  }

  get(id: string): ZodType {
    const schema = this.#schemas.get(id);
    if (schema === undefined) {
      throw new Error(
        `no output schema registered as '${id}'. Registered: ${this.ids.join(', ') || '(none)'}`,
      );
    }
    return schema;
  }

  /** JSON Schema for the SDK's structured-output format. */
  jsonSchema(id: string): Record<string, unknown> {
    return z.toJSONSchema(this.get(id));
  }
}
