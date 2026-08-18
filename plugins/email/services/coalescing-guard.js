/**
 * Generic coalescing re-entrancy guard: wraps an async function so that
 * calling it while a previous call is still in flight does not start a
 * second, overlapping call. Instead it records that another run was
 * requested, and once the in-flight one finishes it runs exactly one more
 * time (not once per extra call) before settling — so nothing requested
 * during the run is dropped, without ever having two calls of `fn` active
 * at once. All callers while a run is in flight (or queued) share the same
 * returned promise.
 *
 * Kept dependency-free and side-effect-free (beyond calling `fn`) so it is
 * unit-testable without whatever `fn` itself depends on.
 *
 * @param {(...args: any[]) => Promise<void>} fn
 * @returns {(...args: any[]) => Promise<void>} the guarded trigger function
 */
function createCoalescingGuard(fn) {
  let active = null;
  let queued = false;

  return function trigger(...args) {
    if (active) {
      queued = true;
      return active;
    }
    active = (async () => {
      do {
        queued = false;
        await fn(...args);
      } while (queued);
    })().finally(() => {
      active = null;
    });
    return active;
  };
}

module.exports = { createCoalescingGuard };
