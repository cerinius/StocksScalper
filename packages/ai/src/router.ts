/**
 * AI Router — unified multi-provider client for the StocksScalper platform.
 *
 * Provider priority in "auto" mode (default):
 *   1. Anthropic (Claude) — if ANTHROPIC_API_KEY is set
 *   2. OpenAI-compatible gateway — if OPENAI_COMPAT_API_KEY / OPENLAW_API_KEY / OPENAI_API_KEY is set
 *      (works with OpenLaw, OpenRouter, Azure OpenAI, Groq, Together AI, etc.)
 *   3. Ollama — always available as local fallback
 *
 * Task-type routing:
 *   "pretrade"  → fast/cheap model (haiku, mini) — called on every trade tick
 *   "posttrade" → capable model (sonnet, 4o) — async, after close
 *   "weekly"    → capable model (sonnet, 4o) — once per week
 *   "query"     → capable model — user-facing NL query
 *   "general"   → defaults to capable model
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { createLogger } from "@stock-radar/logging";
import type { GenerateJsonInputs, GenerateJsonResult } from "./client";
import { OllamaClient } from "./client";

const logger = createLogger("ai:router");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const parseModelJson = (text: string): unknown => {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Strip markdown code fences if present
    const stripped = trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "");
    try {
      return JSON.parse(stripped);
    } catch {
      const match = stripped.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("Model did not return JSON.");
      return JSON.parse(match[0]);
    }
  }
};

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

// ─── Shared client interface ──────────────────────────────────────────────────

export interface AIClient {
  generateJson<TSchema extends z.ZodTypeAny>(
    inputs: GenerateJsonInputs<TSchema>,
  ): Promise<GenerateJsonResult<z.infer<TSchema>>>;
}

// ─── Anthropic Client ─────────────────────────────────────────────────────────

export class AnthropicClient implements AIClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options?: { apiKey?: string; model?: string; baseUrl?: string }) {
    this.apiKey =
      options?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.model =
      options?.model ??
      process.env.ANTHROPIC_MODEL ??
      "claude-sonnet-4-5";
    this.baseUrl = (
      options?.baseUrl ??
      process.env.ANTHROPIC_BASE_URL ??
      "https://api.anthropic.com"
    ).replace(/\/+$/, "");
  }

  async generateJson<TSchema extends z.ZodTypeAny>(
    inputs: GenerateJsonInputs<TSchema>,
  ): Promise<GenerateJsonResult<z.infer<TSchema>>> {
    if (!this.apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

    const model = inputs.model ?? this.model;
    const retries = inputs.retries ?? 1;
    const contextDigest = digest(`${inputs.system}\n\n${inputs.prompt}`);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const started = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          inputs.timeoutMs ?? 30_000,
        );

        const response = await fetch(`${this.baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 2048,
            system: [
              inputs.system,
              "IMPORTANT: Respond with valid JSON only. No markdown, no code blocks, no explanation.",
              "Your entire response must be parseable JSON matching the required schema.",
            ].join(" "),
            messages: [{ role: "user", content: inputs.prompt }],
            temperature: inputs.temperature ?? 0.2,
          }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(
            `Anthropic HTTP ${response.status}: ${body.slice(0, 300)}`,
          );
        }

        const raw = (await response.json()) as {
          content?: Array<{ type: string; text?: string }>;
          usage?: { input_tokens?: number; output_tokens?: number };
        };

        const text =
          raw.content?.find((b) => b.type === "text")?.text ?? "";
        const parsedJson = parseModelJson(text);
        const parsed = inputs.schema.safeParse(parsedJson);
        if (!parsed.success) {
          throw new Error(
            `Schema validation failed: ${parsed.error.message}`,
          );
        }

        return {
          output: parsed.data,
          rawResponse: raw,
          model,
          latencyMs: Date.now() - started,
          promptTokens: raw.usage?.input_tokens ?? 0,
          responseTokens: raw.usage?.output_tokens ?? 0,
          contextDigest,
        };
      } catch (error) {
        lastError = error as Error;
        logger.warn("Anthropic generation failed", {
          attempt,
          model,
          error: lastError.message,
        });
      }
    }

    throw lastError ?? new Error("Anthropic generation failed");
  }
}

// ─── OpenAI-compatible Client ─────────────────────────────────────────────────
// Works with OpenLaw, OpenRouter, Azure OpenAI, Groq, Together AI, direct OpenAI, etc.
// Set OPENAI_COMPAT_BASE_URL (or OPENLAW_BASE_URL) to your gateway's base URL.

export class OpenAICompatClient implements AIClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options?: { apiKey?: string; model?: string; baseUrl?: string }) {
    this.apiKey =
      options?.apiKey ??
      process.env.OPENAI_COMPAT_API_KEY ??
      process.env.OPENLAW_API_KEY ??
      process.env.OPENAI_API_KEY ??
      "";
    this.model =
      options?.model ??
      process.env.OPENAI_COMPAT_MODEL ??
      process.env.OPENLAW_MODEL ??
      "gpt-4o-mini";
    this.baseUrl = (
      options?.baseUrl ??
      process.env.OPENAI_COMPAT_BASE_URL ??
      process.env.OPENLAW_BASE_URL ??
      "https://api.openai.com"
    ).replace(/\/+$/, "");
  }

  async generateJson<TSchema extends z.ZodTypeAny>(
    inputs: GenerateJsonInputs<TSchema>,
  ): Promise<GenerateJsonResult<z.infer<TSchema>>> {
    if (!this.apiKey) {
      throw new Error(
        "OpenAI-compat API key not configured (OPENAI_COMPAT_API_KEY / OPENLAW_API_KEY)",
      );
    }

    const model = inputs.model ?? this.model;
    const retries = inputs.retries ?? 1;
    const contextDigest = digest(`${inputs.system}\n\n${inputs.prompt}`);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const started = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          inputs.timeoutMs ?? 30_000,
        );

        const messages = [
          {
            role: "system",
            content: [
              inputs.system,
              "IMPORTANT: Respond with valid JSON only. No markdown, no explanation.",
            ].join(" "),
          },
          { role: "user", content: inputs.prompt },
        ];

        const rawBody: Record<string, unknown> = {
          model,
          messages,
          temperature: inputs.temperature ?? 0.2,
          response_format: { type: "json_object" },
        };

        const fetchOpts = {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(rawBody),
          signal: controller.signal,
        } as const;

        let response = await fetch(
          `${this.baseUrl}/v1/chat/completions`,
          fetchOpts,
        ).finally(() => clearTimeout(timer));

        // Some providers reject response_format — retry without it
        if (!response.ok && response.status === 400) {
          const errText = await response.text().catch(() => "");
          if (
            errText.includes("response_format") ||
            errText.includes("json_object")
          ) {
            const fallbackBody = { ...rawBody };
            delete fallbackBody["response_format"];
            response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
              ...fetchOpts,
              body: JSON.stringify(fallbackBody),
            });
          } else {
            throw new Error(
              `OpenAI-compat HTTP 400: ${errText.slice(0, 300)}`,
            );
          }
        }

        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          throw new Error(
            `OpenAI-compat HTTP ${response.status}: ${errText.slice(0, 300)}`,
          );
        }

        const raw = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };

        const content = raw.choices?.[0]?.message?.content ?? "";
        const parsedJson = parseModelJson(content);
        const parsed = inputs.schema.safeParse(parsedJson);
        if (!parsed.success) {
          throw new Error(
            `Schema validation failed: ${parsed.error.message}`,
          );
        }

        return {
          output: parsed.data,
          rawResponse: raw,
          model,
          latencyMs: Date.now() - started,
          promptTokens: raw.usage?.prompt_tokens ?? 0,
          responseTokens: raw.usage?.completion_tokens ?? 0,
          contextDigest,
        };
      } catch (error) {
        lastError = error as Error;
        logger.warn("OpenAI-compat generation failed", {
          attempt,
          model,
          error: lastError.message,
        });
      }
    }

    throw lastError ?? new Error("OpenAI-compat generation failed");
  }
}

// ─── Task types ───────────────────────────────────────────────────────────────

export type AIProviderName =
  | "ollama"
  | "openai_compat"
  | "anthropic"
  | "auto";

export type AITaskType =
  | "pretrade"   // real-time, needs to be fast → use fast/cheap model
  | "posttrade"  // async, after trade close → use capable model
  | "weekly"     // once a week → use capable model
  | "query"      // user NL query → use capable model
  | "general";   // default

// ─── Router ───────────────────────────────────────────────────────────────────

export class AIRouter {
  private readonly providerName: AIProviderName;

  constructor(provider?: AIProviderName) {
    this.providerName =
      provider ??
      (process.env.AI_PROVIDER as AIProviderName) ??
      "auto";
  }

  async generateJson<TSchema extends z.ZodTypeAny>(
    inputs: GenerateJsonInputs<TSchema>,
    taskType: AITaskType = "general",
  ): Promise<GenerateJsonResult<z.infer<TSchema>>> {
    const chain = this.buildProviderChain(taskType);
    let lastError: Error | null = null;

    for (const client of chain) {
      try {
        return await client.generateJson(inputs);
      } catch (err) {
        lastError = err as Error;
        logger.warn("AI provider in chain failed, trying next", {
          error: lastError.message,
          taskType,
        });
      }
    }

    throw lastError ?? new Error("All AI providers failed");
  }

  private buildProviderChain(taskType: AITaskType): AIClient[] {
    const p = this.providerName;

    // Single-provider explicit modes
    if (p === "anthropic") return [new AnthropicClient()];
    if (p === "openai_compat") return [new OpenAICompatClient()];
    if (p === "ollama") return [new OllamaClient()];

    // Auto mode: pick providers based on available keys
    // pretrade = fast model to keep latency low on every trade tick
    const isRealtime = taskType === "pretrade";

    const hasAnthropic = !!(process.env.ANTHROPIC_API_KEY?.trim());
    const hasOpenAICompat = !!(
      process.env.OPENAI_COMPAT_API_KEY?.trim() ||
      process.env.OPENLAW_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim()
    );

    const chain: AIClient[] = [];

    if (hasAnthropic) {
      const model = isRealtime
        ? (process.env.ANTHROPIC_FAST_MODEL ?? "claude-3-5-haiku-20241022")
        : (process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5");
      chain.push(new AnthropicClient({ model }));
    }

    if (hasOpenAICompat) {
      const model = isRealtime
        ? (process.env.OPENAI_COMPAT_FAST_MODEL ??
           process.env.OPENLAW_FAST_MODEL ??
           "gpt-4o-mini")
        : (process.env.OPENAI_COMPAT_MODEL ??
           process.env.OPENLAW_MODEL ??
           "gpt-4o");
      chain.push(new OpenAICompatClient({ model }));
    }

    // Ollama is always the local fallback — works even with no API keys
    chain.push(new OllamaClient());

    return chain;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _router: AIRouter | null = null;

export const getAIRouter = (): AIRouter => {
  if (!_router) _router = new AIRouter();
  return _router;
};
