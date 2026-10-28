import type { ModelRequest, ModelResponse, TextGenerationProvider } from "../../core/src/agent-runtime";

export class FakeProvider implements TextGenerationProvider {
  readonly requests: ModelRequest[] = [];
  private responseIndex = 0;

  constructor(private readonly scriptedResponses: readonly ModelResponse[] = []) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push({ messages: [...request.messages], tools: [...request.tools] });
    const scriptedResponse = this.scriptedResponses[this.responseIndex];
    if (scriptedResponse !== undefined) {
      this.responseIndex += 1;
      return scriptedResponse;
    }
    if (this.scriptedResponses.length > 0) {
      throw new Error("The fake provider response script is exhausted.");
    }

    const lastUserMessage = [...request.messages].reverse().find((message) => message.role === "user");
    if (lastUserMessage === undefined || !("content" in lastUserMessage)) {
      throw new Error("The fake provider requires at least one user message.");
    }
    return { kind: "final", text: `Fake response to: ${lastUserMessage.content}` };
  }
}
