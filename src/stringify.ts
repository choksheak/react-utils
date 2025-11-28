/**
 * @packageDocumentation
 *
 * Implements special stringify for use in the shared queries. This will likely
 * not be reusable for your own use cases.
 *
 * Normally you will not need to use this module directly, but if you have a
 * need for it, feel free to use it.
 */

/**
 * JSON stringify a value of any type, and returns an unsafe string. The string
 * is "unsafe" because you might not be able to restore the original object
 * using the serialized JSON. This is specifically used for query key generation
 * and is not suitable for more general uses.
 *
 * Note: The given value should not contain any functions because functions
 * cannot be serialized and deserialized properly.
 */
export function stringifyDeterministicForKeys(params: unknown): string {
  const cache = new Set();

  return JSON.stringify(params, (_, value) => {
    if (typeof value === "function") {
      throw new Error(`Functions should not be passed into query parameters`);
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }

    if (cache.has(value)) {
      // Circular reference detected! Return a placeholder string.
      return "[Circular]";
    }

    cache.add(value);

    // Don't crash on circular references, but don't mark the top level object
    // as circular because we want to return as much string as possible.
    if (value !== params) {
      try {
        JSON.stringify(value);
      } catch {
        return "[Unserializable]";
      }
    }

    return Object.keys(value)
      .sort()
      .reduce(
        (result: Record<string, unknown>, key: string) => {
          result[key] = value[key];
          return result;
        },
        {} as Record<string, unknown>,
      );
  });
}
