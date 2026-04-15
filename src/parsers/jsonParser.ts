/**
 * @fileoverview JSON parser for raw chatlog rows.
 */

import type { RawChatlogRow } from "@/types/pipeline";

const ALLOWED_ROLES = new Set<RawChatlogRow["role"]>(["user", "assistant", "system"]);

/**
 * Parse JSON text into raw rows.
 * @param text Raw JSON text.
 * @returns Parsed raw chat rows.
 */
export function parseJsonRows(text: string): RawChatlogRow[] {
  const parsed = JSON.parse(text) as unknown;
  const arrayData = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && "messages" in parsed
      ? (parsed as { messages: unknown[] }).messages
      : [];

  return arrayData.flatMap((item, index) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const role = String(record.role ?? "").toLowerCase() as RawChatlogRow["role"];
    if (!ALLOWED_ROLES.has(role)) {
      return [];
    }
    return [
      {
        sessionId: String(record.sessionId ?? "json_session_001"),
        timestamp: String(record.timestamp ?? new Date(Date.now() + index * 1000).toISOString()),
        role,
        content: String(record.content ?? ""),
      },
    ];
  });
}
