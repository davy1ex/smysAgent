import type { Message } from "./session";

export interface TextGenerationProvider {
  generate(messages: readonly Message[]): Promise<string>;
}

export async function runAgentTurn(messages: readonly Message[], provider: TextGenerationProvider): Promise<string> {
  const response = await provider.generate(messages);
  if (response.length === 0) {
    throw new Error("The model provider returned an empty response.");
  }
  return response;
}
