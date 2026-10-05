import assert from "node:assert/strict";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { defineTool, init, useModel, useTool } from "@flue/runtime";
import { start } from "@flue/runtime/node";

test("Flue preserves instructions and tools across a pi-ai 1 tool-call round trip", async () => {
  let toolCalls = 0;
  const instructions = "Call compatibility_probe, then report its result.";
  const provider = fauxProvider({ provider: "compatibility", models: [{ id: "test" }] });
  provider.setResponses([
    (context) => {
      assert.ok(getCurrentSystemPrompt(context.messages).includes(instructions));
      assert.ok(
        getCurrentTools(context.messages).some((tool) => tool.name === "compatibility_probe"),
      );
      return fauxAssistantMessage(fauxToolCall("compatibility_probe", {}), {
        stopReason: "toolUse",
      });
    },
    (context) => {
      assert.ok(
        context.messages.some(
          (message) =>
            message.role === "toolResult" &&
            message.toolName === "compatibility_probe" &&
            message.content.some((part) => part.type === "text" && part.text.includes("probe OK")),
        ),
      );
      return fauxAssistantMessage("Compatibility OK");
    },
  ]);

  function CompatibilityAgent() {
    useModel("compatibility/test");
    useTool(
      defineTool({
        name: "compatibility_probe",
        description: "Return a deterministic compatibility result.",
        run: async () => {
          toolCalls++;
          return "probe OK";
        },
      }),
    );
    return instructions;
  }

  const runtime = await start({
    agents: [CompatibilityAgent],
    providers: [provider.provider],
  });
  try {
    const agent = init(CompatibilityAgent);
    const receipt = await agent.dispatch("Check compatibility.");
    const reply = await agent.read(receipt, { signal: AbortSignal.timeout(10_000) });
    assert.equal(reply.text, "Compatibility OK");
    assert.equal(toolCalls, 1);
    assert.equal(provider.state.callCount, 2);
  } finally {
    await runtime.stop();
  }
});
