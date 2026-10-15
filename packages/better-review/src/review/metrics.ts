/** Process-local observations, not durable billing/accounting. Names are deliberately closed:
 * accepting arbitrary labels here could retain or log commands, prompts, or paths.
 */
const names = new Set([
  "snapshot.hydrate.ms",
  "snapshot.hydrated.entries",
  "snapshot.project.ms",
  "stream.project.ms",
  "stream.update.bytes",
  "stream.snapshot.bytes",
  "sandbox.evictions",
  "sandbox.create.ms",
  "sandbox.setup.ms",
  "sandbox.cleanup.ms",
  "sandbox.exec.ms",
  "sandbox.output.bytes",
  "sandbox.read.ms",
  "sandbox.acquire.ms",
  "sandbox.cold.acquire.ms",
  "sandbox.warm.acquire.ms",
  "tool.duration.ms",
  "tool.output.bytes",
  "tool.truncated",
  "tool.repeated",
  "tool.cache_hit",
  "tool.errors",
  "review.model.round_trips",
  "review.tool.round_trips",
  "review.tokens.input",
  "review.tokens.output",
  "review.tokens.cache_read",
  "review.tokens.cache_write",
  "review.tokens.total",
  "review.duration.ms",
  "review.resume.duration.ms",
]);

const measurements = new Map<
  string,
  { count: number; total: number; max: number; recent: number[] }
>();

export function measure(name: string, value: number) {
  if (!names.has(name) || !Number.isFinite(value) || value < 0) return;
  const metric = measurements.get(name) ?? { count: 0, total: 0, max: 0, recent: [] };
  metric.count++;
  metric.total += value;
  metric.max = Math.max(metric.max, value);
  metric.recent.push(value);
  if (metric.recent.length > 128) metric.recent.shift();
  measurements.set(name, metric);
  if (process.env.BETTER_REVIEW_METRICS === "1")
    console.info(`[review-perf] ${name}=${value.toFixed(2)}`);
}

export function startMeasurement(name: string) {
  const start = performance.now();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    measure(`${name}.ms`, performance.now() - start);
  };
}

export function reviewMetrics() {
  return Object.fromEntries(
    [...measurements].map(([name, metric]) => {
      const sorted = [...metric.recent].sort((a, b) => a - b);
      return [
        name,
        {
          count: metric.count,
          total: metric.total,
          mean: metric.total / metric.count,
          max: metric.max,
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
        },
      ];
    }),
  );
}
