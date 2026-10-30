// A deliberately small JSON Schema subset, shared by provider definitions and
// local runtime validation. Unknown fields are rejected, never silently coerced.
export interface Schema {
  description?: string;
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: false;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  enum?: (string | number | boolean)[];
  anyOf?: Schema[];
}
export const number: Schema = { type: 'number' };
export const integer: Schema = { type: 'integer', minimum: 0 };
export const string: Schema = { type: 'string' };
export const boolean: Schema = { type: 'boolean' };
export const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
export const enumeration = (...values: string[]): Schema => ({ type: 'string', enum: values });
export const array = (items: Schema, minItems = 0, maxItems = 100): Schema => ({
  type: 'array',
  items,
  minItems,
  maxItems,
});
export const object = (
  properties: Record<string, Schema>,
  required = Object.keys(properties),
): Schema => ({ type: 'object', properties, required, additionalProperties: false });
// Diagnostic protocol 2.0.0. Human text and structured fields describe the same
// failure; suggestions never supply or coerce business parameters.
export interface SchemaIssue {
  version: '2.0.0';
  kind: 'missing_field' | 'unknown_field' | 'type' | 'enum' | 'bounds';
  path: string;
  expected: string;
  suggestion: string;
}
function expected(schema: Schema): string {
  if (schema.anyOf) return schema.anyOf.map(expected).join(' | ');
  if (schema.enum) return `enum ${JSON.stringify(schema.enum)}`;
  return schema.type ?? 'declared type';
}
export class SchemaError extends Error {
  readonly issue: SchemaIssue;
  constructor(kind: SchemaIssue['kind'], path: string, schema: Schema, detail: string) {
    const expectation = expected(schema);
    const suggestion =
      kind === 'unknown_field'
        ? 'Remove the unknown field; use only the advertised schema.'
        : kind === 'missing_field'
          ? 'Supply this field from the current user/task or current session evidence; if unavailable, request clarification. Do not guess.'
          : 'Use the expected type/enum/bounds without coercion; preserve user interval, basis and side. If unavailable, request clarification.';
    super(`SCHEMA ${path}: ${detail}; expected ${expectation}. ${suggestion}`);
    this.name = 'SchemaError';
    this.issue = { version: '2.0.0', kind, path, expected: expectation, suggestion };
  }
}
export function validate(schema: Schema, value: unknown, path = '$'): void {
  if (schema.anyOf) {
    const failures: SchemaError[] = [];
    for (const option of schema.anyOf) {
      try {
        validate(option, value, path);
        return;
      } catch (error) {
        if (!(error instanceof SchemaError)) throw error;
        failures.push(error);
      }
    }
    // Preserve nested missing/enum diagnostics for the structurally matching
    // branch of a nullable object rather than reporting only "no matching type".
    const branch = schema.anyOf.findIndex((s) =>
      s.type === 'array'
        ? Array.isArray(value)
        : s.type === 'object'
          ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : s.type === typeof value,
    );
    if (branch >= 0) throw failures[branch];
    throw new SchemaError('type', path, schema, 'no matching type');
  }
  const fail = (kind: SchemaIssue['kind'] = 'type', detail = 'invalid value'): never => {
    throw new SchemaError(kind, path, schema, detail);
  };
  if (schema.enum && !schema.enum.includes(value as string)) fail('enum', 'invalid enum value');
  switch (schema.type) {
    case 'null':
      if (value !== null) fail();
      break;
    case 'boolean':
      if (typeof value !== 'boolean') fail();
      break;
    case 'string':
      if (typeof value !== 'string') fail();
      break;
    case 'number':
    case 'integer':
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (schema.type === 'integer' && !Number.isInteger(value))
      )
        fail();
      if (
        (schema.minimum !== undefined && (value as number) < schema.minimum) ||
        (schema.maximum !== undefined && (value as number) > schema.maximum)
      )
        fail(
          'bounds',
          `out of bounds [${schema.minimum ?? '-Infinity'}, ${schema.maximum ?? 'Infinity'}]`,
        );
      break;
    case 'array':
      if (!Array.isArray(value)) return fail();
      if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity))
        fail(
          'bounds',
          `array length must be between ${schema.minItems ?? 0} and ${schema.maxItems ?? 'unbounded'}`,
        );
      value.forEach((v, i) => validate(schema.items!, v, `${path}[${i}]`));
      break;
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? [])
        if (!Object.hasOwn(record, key))
          throw new SchemaError(
            'missing_field',
            `${path}.${key}`,
            schema.properties![key],
            `missing field ${key}`,
          );
      for (const [key, v] of Object.entries(record)) {
        if (!Object.hasOwn(schema.properties ?? {}, key))
          throw new SchemaError('unknown_field', `${path}.${key}`, schema, `unknown field ${key}`);
        validate(schema.properties![key], v, `${path}.${key}`);
      }
      break;
    }
    default:
      fail();
  }
}
