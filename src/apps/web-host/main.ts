import { resolve } from "node:path";
import { createDemoAddTool, type TextGenerationProvider } from "../../packages/application";
import { FakeProvider } from "../../packages/providers/fake-provider";
import { LmStudioProvider } from "../../packages/providers/lm-studio-provider";
import { JsonFileSessionRepository } from "../../packages/storage";
import { createWebApiServer } from "./server";

const DEFAULT_LM_STUDIO_ENDPOINT = "http://localhost:1234/v1/chat/completions";
const DEFAULT_PORT = 3001;

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const port = resolvePort(env.SMYS_WEB_PORT);
  const dataDir = resolve(process.cwd(), env.SMYS_DATA_DIR || ".smys-agent");
  const repository = new JsonFileSessionRepository(dataDir);
  const server = createWebApiServer({ repository, provider: resolveProvider(env), tools: [createDemoAddTool()] });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  process.stdout.write(`SMYS Web API listening at http://127.0.0.1:${port}\n`);
  process.stdout.write(`Session data: ${dataDir}\n`);

  await new Promise<void>((resolveClose) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      server.close(() => {
        void repository.close().finally(resolveClose);
      });
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

function resolveProvider(env: NodeJS.ProcessEnv): TextGenerationProvider {
  const providerName = env.SMYS_PROVIDER ?? "fake";
  if (providerName === "fake") {
    return new FakeProvider();
  }
  if (providerName !== "lm-studio") {
    throw new Error("SMYS_PROVIDER must be fake or lm-studio.");
  }

  const model = env.LM_STUDIO_MODEL?.trim();
  if (model === undefined || model.length === 0) {
    throw new Error("LM_STUDIO_MODEL is required when SMYS_PROVIDER=lm-studio.");
  }
  const endpoint = env.LM_STUDIO_ENDPOINT || DEFAULT_LM_STUDIO_ENDPOINT;
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error("LM_STUDIO_ENDPOINT must be an absolute HTTP or HTTPS URL.");
  }
  if (parsedEndpoint.protocol !== "http:" && parsedEndpoint.protocol !== "https:") {
    throw new Error("LM_STUDIO_ENDPOINT must be an absolute HTTP or HTTPS URL.");
  }

  const apiToken = env.LM_API_TOKEN?.trim();
  return new LmStudioProvider({
    endpoint,
    model,
    ...(apiToken === undefined || apiToken.length === 0 ? {} : { apiToken }),
  });
}

function resolvePort(value: string | undefined): number {
  if (value === undefined || value.length === 0) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMYS_WEB_PORT must be an integer between 1 and 65535.");
  }
  return port;
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "An unexpected error occurred.";
    process.stderr.write(`SMYS Web API failed to start: ${message}\n`);
    process.exitCode = 1;
  });
}
