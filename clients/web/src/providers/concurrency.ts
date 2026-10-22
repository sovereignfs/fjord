/**
 * Run `work` over `items` with at most `limit` in flight, keeping results in the order of the
 * items. A commit of forty files uploads four blobs at a time, not forty at once (a host limits
 * how many requests may be open) and not one after another (that is slow). The first failure
 * rejects, and no new item is started after it.
 */
export async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      while (next < items.length && !failed) {
        const index = next++;
        try {
          results[index] = await work(items[index]!);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  return results;
}
