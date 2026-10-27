import type { TextGenerationProvider } from "../../core/src/agent-runtime";
import type { Message } from "../../core/src/session";

export class FakeProvider implements TextGenerationProvider {
  async generate(messages: readonly Message[]): Promise<string> {
    const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
    if (lastUserMessage === undefined) {
      throw new Error("The fake provider requires at least one user message.");
    }
    return `Fake response to: ${lastUserMessage.content[0].text}`;
  }
}
