-- Zeval target Supabase schema draft.
-- This is the refactor target, not a direct continuation of the legacy local-json/filesystem compatibility schema.

create extension if not exists pgcrypto;

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan_key text not null default 'dev',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  environment text not null default 'production',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists datasets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  source_kind text not null default 'upload',
  scenario_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists dataset_imports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  dataset_id uuid references datasets(id) on delete set null,
  file_name text,
  format text not null,
  row_count integer not null default 0,
  mapping_plan jsonb,
  pii_redaction jsonb not null default '{}'::jsonb,
  artifact_uri text,
  warnings text[] not null default array[]::text[],
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  dataset_id uuid references datasets(id) on delete set null,
  external_session_id text not null,
  normalized_transcript_hash text,
  started_at timestamptz,
  ended_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (project_id, dataset_id, external_session_id)
);

create table if not exists message_turns (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  session_id uuid not null references sessions(id) on delete cascade,
  turn_index integer not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  timestamp timestamptz,
  timestamp_raw text,
  token_count_estimate integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (session_id, turn_index)
);

create table if not exists evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  dataset_id uuid references datasets(id) on delete set null,
  run_key text not null,
  scenario_id text,
  status text not null default 'succeeded',
  use_llm boolean not null default true,
  session_count integer not null default 0,
  message_count integer not null default 0,
  has_timestamp boolean not null default false,
  warnings text[] not null default array[]::text[],
  report_payload jsonb,
  artifact_uri text,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (project_id, run_key)
);

create table if not exists topic_segments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  evaluation_run_id uuid not null references evaluation_runs(id) on delete cascade,
  session_id uuid not null references sessions(id) on delete cascade,
  topic_segment_key text not null,
  segment_index integer not null,
  label text not null,
  summary text not null,
  source text not null,
  confidence numeric(5,4),
  start_turn integer not null,
  end_turn integer not null,
  message_count integer not null,
  emotion_payload jsonb,
  created_at timestamptz not null default now(),
  unique (evaluation_run_id, topic_segment_key)
);

create table if not exists evidence_spans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  evaluation_run_id uuid references evaluation_runs(id) on delete cascade,
  session_id uuid references sessions(id) on delete cascade,
  topic_segment_id uuid references topic_segments(id) on delete set null,
  turn_id uuid references message_turns(id) on delete set null,
  evidence_kind text not null,
  quote text not null,
  start_turn integer,
  end_turn integer,
  source text not null default 'rule',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists objective_signals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  evaluation_run_id uuid not null references evaluation_runs(id) on delete cascade,
  session_id uuid references sessions(id) on delete cascade,
  topic_segment_id uuid references topic_segments(id) on delete set null,
  metric_key text not null,
  numeric_value numeric,
  string_value text,
  json_value jsonb,
  source text not null default 'rule',
  confidence numeric(5,4),
  evidence_span_id uuid references evidence_spans(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists judge_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  evaluation_run_id uuid references evaluation_runs(id) on delete cascade,
  stage text not null,
  model text not null,
  prompt_version text,
  input_ref jsonb,
  output_json jsonb,
  status text not null,
  latency_ms integer,
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists subjective_signals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  evaluation_run_id uuid not null references evaluation_runs(id) on delete cascade,
  session_id uuid references sessions(id) on delete cascade,
  topic_segment_id uuid references topic_segments(id) on delete set null,
  dimension_key text not null,
  dimension_label text,
  score numeric not null,
  reason text not null,
  source text not null,
  confidence numeric(5,4),
  evidence_span_id uuid references evidence_spans(id) on delete set null,
  judge_run_id uuid references judge_runs(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists risk_tags (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  evaluation_run_id uuid references evaluation_runs(id) on delete cascade,
  session_id uuid references sessions(id) on delete cascade,
  topic_segment_id uuid references topic_segments(id) on delete set null,
  tag_key text not null,
  score numeric,
  severity text,
  reason text,
  triggered_rules jsonb,
  source text not null default 'inferred',
  confidence numeric(5,4),
  evidence_span_id uuid references evidence_spans(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists suggestions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  evaluation_run_id uuid not null references evaluation_runs(id) on delete cascade,
  title text not null,
  problem text not null,
  impact text not null,
  action text not null,
  trigger_metric_keys text[] not null default array[]::text[],
  evidence_span_id uuid references evidence_spans(id) on delete set null,
  priority integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists baselines (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  customer_id text not null,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists baseline_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  baseline_id uuid not null references baselines(id) on delete cascade,
  source_evaluation_run_id uuid references evaluation_runs(id) on delete set null,
  raw_rows_artifact_uri text,
  snapshot_payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists online_eval_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  baseline_run_id uuid references baseline_runs(id) on delete set null,
  current_evaluation_run_id uuid references evaluation_runs(id) on delete set null,
  reply_api_url text not null,
  status text not null default 'queued',
  created_at timestamptz not null default now()
);

create table if not exists eval_cases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  case_set_type text not null check (case_set_type in ('goodcase', 'badcase')),
  title text not null,
  normalized_transcript_hash text not null,
  transcript_payload jsonb not null,
  labels jsonb not null default '{}'::jsonb,
  source text not null default 'imported' check (source in (
    'auto_tp', 'manual_fp', 'auto_fn', 'auto_tn',
    'auto_uncertainty', 'auto_disagreement',
    'synthesized', 'imported'
  )),
  -- MVP: nullable (optional). Phase 2 (P4+) will add NOT NULL once harness attribution is live.
  capability_dimension text check (capability_dimension in (
    'instruction_following', 'multi_turn_coherence', 'long_context_reasoning',
    'task_decomposition', 'tool_calling_correctness', 'workflow_execution',
    'knowledge_grounding', 'safety_refusal', 'style_format',
    'latency_efficiency', 'self_correction', 'human_handoff'
  )),
  failure_layer text check (failure_layer in (
    'L0_model', 'L1_input', 'L2_planning', 'L3_memory', 'L4_retrieval',
    'L5_tool_selection', 'L6_tool_execution', 'L7_state', 'L8_generation'
  )),
  attribution_confidence numeric(4,3),
  attribution_method text check (attribution_method in ('rule', 'llm_classifier', 'experiment', 'manual')),
  source_evaluation_run_id uuid references evaluation_runs(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (project_id, normalized_transcript_hash),
  -- Generalization gate: holdout cases are never exposed to fix authors (see 11-测试与回归.md 11.12 M1)
  -- Post-MVP: holdout split logic is activated in Phase 2 (P4+). For MVP all cases default to holdout=false.
  holdout boolean not null default false
  -- Post-MVP (Phase 2 / P4+): re-enable the constraint below once harness layer attribution is live.
  -- constraint failure_layer_required_for_badcase check (
  --   (case_set_type = 'badcase' and failure_layer is not null)
  --   or (case_set_type = 'goodcase' and failure_layer is null)
  -- )
);

create table if not exists sample_batches (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  seed text,
  target_goodcase_count integer not null default 0,
  target_badcase_count integer not null default 0,
  actual_goodcase_count integer not null default 0,
  actual_badcase_count integer not null default 0,
  warnings text[] not null default array[]::text[],
  created_at timestamptz not null default now()
);

create table if not exists sample_batch_cases (
  sample_batch_id uuid not null references sample_batches(id) on delete cascade,
  eval_case_id uuid not null references eval_cases(id) on delete cascade,
  strata text not null,
  position integer not null,
  primary key (sample_batch_id, eval_case_id)
);

-- Auto admission rules and candidates (see 13-案例池自动入池规则.md)

create table if not exists dataset_admission_rules (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  rule_key text not null,
  case_set_type text not null check (case_set_type in ('goodcase', 'badcase')),
  expression jsonb not null,
  severity text not null default 'medium' check (severity in ('low', 'medium', 'high')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, rule_key)
);

create table if not exists eval_case_candidates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  evaluation_run_id uuid references evaluation_runs(id) on delete cascade,
  session_id uuid references sessions(id) on delete set null,
  case_set_type text not null check (case_set_type in ('goodcase', 'badcase')),
  source text check (source in (
    'auto_tp', 'manual_fp', 'auto_fn', 'auto_tn',
    'auto_uncertainty', 'auto_disagreement',
    'synthesized', 'imported'
  )),
  capability_dimension text not null,
  failure_layer text,
  attribution_confidence numeric(4,3),
  triggered_rules jsonb not null default '[]'::jsonb,
  severity text not null default 'medium',
  snapshot_payload jsonb not null,
  normalized_transcript_hash text not null,
  decision text not null default 'pending_review' check (decision in ('accepted', 'rejected', 'pending_review')),
  decision_reason text,
  near_duplicate_of_case_id uuid references eval_cases(id) on delete set null,
  promoted_eval_case_id uuid references eval_cases(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Capability attribution and experiment routes (see 15-能力维度评测与归因.md)

create table if not exists capability_attributions (
  id uuid primary key default gen_random_uuid(),
  eval_case_id uuid not null references eval_cases(id) on delete cascade,
  capability_dimension text not null,
  failure_layer text not null,
  confidence numeric(4,3) not null,
  method text not null check (method in ('rule', 'llm_classifier', 'experiment', 'manual')),
  experiment_run_id uuid,
  evidence jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists experiment_routes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  target_capability text not null,
  target_layer text not null,
  axis text not null,
  candidates jsonb not null default '[]'::jsonb,
  eval_dataset_id uuid,
  status text not null default 'draft' check (status in ('draft', 'running', 'completed', 'archived')),
  result_summary jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Generalization validation reports (see 11-测试与回归.md 11.12 M1-M5)
-- Stores seen/holdout gen_coeff, bootstrap CI, and cross-capability guard for each validation run.

create table if not exists validation_generalization_reports (
  id uuid primary key default gen_random_uuid(),
  validation_run_id uuid not null references validation_runs(id) on delete cascade,
  -- M1/M5: per-capability generalization coefficient and bootstrap CI
  -- format: { "multi_turn_coherence": { "gen_coeff": 0.82, "seen_improvement_rate": 0.60, "holdout_improvement_rate": 0.49 }, ... }
  gen_coeff_per_capability jsonb not null default '{}'::jsonb,
  -- format: { "multi_turn_coherence": { "mean_delta": 0.08, "ci_95_lower": 0.02, "ci_95_upper": 0.14, "bootstrap_n": 2000, "n_cases": 20 }, ... }
  bootstrap_ci_per_capability jsonb not null default '{}'::jsonb,
  -- M4: cross-capability guard results
  -- format: { "multi_turn_coherence": { "delta": 0.04, "passed": true }, "style_format": { "delta": -0.05, "passed": false }, ... }
  cross_capability_guard jsonb not null default '{}'::jsonb,
  -- M2: capabilities where N < min_n_per_capability
  insufficient_evidence_capabilities text[] not null default array[]::text[],
  -- Overall verdict: passed / failed / insufficient_evidence / generalization_warning
  overall_verdict text not null default 'insufficient_evidence' check (overall_verdict in (
    'passed', 'failed', 'insufficient_evidence', 'generalization_warning'
  )),
  warnings text[] not null default array[]::text[],
  created_at timestamptz not null default now(),
  unique (validation_run_id)
);

-- Sample synthesis (see 14-样本合成与长尾覆盖.md)

create table if not exists synthesis_templates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  default_hints jsonb not null default '[]'::jsonb,
  default_personas jsonb not null default '[]'::jsonb,
  default_expected_failures jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, name)
);

create table if not exists synthesis_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  template_id uuid references synthesis_templates(id) on delete set null,
  request_payload jsonb not null,
  model text not null,
  prompt_version text,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'partial', 'failed')),
  requested_count integer not null default 0,
  accepted_count integer not null default 0,
  rejected_count integer not null default 0,
  warnings text[] not null default array[]::text[],
  created_at timestamptz not null default now()
);

create table if not exists synthesized_samples (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  synthesis_run_id uuid not null references synthesis_runs(id) on delete cascade,
  eval_case_id uuid references eval_cases(id) on delete set null,
  transcript_payload jsonb not null,
  alignment_score numeric(5,4),
  redundancy_score numeric(5,4),
  judge_run_id uuid references judge_runs(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Skill-style remediation packages (see 12-调优包-Skill化交付.md)

create table if not exists remediation_packages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  status text not null default 'draft',
  scope_bad_case_ids uuid[] not null default array[]::uuid[],
  evaluation_run_ids uuid[] not null default array[]::uuid[],
  trigger_metric_keys text[] not null default array[]::text[],
  skill_version text,
  skill_artifact_uri text,
  skill_metadata jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists remediation_artifacts (
  id uuid primary key default gen_random_uuid(),
  remediation_package_id uuid not null references remediation_packages(id) on delete cascade,
  artifact_kind text not null check (artifact_kind in (
    'issue_brief', 'remediation_spec', 'badcases_jsonl', 'acceptance_gate',
    'skill_md', 'metadata_json', 'prompt_md', 'script_md', 'other'
  )),
  filename text not null,
  content_uri text,
  content_inline text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
