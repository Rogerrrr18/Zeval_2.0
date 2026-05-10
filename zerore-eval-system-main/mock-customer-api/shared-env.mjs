import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read SiliconFlow config from process.env first, then project root env files.
 * @returns {{ apiKey?: string, baseUrl: string, model: string }}
 */
export function readSiliconFlowConfig() {
  const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const localEnv = readEnvFile(path.join(rootDirectory, ".env.local"));
  const exampleEnv = readEnvFile(path.join(rootDirectory, ".env.example"));

  return {
    apiKey: process.env.SILICONFLOW_API_KEY || localEnv.SILICONFLOW_API_KEY || exampleEnv.SILICONFLOW_API_KEY,
    baseUrl:
      process.env.SILICONFLOW_BASE_URL ||
      localEnv.SILICONFLOW_BASE_URL ||
      exampleEnv.SILICONFLOW_BASE_URL ||
      "https://api.siliconflow.cn/v1",
    model:
      process.env.SILICONFLOW_MODEL ||
      localEnv.SILICONFLOW_MODEL ||
      exampleEnv.SILICONFLOW_MODEL ||
      "Qwen/Qwen3.5-27B",
  };
}

/**
 * Read a simple env file.
 * @param {string} filePath File path.
 * @returns {Record<string, string>}
 */
function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .reduce((accumulator, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return accumulator;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        return accumulator;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
      accumulator[key] = value;
      return accumulator;
    }, {});
}
