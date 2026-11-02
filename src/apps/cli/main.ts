import { resolve } from "node:path";
import { AgentRuntimeError, type ToolPermissionPolicy } from "../../packages/core/agent";
import {
  createDemoAddTool,
  createSession,
  executeTurn,
  getHistory,
  InvalidArgumentError,
  sendMessage,
  SessionNotFoundError,
  type AgentEvent,
  type SessionRepository,
} from "../../packages/application";
import { JsonFileSessionRepository, StorageError } from "../../packages/storage";
import { FakeProvider } from "../../packages/providers/fake-provider";
import { LmStudioProvider, LmStudioProviderError } from "../../packages/providers/lm-studio-provider";

const DEFAULT_LM_STUDIO_ENDPOINT = "http://localhost:1234/v1/chat/completions";
const FAKE_DEMO_ADD_RESPONSES = [
  { kind: "tool-call", callId: "fake-demo-add", name: "demo.add", arguments: { a: 2, b: 3 } },
  { kind: "final", text: "Fake demo.add result: 5" },
] as const;

type ParsedCommand = {
  command: "session-create" | "message-send" | "history-get" | "agent-run";
  json: boolean;
  stream: boolean;
  output: "text" | "ndjson";
  options: Map<string, string>;
};

interface CliErrorPayload {
  code: "INVALID_ARGUMENT" | "SESSION_NOT_FOUND" | "STORAGE_ERROR" | "INTERNAL_ERROR" | "ABORTED";
  message: string;
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let json = argv.includes("--json");
  let stream = false;
  let ndjson = false;
  try {
    const parsed = parseCommand(argv);
    json = parsed.json;
    stream = parsed.stream;
    ndjson = parsed.output === "ndjson";
    validateProviderSettings(parsed, env);
    const dataDir = resolveDataDir(parsed.options.get("data-dir"), env);
    const repository = new JsonFileSessionRepository(dataDir);
    const controller = parsed.command === "agent-run" ? new AbortController() : undefined;
    const abortOnInterrupt = () => controller?.abort();
    if (controller !== undefined) process.once("SIGINT", abortOnInterrupt);
    try {
      const result = await execute(parsed, repository, env, controller?.signal);
      if (!parsed.stream) writeSuccess(result, parsed.json);
      else if (parsed.output === "text") process.stdout.write("\n");
      return 0;
    } finally {
      if (controller !== undefined) process.off("SIGINT", abortOnInterrupt);
      await repository.close();
    }
  } catch (error) {
    if (stream && !ndjson) process.stdout.write("\n");
    const payload = toCliError(error);
    writeError(payload, json);
    return exitCodeFor(payload.code);
  }
}

function parseCommand(argv: string[]): ParsedCommand {
  const [group, action, ...args] = argv;
  let command: ParsedCommand["command"];
  if (group === "session" && action === "create") {
    command = "session-create";
  } else if (group === "message" && action === "send") {
    command = "message-send";
  } else if (group === "history" && action === "get") {
    command = "history-get";
  } else if (group === "agent" && action === "run") {
    command = "agent-run";
  } else {
    throw new InvalidArgumentError("Expected: session create, message send, history get, or agent run.");
  }

  const allowedOptions = new Set(
    command === "session-create"
      ? ["data-dir", "initial-message"]
      : command === "message-send"
        ? ["data-dir", "session-id", "text"]
        : command === "agent-run"
          ? ["data-dir", "session-id", "text", "provider", "model", "endpoint", "tool", "allow-tool", "stream", "output"]
          : ["data-dir", "session-id"],
  );
  const options = new Map<string, string>();
  let json = false;
  let stream = false;
  let output: "text" | "ndjson" = "text";
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--json") {
      if (json) {
        throw new InvalidArgumentError("--json must not be repeated.");
      }
      json = true;
      continue;
    }
    if (option === "--stream") {
      if (!allowedOptions.has("stream")) throw new InvalidArgumentError(`Unknown option: ${option}`);
      if (stream) throw new InvalidArgumentError("--stream must not be repeated.");
      stream = true;
      continue;
    }
    if (option === "--output") {
      if (!allowedOptions.has("output")) throw new InvalidArgumentError(`Unknown option: ${option}`);
      if (options.has("output")) throw new InvalidArgumentError("--output must not be repeated.");
      const value = args[index + 1];
      if (value === undefined) throw new InvalidArgumentError("--output requires a value.");
      if (value !== "ndjson") throw new InvalidArgumentError("--output supports only ndjson.");
      options.set("output", value);
      output = "ndjson";
      index += 1;
      continue;
    }
    if (option === undefined || !option.startsWith("--")) {
      throw new InvalidArgumentError(`Unexpected argument: ${option ?? ""}`);
    }

    const name = option.slice(2);
    if (!allowedOptions.has(name)) {
      throw new InvalidArgumentError(`Unknown option: ${option}`);
    }
    if (options.has(name)) {
      throw new InvalidArgumentError(`${option} must not be repeated.`);
    }
    const value = args[index + 1];
    if (value === undefined) {
      throw new InvalidArgumentError(`${option} requires a value.`);
    }
    options.set(name, value);
    index += 1;
  }

  if (command !== "session-create" && !options.has("session-id")) {
    throw new InvalidArgumentError("--session-id is required.");
  }
  if ((command === "message-send" || command === "agent-run") && !options.has("text")) {
    throw new InvalidArgumentError("--text is required.");
  }
  if (command === "agent-run" && options.get("provider") !== "fake" && options.get("provider") !== "lm-studio") {
    throw new InvalidArgumentError("agent run requires --provider fake or lm-studio.");
  }
  if (command === "agent-run" && options.get("provider") === "lm-studio") {
    if (!options.has("model")) {
      throw new InvalidArgumentError("--model is required when --provider lm-studio is selected.");
    }
    if (options.get("model") === "") {
      throw new InvalidArgumentError("--model must not be empty.");
    }
    if (options.get("endpoint") === "") {
      throw new InvalidArgumentError("--endpoint must not be empty.");
    }
  }
  if (command === "agent-run" && options.get("provider") === "fake" && (options.has("model") || options.has("endpoint"))) {
    throw new InvalidArgumentError("--model and --endpoint can only be used with --provider lm-studio.");
  }
  if (command === "agent-run" && options.has("tool") && options.get("tool") !== "demo.add") {
    throw new InvalidArgumentError("--tool supports only demo.add.");
  }
  if (command === "agent-run" && options.has("allow-tool") && options.get("allow-tool") !== "demo.add") {
    throw new InvalidArgumentError("--allow-tool supports only demo.add.");
  }
  if (command === "agent-run" && options.has("allow-tool") && !options.has("tool")) {
    throw new InvalidArgumentError("--allow-tool requires --tool demo.add.");
  }
  if (command === "session-create" && options.get("initial-message") === "") {
    throw new InvalidArgumentError("--initial-message must not be empty.");
  }
  if ((command === "message-send" || command === "agent-run") && options.get("text") === "") {
    throw new InvalidArgumentError("--text must not be empty.");
  }
  if (output === "ndjson" && !stream) {
    throw new InvalidArgumentError("--output ndjson requires --stream.");
  }
  if (stream && json) {
    throw new InvalidArgumentError("--stream cannot be combined with --json.");
  }
  return { command, json, stream, output, options };
}

async function execute(
  parsed: ParsedCommand,
  repository: SessionRepository,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  switch (parsed.command) {
    case "session-create": {
      const session = await createSession(repository);
      const initialMessage = parsed.options.get("initial-message");
      if (initialMessage === undefined) {
        return { ok: true, session };
      }
      const message = await sendMessage(repository, { sessionId: session.id, text: initialMessage });
      return { ok: true, session, message };
    }
    case "message-send": {
      const message = await sendMessage(repository, {
        sessionId: requiredOption(parsed.options, "session-id"),
        text: requiredOption(parsed.options, "text"),
      });
      return { ok: true, message };
    }
    case "history-get": {
      const sessionId = requiredOption(parsed.options, "session-id");
      const history = await getHistory(repository, sessionId);
      return { ok: true, sessionId, messages: history.messages };
    }
    case "agent-run": {
      const providerName = requiredOption(parsed.options, "provider");
      const demoAddEnabled = parsed.options.get("tool") === "demo.add";
      const provider = providerName === "fake"
        ? new FakeProvider(demoAddEnabled ? FAKE_DEMO_ADD_RESPONSES : [])
        : new LmStudioProvider({
          endpoint: resolveLmStudioEndpoint(parsed.options.get("endpoint"), env),
          model: requiredOption(parsed.options, "model"),
          ...(env.LM_API_TOKEN !== undefined && env.LM_API_TOKEN.trim().length > 0
            ? { apiToken: env.LM_API_TOKEN.trim() }
            : {}),
        });
      const agentOptions = demoAddEnabled
        ? {
          tools: [createDemoAddTool()],
          permissionPolicy: createCliPermissionPolicy(parsed.options),
        }
        : {};
      const streamOptions = parsed.stream
        ? {
          onTextDelta: parsed.output === "text"
            ? (delta: string) => { process.stdout.write(delta); }
            : () => undefined,
          onEvent: (event: AgentEvent) => {
            if (parsed.output === "ndjson") {
              process.stdout.write(`${JSON.stringify(event)}\n`);
            } else if (event.type === "reasoning.completed") {
              process.stderr.write(`Reasoning:\n${event.text}\n`);
            }
          },
        }
        : {};
      const turn = await executeTurn(
        repository,
        provider,
        {
          sessionId: requiredOption(parsed.options, "session-id"),
          text: requiredOption(parsed.options, "text"),
        },
        { ...agentOptions, ...streamOptions, ...(signal === undefined ? {} : { signal }) },
      );
      return { ok: true, ...turn };
    }
  }
}

function createCliPermissionPolicy(options: Map<string, string>): ToolPermissionPolicy {
  return {
    async authorize(request) {
      return options.get("allow-tool") === request.toolName ? "allow" : "deny";
    },
  };
}

function validateProviderSettings(parsed: ParsedCommand, env: NodeJS.ProcessEnv): void {
  if (parsed.command !== "agent-run" || parsed.options.get("provider") !== "lm-studio") {
    return;
  }

  const endpoint = resolveLmStudioEndpoint(parsed.options.get("endpoint"), env);
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new InvalidArgumentError("--endpoint must be an absolute HTTP or HTTPS URL.");
  }
  if (parsedEndpoint.protocol !== "http:" && parsedEndpoint.protocol !== "https:") {
    throw new InvalidArgumentError("--endpoint must be an absolute HTTP or HTTPS URL.");
  }
}

function resolveLmStudioEndpoint(option: string | undefined, env: NodeJS.ProcessEnv): string {
  if (option !== undefined) {
    return option;
  }
  const configuredEndpoint = env.LM_STUDIO_ENDPOINT;
  return configuredEndpoint === undefined || configuredEndpoint.length === 0
    ? DEFAULT_LM_STUDIO_ENDPOINT
    : configuredEndpoint;
}

function requiredOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined) {
    throw new InvalidArgumentError(`--${name} is required.`);
  }
  return value;
}

function resolveDataDir(option: string | undefined, env: NodeJS.ProcessEnv): string {
  const launchDir = env.INIT_CWD === undefined || env.INIT_CWD.length === 0 ? process.cwd() : resolve(env.INIT_CWD);
  if (option !== undefined) {
    if (option.length === 0) {
      throw new InvalidArgumentError("--data-dir must not be empty.");
    }
    return resolve(launchDir, option);
  }
  const envPath = env.SMYS_DATA_DIR;
  if (envPath !== undefined && envPath.length > 0) {
    return resolve(launchDir, envPath);
  }
  return resolve(launchDir, ".smys-agent");
}

function toCliError(error: unknown): CliErrorPayload {
  if (error instanceof InvalidArgumentError) {
    return { code: "INVALID_ARGUMENT", message: error.message };
  }
  if (error instanceof SessionNotFoundError) {
    return { code: "SESSION_NOT_FOUND", message: error.message };
  }
  if (error instanceof StorageError) {
    return { code: "STORAGE_ERROR", message: error.message };
  }
  if (error instanceof LmStudioProviderError) {
    return { code: "INTERNAL_ERROR", message: error.message };
  }
  if (error instanceof AgentRuntimeError) {
    return { code: "INTERNAL_ERROR", message: error.message };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { code: "ABORTED", message: "Turn was cancelled." };
  }
  return { code: "INTERNAL_ERROR", message: "An unexpected error occurred." };
}

function exitCodeFor(code: CliErrorPayload["code"]): number {
  switch (code) {
    case "INVALID_ARGUMENT":
      return 2;
    case "SESSION_NOT_FOUND":
      return 3;
    case "STORAGE_ERROR":
      return 4;
    case "INTERNAL_ERROR":
      return 1;
    case "ABORTED":
      return 130;
  }
}

function writeSuccess(value: Record<string, unknown>, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if ("session" in value && typeof value.session === "object" && value.session !== null) {
    const session = value.session as { id?: unknown };
    process.stdout.write(`Created session ${String(session.id)}\n`);
    if ("message" in value) {
      process.stdout.write("Saved initial user message.\n");
    }
    return;
  }
  if ("message" in value && typeof value.message === "object" && value.message !== null) {
    const message = value.message as { id?: unknown };
    process.stdout.write(`Saved message ${String(message.id)}\n`);
    return;
  }
  if ("assistantMessage" in value && typeof value.assistantMessage === "object" && value.assistantMessage !== null) {
    const turn = value as {
      userMessage: { id: string };
      assistantMessage: { content: Array<{ text: string }> };
      reasoning?: string;
    };
    process.stdout.write(`Saved user message ${turn.userMessage.id}\n`);
    if (typeof turn.reasoning === "string" && turn.reasoning.length > 0) {
      process.stdout.write(`Reasoning:\n${turn.reasoning}\n\n`);
    }
    process.stdout.write(`${turn.assistantMessage.content.map((part) => part.text).join("\n")}\n`);
    return;
  }
  if ("sessionId" in value && Array.isArray(value.messages)) {
    process.stdout.write(`History for session ${String(value.sessionId)}\n`);
    for (const message of value.messages as Array<{ sequence: number; role: string; content: Array<{ text: string }> }>) {
      process.stdout.write(`[${message.sequence}] ${message.role}: ${message.content.map((part) => part.text).join("\n")}\n`);
    }
  }
}

function writeError(payload: CliErrorPayload, json: boolean): void {
  if (json) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: payload })}\n`);
    return;
  }
  process.stderr.write(`${payload.code}: ${payload.message}\n`);
}

if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
