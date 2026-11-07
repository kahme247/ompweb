/**
 * Coalesce concurrent work for one key: callers that arrive while a run is in
 * flight share its promise instead of starting a second run (the usage report
 * scan is expensive and must not be started once per request).
 *
 * `shared` tells a caller whether it joined an existing run, which is what the
 * usage route uses to decide between "computed for this request" and "served
 * from cache while this refresh finishes".
 */
export function runSingleFlight<T>(
  flights: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): { promise: Promise<T>; shared: boolean } {
  const existing = flights.get(key);
  if (existing) return { promise: existing, shared: true };

  // The run starts in a microtask so the map holds the promise BEFORE any user
  // code can throw: a synchronous throw must still release the slot instead of
  // leaving a rejected promise that poisons every later caller. The finally
  // deletes only its own entry, never a successor's.
  const promise = Promise.resolve()
    .then(run)
    .finally(() => {
      if (flights.get(key) === promise) flights.delete(key);
    });
  flights.set(key, promise);
  return { promise, shared: false };
}
