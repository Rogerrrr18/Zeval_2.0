/**
 * @fileoverview Small async concurrency helpers shared by evaluation stages.
 */

/**
 * Map items with a bounded number of concurrent async workers.
 * Results keep the same order as the input list.
 *
 * @param items Input items.
 * @param concurrency Maximum concurrent operations.
 * @param mapper Async mapper.
 * @returns Mapped results.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Resolve a positive integer environment override.
 *
 * @param value Raw environment value.
 * @param fallback Fallback when the value is absent or invalid.
 * @returns Positive integer.
 */
export function resolvePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

