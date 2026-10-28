import type { AgentTool } from "../../../packages/core/src/agent-runtime";

interface DemoAddInput {
  a: number;
  b: number;
}

export function createDemoAddTool(): AgentTool {
  return {
    definition: {
      name: "demo.add",
      description: "Adds two finite numbers and returns their sum.",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
        additionalProperties: false,
      },
    },
    validateInput(input): boolean {
      return isDemoAddInput(input);
    },
    async execute(input): Promise<string> {
      if (!isDemoAddInput(input)) {
        throw new Error("Invalid demo.add input.");
      }
      const sum = input.a + input.b;
      if (!Number.isFinite(sum)) {
        throw new Error("demo.add result is outside the finite number range.");
      }
      return String(sum);
    },
  };
}

function isDemoAddInput(input: unknown): input is DemoAddInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  return Object.keys(record).length === 2 &&
    Object.hasOwn(record, "a") && Number.isFinite(record.a) &&
    Object.hasOwn(record, "b") && Number.isFinite(record.b);
}
