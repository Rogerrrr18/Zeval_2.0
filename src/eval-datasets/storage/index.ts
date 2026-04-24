/**
 * @fileoverview Dataset storage factory exports.
 */

import type { DatasetStore } from "@/eval-datasets/storage/dataset-store";
import { FileSystemDatasetStore } from "@/eval-datasets/storage/file-system-dataset-store";

/**
 * Create the current dataset storage adapter.
 * @returns Active dataset store implementation.
 */
export function createDatasetStore(options?: { workspaceId?: string }): DatasetStore {
  return new FileSystemDatasetStore(options?.workspaceId);
}

export type { DatasetStore } from "@/eval-datasets/storage/dataset-store";
export type {
  CaseSetType,
  DatasetBaselineRecord,
  DatasetCaseRecord,
  DatasetRunResultRecord,
  DuplicateCheckResult,
  SampleBatchRecord,
} from "@/eval-datasets/storage/types";
