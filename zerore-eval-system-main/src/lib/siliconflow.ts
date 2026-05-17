/**
 * @fileoverview SiliconFlow chat completion client for subjective evaluation.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ZEVAL_JUDGE_MAX_TOKENS,
  ZEVAL_JUDGE_TEMPERATURE,
  ZEVAL_JUDGE_TOP_P,
  getPromptVersionForRequestStage,
  getZevalJudgeProfileSnapshot,
} from "@/llm/judgeProfile";

type SiliconFlowMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type SiliconFlowChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
};

const DEFAULT_LLM_RETRY_ATTEMPTS = 3;
const DEFAULT_LLM_TIMEOUT_MS = 45000;

type SiliconFlowLogContext = {
  stage: string;
  runId?: string;
  sessionId?: string;
  segmentId?: string;
  /** Override default judge temperature for deterministic extraction stages. */
  temperature?: number;
  /** Optional seed for deterministic outputs (intent extraction, etc.). */
  seed?: number;
};

/**
 * Execute a chat completion request against SiliconFlow.
 * @param messages OpenAI-compatible chat messages.
 * @param context Logging context for this request stage.
 * @returns Raw model content string.
 */
export async function requestSiliconFlowChatCompletion(
  messages: SiliconFlowMessage[],
  context: SiliconFlowLogContext,
): Promise<string> {
  const config = getSiliconFlowRuntimeConfig();
  const apiKey = config.apiKey;
  const baseUrl = config.baseUrl;
  const model = config.model;

  if (!isUsableApiKey(apiKey)) {
    throw new Error("未配置有效的 ZEVAL_JUDGE_API_KEY / SILICONFLOW_API_KEY，请不要使用 YOUR_API_KEY_HERE 占位符。");
  }

  const startedAt = Date.now();
  const logPrefix = buildLlmLogPrefix(context);
  const promptVersion = getPromptVersionForRequestStage(context.stage);
  const judgeProfile = getZevalJudgeProfileSnapshot();
  const maxAttempts = resolvePositiveInteger(process.env.ZEVAL_JUDGE_RETRY_ATTEMPTS, DEFAULT_LLM_RETRY_ATTEMPTS);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_LLM_TIMEOUT_MS);
    console.info(
      `${logPrefix} START attempt=${attempt}/${maxAttempts} model=${model} judgeProfile=${judgeProfile.profileVersion} promptVersion=${promptVersion ?? "unversioned"} messages=${messages.length}`,
    );
    try {
      const requestBody: Record<string, unknown> = {
        model,
        messages,
        stream: false,
        temperature: context.temperature ?? ZEVAL_JUDGE_TEMPERATURE,
        top_p: ZEVAL_JUDGE_TOP_P,
        max_tokens: ZEVAL_JUDGE_MAX_TOKENS,
        response_format: {
          type: "json_object",
        },
      };
      if (typeof context.seed === "number") {
        requestBody.seed = context.seed;
      }
      const enableThinking = resolveOptionalBoolean(
        process.env.ZEVAL_JUDGE_ENABLE_THINKING ??
          process.env.ZEVAL_LLM_ENABLE_THINKING ??
          process.env.SILICONFLOW_ENABLE_THINKING,
      );
      if (typeof enableThinking === "boolean") {
        requestBody.enable_thinking = enableThinking;
      }

      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
        cache: "no-store",
      });

      const payload = await parseSiliconFlowResponse(response);
      if (!response.ok) {
        const providerMessage = payload.error?.message ? ` ${payload.error.message}` : "";
        throw new Error(`SiliconFlow 请求失败: ${response.status}${providerMessage}`);
      }

      const content =
        payload.choices?.[0]?.message?.content ??
        payload.choices?.[0]?.message?.reasoning_content;
      if (!content) {
        throw new Error(
          `SiliconFlow 未返回有效内容。message=${JSON.stringify(payload.choices?.[0]?.message ?? null)}`,
        );
      }

      console.info(`${logPrefix} SUCCESS attempt=${attempt}/${maxAttempts} durationMs=${Date.now() - startedAt}`);
      return content;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      console.error(
        `${logPrefix} ERROR attempt=${attempt}/${maxAttempts} durationMs=${Date.now() - startedAt} message=${message}`,
      );
      if (attempt >= maxAttempts || !isRetryableLlmError(error)) {
        throw error;
      }
      await sleep(buildRetryDelayMs(attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("LLM Judge 重试耗尽。");
}

/**
 * Extract the first JSON object from model output.
 * @param value Raw model output.
 * @returns Parsed JSON object.
 */
export function parseJsonObjectFromLlmOutput(value: string): unknown {
  const normalized = value.trim();
  try {
    return JSON.parse(normalized);
  } catch {
    const jsonObject = extractFirstBalancedJsonObject(normalized);
    if (!jsonObject) {
      throw new Error("LLM 输出中未找到 JSON 对象。");
    }
    return JSON.parse(jsonObject);
  }
}

/**
 * Extract the first balanced JSON object from model output.
 * @param value Raw model output that may include extra text after JSON.
 * @returns First complete JSON object string, or null when absent.
 */
function extractFirstBalancedJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return null;
}

/**
 * Build a concise log prefix for one LLM request.
 * @param context Logging context for the current request.
 * @returns Structured log prefix.
 */
function buildLlmLogPrefix(context: SiliconFlowLogContext): string {
  const parts = ["[LLM]", `stage=${context.stage}`];
  if (context.runId) {
    parts.push(`runId=${context.runId}`);
  }
  if (context.sessionId) {
    parts.push(`sessionId=${context.sessionId}`);
  }
  if (context.segmentId) {
    parts.push(`segmentId=${context.segmentId}`);
  }
  return parts.join(" ");
}

type SiliconFlowRuntimeConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

let cachedEnvConfig: Partial<SiliconFlowRuntimeConfig> | null = null;
let hasLoggedEnvFallback = false;

/**
 * Resolve runtime config from process.env first, then local .env, then example fallback.
 * Zeval-prefixed variables are preferred; SiliconFlow-prefixed variables remain
 * backward-compatible aliases for existing local environments.
 *
 * @returns Stable SiliconFlow runtime config.
 */
function getSiliconFlowRuntimeConfig(): SiliconFlowRuntimeConfig {
  const envConfig = readEnvConfig();
  const apiKey =
    process.env.ZEVAL_JUDGE_API_KEY ??
    process.env.ZEVAL_LLM_API_KEY ??
    process.env.SILICONFLOW_API_KEY ??
    envConfig.apiKey;
  const baseUrl =
    process.env.ZEVAL_JUDGE_BASE_URL ??
    process.env.ZEVAL_LLM_BASE_URL ??
    process.env.SILICONFLOW_BASE_URL ??
    envConfig.baseUrl ??
    "https://api.siliconflow.cn/v1";
  const model =
    process.env.ZEVAL_JUDGE_MODEL ??
    process.env.ZEVAL_LLM_MODEL ??
    process.env.SILICONFLOW_MODEL ??
    envConfig.model ??
    "Qwen/Qwen3.5-27B";

  if (!isUsableApiKey(apiKey)) {
    throw new Error("未配置有效的 ZEVAL_JUDGE_API_KEY / SILICONFLOW_API_KEY，请不要使用 YOUR_API_KEY_HERE 占位符。");
  }

  if (
    !process.env.ZEVAL_JUDGE_API_KEY &&
    !process.env.ZEVAL_LLM_API_KEY &&
    !process.env.SILICONFLOW_API_KEY &&
    envConfig.apiKey &&
    !hasLoggedEnvFallback
  ) {
    console.warn("[LLM] Using .env fallback for Zeval judge credentials.");
    hasLoggedEnvFallback = true;
  }

  return {
    apiKey,
    baseUrl,
    model,
  };
}

/**
 * Parse a provider response body while preserving the HTTP status for errors.
 * @param response Fetch response from SiliconFlow.
 * @returns Parsed provider payload.
 */
async function parseSiliconFlowResponse(response: Response): Promise<SiliconFlowChatResponse> {
  try {
    return (await response.json()) as SiliconFlowChatResponse;
  } catch {
    return { error: { message: `SiliconFlow 返回了非 JSON 响应: ${response.status}` } };
  }
}

/**
 * Validate that a configured API key is not empty or a documented placeholder.
 * @param value Raw API key value.
 * @returns Whether the key can be used for a provider request.
 */
function isUsableApiKey(value: string | undefined): value is string {
  if (!value?.trim()) {
    return false;
  }
  return !/^(YOUR_API_KEY_HERE|REPLACE_ME|TODO|CHANGEME)$/i.test(value.trim());
}

/**
 * Parse an optional boolean environment variable.
 * @param value Raw environment variable value.
 * @returns Boolean when explicitly configured, otherwise undefined.
 */
function resolveOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  if (/^(1|true|yes)$/i.test(value.trim())) {
    return true;
  }
  if (/^(0|false|no)$/i.test(value.trim())) {
    return false;
  }
  return undefined;
}

/**
 * Resolve a positive integer environment override.
 * @param value Raw environment value.
 * @param fallback Fallback when the value is absent or invalid.
 * @returns Positive integer.
 */
function resolvePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Decide whether one LLM error is transient enough to retry.
 * @param error Error thrown by fetch or provider validation.
 * @returns Whether the request should be retried.
 */
function isRetryableLlmError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /abort|timeout|timed out|fetch failed|network/i.test(message) ||
    /SiliconFlow 请求失败: (408|409|425|429|5\d\d)/.test(message) ||
    /非 JSON 响应: (408|409|425|429|5\d\d)/.test(message)
  );
}

/**
 * Build a short exponential backoff with jitter for LLM retries.
 * @param attempt Current 1-based attempt number.
 * @returns Delay in milliseconds before the next attempt.
 */
function buildRetryDelayMs(attempt: number): number {
  const base = Math.min(5000, 500 * 2 ** Math.max(0, attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

/**
 * Sleep for a bounded retry delay.
 * @param ms Delay in milliseconds.
 * @returns Promise resolved after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Read root .env as a local runtime source.
 * @returns Parsed partial config from .env.
 */
function readEnvConfig(): Partial<SiliconFlowRuntimeConfig> {
  if (cachedEnvConfig) {
    return cachedEnvConfig;
  }

  cachedEnvConfig = readSiliconFlowConfigFromFile(".env");
  return cachedEnvConfig;
}

/**
 * Read SiliconFlow runtime keys from one env-style file.
 * @param fileName Root-level env file name.
 * @returns Parsed partial SiliconFlow config.
 */
function readSiliconFlowConfigFromFile(fileName: string): Partial<SiliconFlowRuntimeConfig> {
  const envPath = path.join(/* turbopackIgnore: true */ process.cwd(), fileName);
  if (!existsSync(envPath)) {
    return {};
  }

  const parsed = parseSimpleEnvFile(readFileSync(envPath, "utf8"));
  return {
    apiKey: parsed.ZEVAL_JUDGE_API_KEY ?? parsed.ZEVAL_LLM_API_KEY ?? parsed.SILICONFLOW_API_KEY,
    baseUrl: parsed.ZEVAL_JUDGE_BASE_URL ?? parsed.ZEVAL_LLM_BASE_URL ?? parsed.SILICONFLOW_BASE_URL,
    model: parsed.ZEVAL_JUDGE_MODEL ?? parsed.ZEVAL_LLM_MODEL ?? parsed.SILICONFLOW_MODEL,
  };
}

/**
 * Parse a simple .env-style text file into key-value pairs.
 * @param text Raw env file content.
 * @returns Parsed env map.
 */
function parseSimpleEnvFile(text: string): Record<string, string> {
  return text.split(/\r?\n/).reduce<Record<string, string>>((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return acc;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      return acc;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    acc[key] = value;
    return acc;
  }, {});
}
