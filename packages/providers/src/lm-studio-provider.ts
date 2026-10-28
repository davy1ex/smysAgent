import type { TextGenerationProvider } from "../../core/src/agent-runtime";
import type { Message } from "../../core/src/session";

export interface LmStudioProviderOptions {
  endpoint: string;
  model: string;
  apiToken?: string;
  fetcher?: typeof fetch;
}

export class LmStudioProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LmStudioProviderError";
  }
}

export class LmStudioProvider implements TextGenerationProvider {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: LmStudioProviderOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async generate(messages: readonly Message[]): Promise<string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.apiToken !== undefined && this.options.apiToken.length > 0) {
      headers.authorization = `Bearer ${this.options.apiToken}`;
    }

    let response: Response;
    try {
      response = await this.fetcher(this.options.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.options.model,
          messages: messages.map((message) => ({
            role: message.role,
            content: message.content[0].text,
          })),
          stream: false,
        }),
      });
    } catch {
      throw new LmStudioProviderError("Could not connect to LM Studio.");
    }

    if (!response.ok) {
      throw new LmStudioProviderError(`LM Studio returned HTTP ${response.status}.`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LmStudioProviderError("LM Studio returned an invalid chat completion response.");
    }

    const content = getAssistantContent(payload);
    if (content === null || content.length === 0) {
      throw new LmStudioProviderError("LM Studio returned an invalid chat completion response.");
    }
    return content;
  }
}

function getAssistantContent(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const firstChoice = choices[0];
  if (typeof firstChoice !== "object" || firstChoice === null) {
    return null;
  }
  const message = (firstChoice as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : null;
}
