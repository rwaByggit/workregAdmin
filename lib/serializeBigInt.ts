export function serializeBigInt(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeBigInt);

  if (typeof value === 'object') {
    const objectValue = value as { toJSON?: () => unknown; [key: string]: unknown };
    if (typeof objectValue.toJSON === 'function') {
      return serializeBigInt(objectValue.toJSON());
    }

    const serialized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(objectValue)) {
      serialized[key] = serializeBigInt(nestedValue);
    }
    return serialized;
  }

  return value;
}
