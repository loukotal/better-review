/** Bounded process-local measurements; no prompts, commands, or paths are recorded. */
const measurements = new Map<
  string,
  { count: number; total: number; max: number; recent: number[] }
>();

export function measure(name: string, value: number) {
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
  return () => measure(`${name}.ms`, performance.now() - start);
}

export function reviewMetrics() {
  return Object.fromEntries(
    [...measurements].map(([name, metric]) => {
      const sorted = [...metric.recent].sort((a, b) => a - b);
      return [
        name,
        {
          count: metric.count,
          mean: metric.total / metric.count,
          max: metric.max,
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
        },
      ];
    }),
  );
}
