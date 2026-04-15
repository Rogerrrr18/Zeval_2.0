/**
 * @fileoverview SiliconFlow chat completion client for subjective evaluation.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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

type SiliconFlowLogContext = {
  stage: string;
  runId?: string;
  sessionId?: string;
  segmentId?: string;
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

  if (!apiKey) {
    throw new Error("未配置 SILICONFLOW_API_KEY。");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  const startedAt = Date.now();
  const logPrefix = buildLlmLogPrefix(context);

  try {
    console.info(`${logPrefix} START model=${model} messages=${messages.length}`);
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        enable_thinking: false,
        temperature: 0.2,
        top_p: 0.7,
        max_tokens: 1200,
        response_format: {
          type: "json_object",
        },
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    const payload = (await response.json()) as SiliconFlowChatResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `SiliconFlow 请求失败: ${response.status}`);
    }

    const content =
      payload.choices?.[0]?.message?.content ??
      payload.choices?.[0]?.message?.reasoning_content;
    if (!content) {
      throw new Error(
        `SiliconFlow 未返回有效内容。message=${JSON.stringify(payload.choices?.[0]?.message ?? null)}`,
      );
    }

    console.info(`${logPrefix} SUCCESS durationMs=${Date.now() - startedAt}`);
    return content;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    console.error(`${logPrefix} ERROR durationMs=${Date.now() - startedAt} message=${message}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
    const match = normalized.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("LLM 输出中未找到 JSON 对象。");
    }
    return JSON.parse(match[0]);
  }
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

let cachedEnvExampleConfig: Partial<SiliconFlowRuntimeConfig> | null = null;
let hasLoggedEnvExampleFallback = false;

/**
 * Resolve runtime config from process.env first, then local example file fallback.
 * @returns Stable SiliconFlow runtime config.
 */
function getSiliconFlowRuntimeConfig(): SiliconFlowRuntimeConfig {
  const fallback = readEnvExampleConfig();
  const apiKey = process.env.SILICONFLOW_API_KEY ?? fallback.apiKey;
  const baseUrl = process.env.SILICONFLOW_BASE_URL ?? fallback.baseUrl ?? "https://api.siliconflow.cn/v1";
  const model = process.env.SILICONFLOW_MODEL ?? fallback.model ?? "Qwen/Qwen3.5-27B";

  if (!apiKey) {
    throw new Error("未配置 SILICONFLOW_API_KEY。");
  }

  if (!process.env.SILICONFLOW_API_KEY && fallback.apiKey && !hasLoggedEnvExampleFallback) {
    console.warn("[LLM] Using .env.example fallback for SiliconFlow credentials.");
    hasLoggedEnvExampleFallback = true;
  }

  return {
    apiKey,
    baseUrl,
    model,
  };
}

/**
 * Read root .env.example as a local fallback source.
 * @returns Parsed partial config from .env.example.
 */
function readEnvExampleConfig(): Partial<SiliconFlowRuntimeConfig> {
  if (cachedEnvExampleConfig) {
    return cachedEnvExampleConfig;
  }

  const envExamplePath = path.join(process.cwd(), ".env.example");
  if (!existsSync(envExamplePath)) {
    cachedEnvExampleConfig = {};
    return cachedEnvExampleConfig;
  }

  const parsed = parseSimpleEnvFile(readFileSync(envExamplePath, "utf8"));
  cachedEnvExampleConfig = {
    apiKey: parsed.SILICONFLOW_API_KEY,
    baseUrl: parsed.SILICONFLOW_BASE_URL,
    model: parsed.SILICONFLOW_MODEL,
  };
  return cachedEnvExampleConfig;
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
