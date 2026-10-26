export function createAssertions(timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("Assertion wait timeout must be finite and positive");
  let passed = 0;
  function check(value: unknown, message: string) {
    if (!value) throw new Error(message);
    if (passed === Number.MAX_SAFE_INTEGER)
      throw new RangeError("Assertion count exceeds safe integer range");
    passed++;
  }
  async function wait(predicate: () => boolean, message: string) {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (predicate()) {
        check(true, message);
        return;
      }
      if (performance.now() >= deadline) throw new Error(message);
      await new Promise(requestAnimationFrame);
    }
  }
  return { check, wait, result: () => ({ passed }) };
}
