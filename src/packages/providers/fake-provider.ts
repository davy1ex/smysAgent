import type {
  ModelGenerationOptions,
  ModelRequest,
  ModelResponse,
  TextGenerationProvider,
} from "../core/agent";

export class FakeProvider implements TextGenerationProvider {
  readonly requests: ModelRequest[] = [];
  private responseIndex = 0;

  constructor(private readonly scriptedResponses: readonly ModelResponse[] = []) {}

  async generate(request: ModelRequest, options: ModelGenerationOptions = {}): Promise<ModelResponse> {
    options.signal?.throwIfAborted();
    this.requests.push({ messages: [...request.messages], tools: [...request.tools] });
    const scriptedResponse = this.scriptedResponses[this.responseIndex];
    if (scriptedResponse !== undefined) {
      this.responseIndex += 1;
      await this.emitText(scriptedResponse, options);
      return scriptedResponse;
    }
    if (this.scriptedResponses.length > 0) {
      throw new Error("The fake provider response script is exhausted.");
    }

    const lastUserMessage = [...request.messages].reverse().find((message) => message.role === "user");
    if (lastUserMessage === undefined || !("content" in lastUserMessage)) {
      throw new Error("The fake provider requires at least one user message.");
    }
    const response = { kind: "final", text: `Fake response to: ${lastUserMessage.content}` } as const;
    await this.emitText(response, options);
    return response;
  }

  private async emitText(response: ModelResponse, options: ModelGenerationOptions): Promise<void> {
    if (response.kind !== "final" || options.onTextDelta === undefined) return;
    for (let offset = 0; offset < response.text.length; offset += 8) {
      options.signal?.throwIfAborted();
      if (offset > 0) await new Promise<void>((resolve) => setTimeout(resolve, 20));
      options.signal?.throwIfAborted();
      await options.onTextDelta(response.text.slice(offset, offset + 8));
    }
  }
}
