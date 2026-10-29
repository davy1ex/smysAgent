import { LmStudioProvider, LmStudioProviderError } from "../../packages/providers/lm-studio-provider";

const DEFAULT_LM_STUDIO_ENDPOINT = "http://localhost:1234/v1/chat/completions";

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const model = env.LM_STUDIO_MODEL?.trim();
  if (model === undefined || model.length === 0) {
    process.stderr.write('{"ok":false,"error":{"code":"INVALID_CONFIGURATION","message":"Set LM_STUDIO_MODEL to the loaded LM Studio model ID."}}\n');
    return 2;
  }

  const endpoint = env.LM_STUDIO_ENDPOINT?.trim() || DEFAULT_LM_STUDIO_ENDPOINT;
  const apiToken = env.LM_API_TOKEN?.trim();
  const provider = new LmStudioProvider({
    endpoint,
    model,
    ...(apiToken === undefined || apiToken.length === 0 ? {} : { apiToken }),
  });

  try {
    const response = await provider.generate({
      messages: [{ role: "user", content: "Reply exactly with: SMOKE_OK" }],
      tools: [],
    });
    if (response.kind !== "final") {
      process.stderr.write('{"ok":false,"error":{"code":"INVALID_RESPONSE","message":"Expected a final text response from LM Studio."}}\n');
      return 1;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, provider: "lm-studio", model, text: response.text })}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof LmStudioProviderError ? error.message : "LM Studio smoke test failed.";
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "PROVIDER_ERROR", message } })}\n`);
    return 1;
  }
}

if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
