import type {
  ModelRequest,
  ModelResponse,
  StreamingTextGenerationProvider,
  TextGenerationProvider,
} from "../core/agent";

export class FakeProvider implements TextGenerationProvider, StreamingTextGenerationProvider {
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

  async *streamText(request: ModelRequest, options: { signal?: AbortSignal } = {}): AsyncIterable<string> {
    const response = await this.generate(request);
    if (response.kind !== "final") {
      throw new Error("The fake provider cannot stream tool calls.");
    }
    for (let offset = 0; offset < response.text.length; offset += 8) {
      options.signal?.throwIfAborted();
      if (offset > 0) await new Promise<void>((resolve) => setTimeout(resolve, 20));
      options.signal?.throwIfAborted();
      yield response.text.slice(offset, offset + 8);
    }
  }
}
