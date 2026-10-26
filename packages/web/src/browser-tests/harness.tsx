import "../index.css";

const modules = import.meta.glob<Record<string, unknown>>("../**/*.browser.{ts,tsx}");
const appModes = ["navigation", "prefill", "links", "inline", "dismissal", "source"] as const;
type Test = {
  file: string;
  name: string;
  mode?: (typeof appModes)[number];
  kind?: "trusted-dismissal";
};
let dismissal: { closes: () => number; dispose: () => void } | undefined;

async function list(): Promise<Test[]> {
  const tests: Test[] = [];
  for (const file of Object.keys(modules).sort()) {
    const exports = await modules[file]();
    for (const name of Object.keys(exports).sort()) {
      if (!/^test.*InBrowser$/.test(name) || typeof exports[name] !== "function") continue;
      if (name === "testAppAnnotationNavigationInBrowser") {
        for (const mode of appModes) tests.push({ file, name, mode });
      } else tests.push({ file, name });
    }
  }
  if (!tests.length) throw new Error("No browser tests discovered");
  tests.push({
    file: "../design-system/message-behavior.browser.tsx",
    name: "mountDismissalFixtureInBrowser",
    kind: "trusted-dismissal",
  });
  return tests;
}

async function run(test: Test) {
  if (test.name === "testAppAnnotationNavigationInBrowser") {
    const { mountAppFixture } = await import("./mount-app");
    await mountAppFixture();
  }
  const exports = await modules[test.file]();
  const fn = exports[test.name] as (mode?: string) => unknown;
  const result = await fn(test.mode);
  if (
    !result ||
    typeof result !== "object" ||
    !("passed" in result) ||
    typeof result.passed !== "number" ||
    !Number.isSafeInteger(result.passed) ||
    result.passed <= 0
  )
    throw new Error(`${test.name} did not report assertions`);
  return result;
}

Object.assign(window, {
  browserTests: {
    list,
    run,
    async mountDismissal() {
      const { mountDismissalFixtureInBrowser } =
        await import("../design-system/message-behavior.browser");
      dismissal = mountDismissalFixtureInBrowser();
    },
    dismissalCount: () => dismissal?.closes(),
    disposeDismissal: () => dismissal?.dispose(),
  },
});
