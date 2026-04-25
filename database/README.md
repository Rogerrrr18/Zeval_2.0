# Database Architecture

This directory defines the target relational storage model for ZERORE Eval System.

The current app can still run with local files and the local JSON adapter. The database schema is the next production storage target and follows the SEAR-inspired principle documented in `eval-system-概述/5-SEAR数据哲学与下一阶段架构.md`:

> An evaluation is not a single score. It is a set of joinable, traceable and explainable quality signals.

## Storage Roles

- PostgreSQL/Supabase is the intended production system of record.
- Local JSON remains the development fallback and smoke artifact path.
- Evaluate/baseline JSON files remain export and audit snapshots, not the long-term query model.

## Schema Groups

`schema.sql` is organized around the product workflow:

1. `workspaces`, `users`, `workspace_members`, `api_keys`, `audit_logs`
2. `datasets`, `dataset_imports`, `sessions`, `message_turns`, `scenario_contexts`
3. `evaluation_runs`, `topic_segments`, `objective_signals`, `subjective_signals`, `business_kpi_signals`, `evidence_spans`, `risk_tags`
4. `gold_sets`, `gold_cases`, `gold_annotation_tasks`, `gold_label_drafts`, `gold_labels`, `judge_runs`, `judge_predictions`, `judge_agreement_reports`, `judge_drift_reports`
5. `bad_cases`, `bad_case_tags`, `bad_case_clusters`, `remediation_packages`, `remediation_artifacts`, `agent_runs`, `validation_runs`, `validation_results`, `jobs`

## Migration Strategy

The migration should be incremental:

1. Keep the existing pipeline and artifact outputs unchanged.
2. Add an evaluate projection layer that converts `EvaluateResponse` into normalized database records. This is now implemented in `src/db/evaluation-projection.ts`.
3. Write projections through the current `ZeroreDatabase` interface first. Synchronous `/api/evaluate` runs now write these records through the local JSON adapter.
4. Add a Postgres adapter behind the same interface.
5. Migrate gold set, bad case, agent run and validation stores one domain at a time.

## Traceability Rule

Every primary quality signal should be traceable to:

- `workspace_id`
- `run_id`
- `session_id`
- a metric key or signal key
- a source (`rule`, `llm`, `inferred`, `human`, `system`, `import`)
- optional `turn_id`, `segment_id`, `judge_run_id`, `evidence_span_id`

This is the data contract that keeps the product explainable and auditable.
