import { createHash } from "node:crypto";
import { z } from "zod";
import { createLogger } from "@stock-radar/logging";
import { getDefaultModel, getOllamaBaseUrl } from "./models";

const logger = createLogger("ai");

export interface GenerateJsonInputs<TSchema extends z.ZodTypeAny> {
  schema: TSchema;
  system: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
  temperature?: number;
  retries?: number;
}

export interface GenerateJsonResult<T> {
  output: T;
  rawResponse: unknown;
  model: string;
  latencyMs: number;
  promptTokens: number;
  responseTokens: number;
  contextDigest: string;
}

export class OllamaClient {
  constructor(private readonly baseUrl = getOllamaBaseUrl()) {}

  async generateJson<TSchema extends z.ZodTypeAny>(
    inputs: GenerateJsonInputs<TSchema>,
  ): Promise<GenerateJsonResult<z.infer<TSchema>>> {
    const model = inputs.model ?? getDefaultModel();
    const retries = inputs.retries ?? 1;
    const contextDigest = digest(`${inputs.system}\n\n${inputs.prompt}`);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const started = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), inputs.timeoutMs ?? 6_000);
        const response = await fetch(`${this.baseUrl}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            system: inputs.system,
            prompt: inputs.prompt,
            stream: false,
            format: "json",
            options: {
              temperature: inputs.temperature ?? 0.2,
            },
          }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));

        if (!response.ok) {
          throw new Error(`Ollama returned HTTP ${response.status}`);
        }

        const raw = (await response.json()) as {
          response?: string;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        const parsedJson = parseModelJson(raw.response ?? "");
        const parsed = inputs.schema.safeParse(parsedJson);
        if (!parsed.success) {
          throw new Error(`Ollama JSON failed schema validation: ${parsed.error.message}`);
        }

        return {
          output: parsed.data,
          rawResponse: raw,
          model,
          latencyMs: Date.now() - started,
          promptTokens: raw.prompt_eval_count ?? 0,
          responseTokens: raw.eval_count ?? 0,
          contextDigest,
        };
      } catch (error) {
        lastError = error as Error;
        logger.warn("Ollama JSON generation failed", {
          attempt,
          model,
          error: lastError.message,
        });
      }
    }

    throw lastError ?? new Error("Ollama JSON generation failed");
  }
}

const parseModelJson = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Model did not return JSON.");
    return JSON.parse(match[0]);
  }
};

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

