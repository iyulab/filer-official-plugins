const test = require('node:test');
const assert = require('node:assert/strict');
const { createCoalescingGuard } = require('./coalescing-guard.js');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('createCoalescingGuard runs fn once for a single call', async () => {
  let calls = 0;
  const guarded = createCoalescingGuard(async () => { calls++; });
  await guarded();
  assert.equal(calls, 1);
});

test('overlapping calls while one is in flight coalesce into exactly one extra run', async () => {
  let calls = 0;
  const gate = deferred();
  const guarded = createCoalescingGuard(async () => {
    calls++;
    if (calls === 1) await gate.promise; // hold the first call open
  });

  const first = guarded();
  // Three more calls arrive while the first is still in flight.
  const second = guarded();
  const third = guarded();
  const fourth = guarded();
  assert.equal(second, first, 'overlapping callers share the same in-flight promise');
  assert.equal(third, first);
  assert.equal(fourth, first);
  assert.equal(calls, 1, 'no second call has started yet — the first has not resolved');

  gate.resolve();
  await first;

  // Exactly one coalesced re-run, not three (one per overlapping caller).
  assert.equal(calls, 2);
});

test('a call after the guard has settled starts a genuinely new run', async () => {
  let calls = 0;
  const guarded = createCoalescingGuard(async () => { calls++; });
  await guarded();
  await guarded();
  assert.equal(calls, 2);
});

test('a rejection propagates to the awaiting caller and still clears the guard for the next call', async () => {
  let attempt = 0;
  const guarded = createCoalescingGuard(async () => {
    attempt++;
    if (attempt === 1) throw new Error('boom');
  });

  await assert.rejects(guarded(), /boom/);
  // The guard must not be permanently wedged by a rejection.
  await guarded();
  assert.equal(attempt, 2);
});
