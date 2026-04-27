/**
 * Serializes LanceDB mutations (and related local writes) across concurrent tool calls.
 */
let chain: Promise<unknown> = Promise.resolve();

export async function withDbWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = () => fn();
  const next = chain.then(run, run);
  chain = next.then(
    () => undefined,
    () => undefined
  );
  return next as Promise<T>;
}
