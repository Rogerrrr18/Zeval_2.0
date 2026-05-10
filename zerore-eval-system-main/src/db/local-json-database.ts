/**
 * @fileoverview Local JSON database adapter used before Postgres migration.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DbRecord, ZeroreDatabase } from "@/db";
import { resolveWorkspacePath } from "@/workspaces/paths";

/**
 * JSON-backed database adapter with workspace partitioning.
 */
export class LocalJsonDatabase implements ZeroreDatabase {
  async upsert(record: DbRecord): Promise<void> {
    const filePath = this.resolveRecordPath(record.workspaceId, record.type, record.id);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  async get(workspaceId: string, type: string, id: string): Promise<DbRecord | null> {
    try {
      return JSON.parse(await readFile(this.resolveRecordPath(workspaceId, type, id), "utf8")) as DbRecord;
    } catch {
      return null;
    }
  }

  async list(workspaceId: string, type: string): Promise<DbRecord[]> {
    const directory = resolveWorkspacePath(workspaceId, "db", type);
    let names: string[] = [];
    try {
      names = await readdir(directory);
    } catch {
      return [];
    }
    const records: DbRecord[] = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      try {
        records.push(JSON.parse(await readFile(path.join(directory, name), "utf8")) as DbRecord);
      } catch {
        continue;
      }
    }
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private resolveRecordPath(workspaceId: string, type: string, id: string): string {
    const safeType = type.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "record";
    const safeId = id.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "unknown";
    return resolveWorkspacePath(workspaceId, "db", safeType, `${safeId}.json`);
  }
}
