/**
 * @fileoverview Zod schemas for ingest and evaluate contracts.
 */

import { z } from "zod";

/**
 * Shared raw row schema.
 */
export const rawChatlogRowSchema = z.object({
  sessionId: z.string().min(1),
  timestamp: z.string().min(1),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
});

/**
 * Ingest request schema.
 */
export const ingestRequestSchema = z.object({
  text: z.string().min(1),
  format: z.enum(["csv", "json", "txt", "md"]).optional(),
  fileName: z.string().optional(),
});

/**
 * Evaluate request schema.
 */
export const evaluateRequestSchema = z.object({
  rawRows: z.array(rawChatlogRowSchema).min(1),
  runId: z.string().optional(),
  useLlm: z.boolean().optional(),
  artifactBaseName: z.string().min(1).optional(),
  persistArtifact: z.boolean().optional(),
});
