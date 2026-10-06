import { z } from 'zod';
import { FixSchema } from './fixes.js';
import { DesignSchema } from './schema.js';

/**
 * JSON Schema (draft 2020-12) versions of the Zod schemas, e.g. to describe the design format
 * to an LLM or to validate files in other languages. Generated from the Zod schemas, so they
 * always match what parseDesign / applyFixes accept.
 *
 * `io: 'input'` describes what a user (or model) may write: fields with defaults are optional.
 */
export type JsonSchema = Record<string, unknown>;

let designSchema: JsonSchema | undefined;
let fixSchema: JsonSchema | undefined;

export function designJsonSchema(): JsonSchema {
  return (designSchema ??= z.toJSONSchema(DesignSchema, { io: 'input' }) as JsonSchema);
}

export function fixJsonSchema(): JsonSchema {
  return (fixSchema ??= z.toJSONSchema(FixSchema, { io: 'input' }) as JsonSchema);
}
