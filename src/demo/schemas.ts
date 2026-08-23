import { z } from 'zod';
import { OutputSchemaRegistry } from '../agent/output-registry.js';

/** Output schema for the toy role used by the M1.2 verification demo. */
export const toySummarySchema = z.object({
  summary: z.string().min(1),
  requirements: z.array(z.string().min(1)).min(1),
});

export function demoSchemaRegistry(): OutputSchemaRegistry {
  return new OutputSchemaRegistry({ 'toy.summary.v1': toySummarySchema });
}
