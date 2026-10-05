import { ensureRuntime } from "microsandbox";

const runtime = await ensureRuntime();
console.log(`Microsandbox runtime ready (${runtime.origin}): ${runtime.msbPath}`);
