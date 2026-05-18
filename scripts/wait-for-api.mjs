const apiPort = process.env.API_PORT ?? "3001";
const apiUrl = process.env.BETTER_REVIEW_API_URL ?? `http://127.0.0.1:${apiPort}`;
const healthcheckUrl = `${apiUrl.replace(/\/+$/, "")}/api/sessions/healthcheck`;
const timeoutMs = Number(process.env.BETTER_REVIEW_API_WAIT_TIMEOUT_MS ?? 30_000);
const startedAt = Date.now();

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

while (Date.now() - startedAt < timeoutMs) {
  const response = await fetch(healthcheckUrl).catch(() => null);
  if (response?.ok) {
    console.log(`[dev] API is ready at ${apiUrl}`);
    process.exit(0);
  }

  await sleep(250);
}

throw new Error(`Timed out waiting for API at ${apiUrl}`);
