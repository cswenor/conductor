# Conductor PM Engine Data Model

Status: Draft v2 (implementation-ready foundation)
Audience: PM engine, orchestration, analytics, and MCP tool developers
Updated: 2026-02-19

## Scope
This document defines the local-first SQLite data model for Conductor's AI-optimized PM engine.

Goals:
- Replace GitHub Projects as the planning/intelligence source of truth.
- Keep GitHub Issues/PRs as collaboration artifacts and sync them into local projections.
- Provide first-class dependency graph operations: cycle prevention, closure, critical path.
- Preserve a complete immutable event stream for analytics, forecasting, and replay.
- Persist decision/outcome memory for agent reuse across sessions and projects.
- Support both sprint and continuous-flow (Kanban) teams with one schema.

Assumptions:
- Existing Conductor tables already exist: `projects`, `repos`, `runs`, `tasks`, `events`.
- SQLite features enabled: `JSON1`, `FTS5`, partial indexes, recursive CTEs.
- Time fields use ISO-8601 UTC text.

## Entity Relationship Diagram (ASCII)

```text
projects ─┬─< repos
          ├─< pm_stakeholders
          ├─< pm_work_items >─────────────┬─< pm_work_item_labels
          │      │                        ├─< pm_external_items >─ repos
          │      │                        ├─< pm_work_item_repo_links >─ repos
          │      │                        ├─1 pm_work_item_ai_current ─< pm_work_item_ai_history
          │      │                        ├─1 pm_value_profiles ─< pm_value_profile_history
          │      │                        ├─< pm_work_item_stakeholders >─ pm_stakeholders
          │      │                        ├─< pm_urgency_signals >─ pm_stakeholders
          │      │                        ├─< pm_decisions ─< pm_outcomes
          │      │                        ├─< pm_review_findings
          │      │                        ├─< pm_iteration_items >─ pm_iterations
          │      │                        └─< pm_dependencies (self: predecessor→successor)
          │      └─< pm_initiative_items >─ pm_initiatives
          ├─< pm_events >─ pm_event_types
          ├─1 pm_event_project_sequences
          └─< pm_sync_cursors / pm_sync_inbox / pm_sync_conflicts

pm_dependencies ─< pm_dependency_closure
pm_work_items   ─1 pm_dependency_metrics
pm_decisions    ─< pm_decision_tags
pm_outcomes     ─< pm_outcome_tags
pm_decisions    ─> pm_decisions_fts (FTS5)
pm_outcomes     ─> pm_outcomes_fts (FTS5)
```

## AI-Computed Field Model

AI should compute/enrich these fields, not set by humans directly:

| Field | Table | Type | Why it is computed |
|---|---|---|---|
| `spec_readiness` | `pm_work_item_ai_current` | `REAL [0..1]` | Derived from spec completeness, ambiguity, acceptance criteria quality |
| `rework_probability` | `pm_work_item_ai_current` | `REAL [0..1]` | Predicted from historical outcomes, change churn, review history |
| `bottleneck_score` | `pm_work_item_ai_current` | `REAL [0..100]` | Graph centrality + waiting-time risk + owner capacity constraints |
| `estimated_cycle_hours_p50/p80/p95` | `pm_work_item_ai_current` | `REAL` | Forecast from cycle-time cohorts and item features |
| `predicted_blocked_probability` | `pm_work_item_ai_current` | `REAL [0..1]` | Forecast from dependency and ownership patterns |
| `predicted_review_cycles` | `pm_work_item_ai_current` | `REAL >= 0` | Forecast from finding history and item risk profile |
| `forecast_confidence` | `pm_work_item_ai_current` | `REAL [0..1]` | Confidence based on sample quality/drift |
| `dependency_depth` | `pm_work_item_ai_current` | `INTEGER` | Derived from closure graph |
| `critical_path_rank` | `pm_work_item_ai_current` | `INTEGER` | Position on current longest-path projection |
| `value_score` | `pm_work_item_ai_current` | `REAL` | Composite value output used by ranking |
| `cost_of_delay_per_week` | `pm_work_item_ai_current` | `REAL` | Computed from value dimensions + urgency signals |
| `wsjf_score` | `pm_work_item_ai_current` | `REAL` | Computed economics-based ranking value |

Pattern:
- `pm_work_item_ai_current` stores latest low-latency ranking fields.
- `pm_work_item_ai_history` stores full snapshots for calibration/drift/postmortem.
- Human-entered values stay in `pm_work_items`, `pm_value_profiles`, and stakeholder tables.

## Full SQL Schema (SQLite)

```sql
-- BEGIN PM ENGINE DDL
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ============================================================
-- Stakeholders
-- Phase: 2 (post-MVP). Schema is defined now for forward compatibility.
-- MVP uses issue creator + priority band for urgency signals.
-- ============================================================

CREATE TABLE pm_stakeholders (
  stakeholder_id INTEGER PRIMARY KEY,
  stakeholder_uid TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,

  stakeholder_type TEXT NOT NULL
    CHECK (stakeholder_type IN (
      'internal_user',
      'internal_team',
      'customer',
      'partner',
      'executive',
      'compliance',
      'system'
    )),

  name TEXT NOT NULL,
  team_name TEXT,
  org_name TEXT,
  role_title TEXT,
  contact_ref TEXT,

  influence_weight REAL NOT NULL DEFAULT 0.50
    CHECK (influence_weight BETWEEN 0.0 AND 1.0),

  escalation_sla_hours REAL
    CHECK (escalation_sla_hours IS NULL OR escalation_sla_hours >= 0.0),

  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_pm_stakeholders_project_active
  ON pm_stakeholders(project_id, is_active, influence_weight DESC);

CREATE INDEX idx_pm_stakeholders_project_name
  ON pm_stakeholders(project_id, name);

-- ============================================================
-- Work Items (Core Unit)
-- ============================================================

CREATE TABLE pm_work_items (
  work_item_id INTEGER PRIMARY KEY,
  work_item_uid TEXT NOT NULL UNIQUE,

  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  primary_repo_id TEXT REFERENCES repos(repo_id) ON DELETE SET NULL,
  parent_work_item_id INTEGER REFERENCES pm_work_items(work_item_id) ON DELETE SET NULL,

  title TEXT NOT NULL,
  body_md TEXT NOT NULL DEFAULT '',
  acceptance_criteria_md TEXT NOT NULL DEFAULT '',

  item_type TEXT NOT NULL
    CHECK (item_type IN ('epic', 'feature', 'bug', 'chore', 'spike', 'incident', 'task')),

  state TEXT NOT NULL
    CHECK (state IN ('backlog', 'ready', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled')),

  priority_band TEXT NOT NULL DEFAULT 'p2'
    CHECK (priority_band IN ('p0', 'p1', 'p2', 'p3', 'p4')),

  risk_level TEXT NOT NULL DEFAULT 'medium'
    CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),

  size_bucket TEXT CHECK (size_bucket IN ('xs', 's', 'm', 'l', 'xl')),
  area TEXT,
  subarea TEXT,

  owner_actor_id TEXT,
  requested_by_stakeholder_id INTEGER REFERENCES pm_stakeholders(stakeholder_id) ON DELETE SET NULL,

  source_of_truth TEXT NOT NULL DEFAULT 'conductor'
    CHECK (source_of_truth IN ('conductor', 'github', 'imported')),

  due_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  archived_at TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,

  version INTEGER NOT NULL DEFAULT 0,

  CHECK (due_at IS NULL OR due_at >= created_at),
  CHECK (started_at IS NULL OR started_at >= created_at),
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK (cancelled_at IS NULL OR cancelled_at >= created_at),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX idx_pm_work_items_project_state_priority
  ON pm_work_items(project_id, state, priority_band, updated_at DESC);

CREATE INDEX idx_pm_work_items_project_area_state
  ON pm_work_items(project_id, area, state, updated_at DESC);

CREATE INDEX idx_pm_work_items_project_due_open
  ON pm_work_items(project_id, due_at)
  WHERE due_at IS NOT NULL AND state NOT IN ('done', 'cancelled');

CREATE INDEX idx_pm_work_items_project_owner_open
  ON pm_work_items(project_id, owner_actor_id, state, updated_at DESC)
  WHERE owner_actor_id IS NOT NULL AND state NOT IN ('done', 'cancelled');

CREATE INDEX idx_pm_work_items_repo_state
  ON pm_work_items(primary_repo_id, state, updated_at DESC);

CREATE INDEX idx_pm_work_items_parent
  ON pm_work_items(parent_work_item_id);

CREATE INDEX idx_pm_work_items_project_activity
  ON pm_work_items(project_id, last_activity_at DESC);

-- ============================================================
-- Work Item Metadata and Cross-Repo Mapping
-- ============================================================

CREATE TABLE pm_work_item_labels (
  work_item_id INTEGER NOT NULL REFERENCES pm_work_items(work_item_id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  label_source TEXT NOT NULL CHECK (label_source IN ('github', 'conductor', 'derived')),
  created_at TEXT NOT NULL,

  PRIMARY KEY (work_item_id, label)
) WITHOUT ROWID;

CREATE INDEX idx_pm_work_item_labels_label
  ON pm_work_item_labels(label, work_item_id);

CREATE TABLE pm_work_item_repo_links (
  work_item_id INTEGER NOT NULL REFERENCES pm_work_items(work_item_id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,

  link_type TEXT NOT NULL CHECK (link_type IN ('primary', 'affected', 'dependent', 'reference')),

  created_at TEXT NOT NULL,

  PRIMARY KEY (work_item_id, repo_id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX ux_pm_work_item_repo_links_primary
  ON pm_work_item_repo_links(work_item_id)
  WHERE link_type = 'primary';

CREATE INDEX idx_pm_work_item_repo_links_repo
  ON pm_work_item_repo_links(repo_id, work_item_id);

CREATE TABLE pm_external_items (
  external_item_id INTEGER PRIMARY KEY,
  work_item_id INTEGER NOT NULL REFERENCES pm_work_items(work_item_id) ON DELETE CASCADE,

  source_system TEXT NOT NULL CHECK (source_system IN ('github', 'gitlab', 'linear', 'jira', 'manual_import')),
  repo_id TEXT REFERENCES repos(repo_id) ON DELETE SET NULL,

  external_node_id TEXT,
  external_number INTEGER,
  external_key TEXT NOT NULL,
  external_url TEXT,

  external_state TEXT,
  external_etag TEXT,
  external_updated_at TEXT,
  last_synced_at TEXT NOT NULL,

  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1))
);

CREATE UNIQUE INDEX ux_pm_external_items_node
  ON pm_external_items(source_system, external_node_id)
  WHERE external_node_id IS NOT NULL;

CREATE UNIQUE INDEX ux_pm_external_items_number
  ON pm_external_items(source_system, repo_id, external_number)
  WHERE repo_id IS NOT NULL AND external_number IS NOT NULL;

CREATE UNIQUE INDEX ux_pm_external_items_key
  ON pm_external_items(source_system, external_key);

CREATE INDEX idx_pm_external_items_work_item
  ON pm_external_items(work_item_id, is_primary DESC);

CREATE INDEX idx_pm_external_items_sync
  ON pm_external_items(source_system, repo_id, last_synced_at);

-- ============================================================
-- AI Computed Projection (Latest + History)
-- ============================================================

CREATE TABLE pm_work_item_ai_current (
  work_item_id INTEGER PRIMARY KEY REFERENCES pm_work_items(work_item_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,

  computed_at TEXT NOT NULL,
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,

  spec_readiness REAL CHECK (spec_readiness BETWEEN 0.0 AND 1.0),
  rework_probability REAL CHECK (rework_probability BETWEEN 0.0 AND 1.0),
  bottleneck_score REAL CHECK (bottleneck_score BETWEEN 0.0 AND 100.0),

  estimated_cycle_hours_p50 REAL CHECK (estimated_cycle_hours_p50 >= 0.0),
  estimated_cycle_hours_p80 REAL CHECK (estimated_cycle_hours_p80 >= 0.0),
  estimated_cycle_hours_p95 REAL CHECK (estimated_cycle_hours_p95 >= 0.0),

  predicted_blocked_probability REAL CHECK (predicted_blocked_probability BETWEEN 0.0 AND 1.0),
  predicted_review_cycles REAL CHECK (predicted_review_cycles >= 0.0),

  forecast_confidence REAL CHECK (forecast_confidence BETWEEN 0.0 AND 1.0),

  dependency_depth INTEGER CHECK (dependency_depth >= 0),
  critical_path_rank INTEGER CHECK (critical_path_rank >= 0),

  value_score REAL CHECK (value_score >= 0.0),
  cost_of_delay_per_week REAL CHECK (cost_of_delay_per_week >= 0.0),
  wsjf_score REAL,

  next_action TEXT,
  rationale_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(rationale_json)),

  CHECK (
    estimated_cycle_hours_p50 IS NULL
    OR estimated_cycle_hours_p80 IS NULL
    OR estimated_cycle_hours_p80 >= estimated_cycle_hours_p50
  ),

  CHECK (
    estimated_cycle_hours_p80 IS NULL
    OR estimated_cycle_hours_p95 IS NULL
    OR estimated_cycle_hours_p95 >= estimated_cycle_hours_p80
  )
);

CREATE INDEX idx_pm_work_item_ai_current_project_rank
  ON pm_work_item_ai_current(project_id, wsjf_score DESC, value_score DESC, rework_probability ASC, spec_readiness DESC);

CREATE INDEX idx_pm_work_item_ai_current_project_risk
  ON pm_work_item_ai_current(project_id, bottleneck_score DESC, predicted_blocked_probability DESC, rework_probability DESC);

CREATE INDEX idx_pm_work_item_ai_current_refresh
  ON pm_work_item_ai_current(project_id, computed_at);

CREATE TABLE pm_work_item_ai_history (
  ai_snapshot_id INTEGER PRIMARY KEY,
  work_item_id INTEGER NOT NULL REFERENCES pm_work_items(work_item_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,

  computed_at TEXT NOT NULL,
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,

  spec_readiness REAL CHECK (spec_readiness BETWEEN 0.0 AND 1.0),
  rework_probability REAL CHECK (rework_probability BETWEEN 0.0 AND 1.0),
  bottleneck_score REAL CHECK (bottleneck_score BETWEEN 0.0 AND 100.0),

  estimated_cycle_hours_p50 REAL CHECK (estimated_cycle_hours_p50 >= 0.0),
  estimated_cycle_hours_p80 REAL CHECK (estimated_cycle_hours_p80 >= 0.0),
  estimated_cycle_hours_p95 REAL CHECK (estimated_cycle_hours_p95 >= 0.0),

  predicted_blocked_probability REAL CHECK (predicted_blocked_probability BETWEEN 0.0 AND 1.0),
  predicted_review_cycles REAL CHECK (predicted_review_cycles >= 0.0),

  forecast_confidence REAL CHECK (forecast_confidence BETWEEN 0.0 AND 1.0),

  dependency_depth INTEGER CHECK (dependency_depth >= 0),
  critical_path_rank INTEGER CHECK (critical_path_rank >= 0),

  value_score REAL CHECK (value_score >= 0.0),
  cost_of_delay_per_week REAL CHECK (cost_of_delay_per_week >= 0.0),
  wsjf_score REAL,

  feature_vector_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(feature_vector_json)),

  UNIQUE (work_item_id, model_name, model_version, computed_at)
);

CREATE INDEX idx_pm_work_item_ai_history_project_time
  ON pm_work_item_ai_history(project_id, computed_at DESC);

CREATE INDEX idx_pm_work_item_ai_history_work_item_time
  ON pm_work_item_ai_history(work_item_id, computed_at DESC);

-- ============================================================
-- Business Value (Beyond Priority)
-- ============================================================

CREATE TABLE pm_value_profiles (
  work_item_id INTEGER PRIMARY KEY REFERENCES pm_work_items(work_item_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,

  revenue_impact_90d REAL NOT NULL DEFAULT 0.0,
  cost_savings_90d REAL NOT NULL DEFAULT 0.0,

  customer_impact_score REAL NOT NULL DEFAULT 0.0 CHECK (customer_impact_score BETWEEN 0.0 AND 100.0),
  strategic_alignment_score REAL NOT NULL DEFAULT 0.0 CHECK (strategic_alignment_score BETWEEN 0.0 AND 100.0),
  risk_reduction_score REAL NOT NULL DEFAULT 0.0 CHECK (risk_reduction_score BETWEEN 0.0 AND 100.0),
  opportunity_enablement_score REAL NOT NULL DEFAULT 0.0 CHECK (opportunity_enablement_score BETWEEN 0.0 AND 100.0),
  urgency_external_score REAL NOT NULL DEFAULT 0.0 CHECK (urgency_external_score BETWEEN 0.0 AND 100.0),

  effort_hours REAL CHECK (effort_hours IS NULL OR effort_hours >= 0.0),

  cost_of_delay_per_week REAL NOT NULL DEFAULT 0.0 CHECK (cost_of_delay_per_week >= 0.0),
  wsjf_score REAL,
  roi_score REAL,

  confidence REAL NOT NULL DEFAULT 0.50 CHECK (confidence BETWEEN 0.0 AND 1.0),
  scored_by TEXT NOT NULL CHECK (scored_by IN ('manual', 'ai', 'hybrid')),

  assumptions_md TEXT NOT NULL DEFAULT '',

  scored_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_pm_value_profiles_project_wsjf
  ON pm_value_profiles(project_id, wsjf_score DESC, cost_of_delay_per_week DESC);

CREATE INDEX idx_pm_value_profiles_project_roi
  ON pm_value_profiles(project_id, roi_score DESC, confidence DESC);

CREATE TABLE pm_value_profile_history (
  value_snapshot_id INTEGER PRIMARY KEY,
  work_item_id INTEGER NOT NULL REFERENCES pm_work_items(work_item_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,

  captured_at TEXT NOT NULL,
  scored_by TEXT NOT NULL CHECK (scored_by IN ('manual', 'ai', 'hybrid')),

  cost_of_delay_per_week REAL NOT NULL DEFAULT 0.0 CHECK (cost_of_delay_per_week >= 0.0),
  wsjf_score REAL,
  roi_score REAL,
  confidence REAL CHECK (confidence BETWEEN 0.0 AND 1.0),

  breakdown_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(breakdown_json))
);

CREATE INDEX idx_pm_value_profile_history_project_time
  ON pm_value_profile_history(project_id, captured_at DESC);

CREATE INDEX idx_pm_value_profile_history_work_item_time
  ON pm_value_profile_history(work_item_id, captured_at DESC);

-- ============================================================
-- Dependency Graph
-- ============================================================

CREATE TABLE pm_dependencies (
  dependency_id INTEGER PRIMARY KEY,

  predecessor_work_item_id INTEGER NOT NULL REFERENCES pm_work_items(work_item_id) ON DELETE CASCADE,
  successor_work_item_id INTEGER NOT NULL REFERENCES pm_work_items(work_item_id) ON DELETE CASCADE,

  relation_type TEXT NOT NULL CHECK (relation_type IN ('blocks', 'prerequisite', 'related')),
  strength TEXT NOT NULL DEFAULT 'hard' CHECK (strength IN ('hard', 'soft', 'informational')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'invalidated')),

  lag_hours REAL NOT NULL DEFAULT 0.0 CHECK (lag_hours >= 0.0),

  rationale_md TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),

  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,

  resolved_by_actor_id TEXT,
  resolved_at TEXT,

  CHECK (predecessor_work_item_id <> successor_work_item_id),
  CHECK (relation_type <> 'related' OR predecessor_work_item_id < successor_work_item_id),
  CHECK (
    (status = 'active' AND resolved_at IS NULL AND resolved_by_actor_id IS NULL)
    OR
    (status IN ('resolved', 'invalidated') AND resolved_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX ux_pm_dependencies_active
  ON pm_dependencies(predecessor_work_item_id, successor_work_item_id, relation_type)
  WHERE status = 'active';

CREATE INDEX idx_pm_dependencies_successor_open
  ON pm_dependencies(successor_work_item_id, relation_type, predecessor_work_item_id)
  WHERE status = 'active';

CREATE INDEX idx_pm_dependencies_predecessor_open
  ON pm_dependencies(predecessor_work_item_id, relation_type, successor_work_item_id)
  WHERE status = 'active';

CREATE INDEX idx_pm_dependencies_created_at
  ON pm_dependencies(created_at DESC);

-- Cycle prevention for active hard ordering edges
CREATE TRIGGER pm_dependencies_prevent_cycle_insert
BEFORE INSERT ON pm_dependencies
WHEN NEW.status = 'active'
 AND NEW.relation_type IN ('blocks', 'prerequisite')
BEGIN
  WITH RECURSIVE reach(work_item_id) AS (
    SELECT NEW.successor_work_item_id
    UNION
    SELECT d.successor_work_item_id
    FROM pm_dependencies d
    JOIN reach r ON r.work_item_id = d.predecessor_work_item_id
    WHERE d.status = 'active'
      AND d.relation_type IN ('blocks', 'prerequisite')
  )
  SELECT RAISE(ABORT, 'dependency cycle detected')
  FROM reach
  WHERE work_item_id = NEW.predecessor_work_item_id;
END;

CREATE TRIGGER pm_dependencies_prevent_cycle_update
BEFORE UPDATE OF predecessor_work_item_id, successor_work_item_id, relation_type, status
ON pm_dependencies
WHEN NEW.status = 'active'
 AND NEW.relation_type IN ('blocks', 'prerequisite')
BEGIN
  WITH RECURSIVE reach(work_item_id) AS (
    SELECT NEW.successor_work_item_id
    UNION
    SELECT d.successor_work_item_id
    FROM pm_dependencies d
    JOIN reach r ON r.work_item_id = d.predecessor_work_item_id
    WHERE d.status = 'active'
      AND d.relation_type IN ('blocks', 'prerequisite')
      AND d.dependency_id <> OLD.dependency_id
  )
  SELECT RAISE(ABORT, 'dependency cycle detected')
  FROM reach
  WHERE work_item_id = NEW.predecessor_work_item_id;
END;

-- Materialized closure (hard active ordering edges)
CREATE TABLE pm_dependency_closure (
  ancestor_work_item_id INTEGER NOT NULL REFERENCES pm_work_items(work_item_id) ON DELETE CASCADE,
  descendant_work_item_id INTEGER NOT NULL REFERENCES pm_work_items(work_item_id) ON DELETE CASCADE,

  ancestor_project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  descendant_project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,

  shortest_depth INTEGER NOT NULL CHECK (shortest_depth >= 0),
  longest_depth INTEGER NOT NULL CHECK (longest_depth >= shortest_depth),
  path_count INTEGER NOT NULL CHECK (path_count >= 1),

  recomputed_at TEXT NOT NULL,

  PRIMARY KEY (ancestor_work_item_id, descendant_work_item_id)
) WITHOUT ROWID;

CREATE INDEX idx_pm_dependency_closure_descendant
  ON pm_dependency_closure(descendant_project_id, descendant_work_item_id, shortest_depth);

CREATE INDEX idx_pm_dependency_closure_ancestor
  ON pm_dependency_closure(ancestor_project_id, ancestor_work_item_id, shortest_depth);

CREATE TABLE pm_dependency_metrics (
  work_item_id INTEGER PRIMARY KEY REFERENCES pm_work_items(work_item_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,

  open_predecessor_count INTEGER NOT NULL DEFAULT 0 CHECK (open_predecessor_count >= 0),
  open_successor_count INTEGER NOT NULL DEFAULT 0 CHECK (open_successor_count >= 0),
  transitive_predecessor_count INTEGER NOT NULL DEFAULT 0 CHECK (transitive_predecessor_count >= 0),
  transitive_successor_count INTEGER NOT NULL DEFAULT 0 CHECK (transitive_successor_count >= 0),

  critical_path_hours_p50 REAL NOT NULL DEFAULT 0.0 CHECK (critical_path_hours_p50 >= 0.0),
  critical_path_hours_p80 REAL NOT NULL DEFAULT 0.0 CHECK (critical_path_hours_p80 >= 0.0),
  slack_hours_p50 REAL,

  is_on_critical_path INTEGER NOT NULL DEFAULT 0 CHECK (is_on_critical_path IN (0, 1)),
  bottleneck_centrality REAL NOT NULL DEFAULT 0.0 CHECK (bottleneck_centrality >= 0.0),

  recomputed_at TEXT NOT NULL
);

CREATE INDEX idx_pm_dependency_metrics_project_critical
  ON pm_dependency_metrics(project_id, is_on_critical_path DESC, critical_path_hours_p50 DESC);

CREATE INDEX idx_pm_dependency_metrics_project_blockers
  ON pm_dependency_metrics(project_id, open_predecessor_count DESC, transitive_predecessor_count DESC);

-- ============================================================
-- Iterations / Planning Windows (Sprint + Kanban)
-- ============================================================

CREATE TABLE pm_iterations (
  iteration_id INTEGER PRIMARY KEY,
  iteration_uid TEXT NOT NULL UNIQUE,

  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  iteration_type TEXT NOT NULL CHECK (iteration_type IN ('sprint', 'continuous', 'release', 'milestone', 'ad_hoc')),
  methodology_hint TEXT NOT NULL DEFAULT 'none' CHECK (methodology_hint IN ('scrum', 'kanban', 'hybrid', 'none')),

  state TEXT NOT NULL CHECK (state IN ('planned', 'active', 'closed', 'archived')),

  objective_md TEXT NOT NULL DEFAULT '',

  start_at TEXT,
  end_at TEXT,
  closed_at TEXT,

  cadence_days INTEGER CHECK (cadence_days IS NULL OR cadence_days > 0),
  capacity_hours REAL CHECK (capacity_hours IS NULL OR capacity_hours >= 0.0),
  wip_limit INTEGER CHECK (wip_limit IS NULL OR wip_limit >= 0),

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  CHECK (start_at IS NULL OR end_at IS NULL OR start_at <= end_at),
  CHECK ((state <> 'closed') OR closed_at IS NOT NULL)
);

CREATE INDEX idx_pm_iterations_project_state
  ON pm_iterations(project_id, state, start_at, end_at);

CREATE INDEX idx_pm_iterations_project_type
  ON pm_iterations(project_id, iteration_type, state);

CREATE UNIQUE INDEX ux_pm_iterations_single_active_sprint
  ON pm_iterations(project_id, iteration_type)
  WHERE state = 'active' AND iteration_type = 'sprint';

CREATE TABLE pm_iteration_items (
  iteration_id INTEGER NOT NULL REFERENCES pm_iterations(iteration_id) ON DELETE CASCADE,
  work_item_id INTEGER NOT NULL REFERENCES pm_work_items(work_item_id) ON DELETE CASCADE,

  commitment_level TEXT NOT NULL CHECK (commitment_level IN ('committed', 'stretch', 'candidate', 'carryover')),
  allocation_state TEXT NOT NULL CHECK (allocation_state IN ('planned', 'pulled_in', 'in_progress', 'done', 'removed')),

  rank_in_window INTEGER,

  planned_hours REAL CHECK (planned_hours IS NULL OR planned_hours >= 0.0),
  actual_hours REAL CHECK (actual_hours IS NULL OR actual_hours >= 0.0),

  added_at TEXT NOT NULL,
  added_by_actor_id TEXT NOT NULL,

  removed_at TEXT,
  removed_by_actor_id TEXT,

  PRIMARY KEY (iteration_id, work_item_id),

  CHECK ((allocation_state <> 'removed') OR removed_at IS NOT NULL),
  CHECK ((removed_at IS NULL AND removed_by_actor_id IS NULL) OR removed_at IS NOT NULL)
) WITHOUT ROWID;

CREATE INDEX idx_pm_iteration_items_iteration_rank
  ON pm_iteration_items(iteration_id, allocation_state, rank_in_window);

CREATE INDEX idx_pm_iteration_items_work_item_active
  ON pm_iteration_items(work_item_id, iteration_id)
  WHERE allocation_state <> 'removed';

-- ============================================================
-- Stakeholder Attachments and External Urgency
-- Phase: 2 (post-MVP). See Stakeholders note above.
-- ============================================================

CREATE TABLE pm_work_item_stakeholders (
  work_item_id INTEGER NOT NULL REFERENCES pm_work_items(work_item_id) ON DELETE CASCADE,
  stakeholder_id INTEGER NOT NULL REFERENCES pm_stakeholders(stakeholder_id) ON DELETE CASCADE,

  relationship_type TEXT NOT NULL
    CHECK (relationship_type IN ('requester', 'owner', 'approver', 'watcher', 'impacted', 'informed')),

  urgency_bias REAL NOT NULL DEFAULT 1.0 CHECK (urgency_bias BETWEEN 0.0 AND 5.0),
  created_at TEXT NOT NULL,

  PRIMARY KEY (work_item_id, stakeholder_id, relationship_type)
) WITHOUT ROWID;

CREATE INDEX idx_pm_work_item_stakeholders_stakeholder
  ON pm_work_item_stakeholders(stakeholder_id, relationship_type);

CREATE TABLE pm_urgency_signals (
  urgency_signal_id INTEGER PRIMARY KEY,

  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  work_item_id INTEGER NOT NULL REFERENCES pm_work_items(work_item_id) ON DELETE CASCADE,
  stakeholder_id INTEGER REFERENCES pm_stakeholders(stakeholder_id) ON DELETE SET NULL,

  signal_type TEXT NOT NULL
    CHECK (signal_type IN (
      'customer_escalation',
      'production_incident',
      'contract_deadline',
      'regulatory_deadline',
      'exec_request',
      'support_volume_spike',
      'sales_commitment',
      'dependency_window'
    )),

  severity INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 5),
  signal_weight REAL NOT NULL DEFAULT 1.0 CHECK (signal_weight BETWEEN 0.0 AND 5.0),

  source_ref TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),

  raised_at TEXT NOT NULL,
  expires_at TEXT,
  resolved_at TEXT,

  CHECK (expires_at IS NULL OR expires_at >= raised_at),
  CHECK (resolved_at IS NULL OR resolved_at >= raised_at)
);

CREATE INDEX idx_pm_urgency_signals_active
  ON pm_urgency_signals(project_id, work_item_id, severity DESC, raised_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX idx_pm_urgency_signals_project_type
  ON pm_urgency_signals(project_id, signal_type, raised_at DESC);

-- ============================================================
-- Memory System: Decisions and Outcomes
-- ============================================================

CREATE TABLE pm_decisions (
  decision_id INTEGER PRIMARY KEY,
  decision_uid TEXT NOT NULL UNIQUE,

  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  work_item_id INTEGER REFERENCES pm_work_items(work_item_id) ON DELETE SET NULL,
  repo_id TEXT REFERENCES repos(repo_id) ON DELETE SET NULL,

  area TEXT NOT NULL DEFAULT 'general',
  decision_kind TEXT NOT NULL CHECK (decision_kind IN ('architecture', 'product', 'workflow', 'incident_response', 'policy', 'estimation', 'other')),

  title TEXT NOT NULL,
  summary_md TEXT NOT NULL,
  rationale_md TEXT NOT NULL DEFAULT '',
  alternatives_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alternatives_json)),
  expected_outcome_md TEXT,

  status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'superseded', 'rejected')),
  confidence REAL CHECK (confidence BETWEEN 0.0 AND 1.0),

  decided_at TEXT NOT NULL,
  decided_by_actor_id TEXT NOT NULL,

  supersedes_decision_id INTEGER REFERENCES pm_decisions(decision_id) ON DELETE SET NULL,

  keywords_text TEXT NOT NULL DEFAULT '',

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_pm_decisions_project_area_time
  ON pm_decisions(project_id, area, decided_at DESC);

CREATE INDEX idx_pm_decisions_project_status
  ON pm_decisions(project_id, status, decided_at DESC);

CREATE INDEX idx_pm_decisions_work_item
  ON pm_decisions(work_item_id, decided_at DESC);

CREATE TABLE pm_decision_tags (
  decision_id INTEGER NOT NULL REFERENCES pm_decisions(decision_id) ON DELETE CASCADE,
  tag TEXT NOT NULL,

  PRIMARY KEY (decision_id, tag)
) WITHOUT ROWID;

CREATE INDEX idx_pm_decision_tags_tag
  ON pm_decision_tags(tag, decision_id);

CREATE TABLE pm_outcomes (
  outcome_id INTEGER PRIMARY KEY,
  outcome_uid TEXT NOT NULL UNIQUE,

  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  work_item_id INTEGER REFERENCES pm_work_items(work_item_id) ON DELETE SET NULL,
  repo_id TEXT REFERENCES repos(repo_id) ON DELETE SET NULL,
  decision_id INTEGER REFERENCES pm_decisions(decision_id) ON DELETE SET NULL,

  area TEXT NOT NULL DEFAULT 'general',
  outcome_type TEXT NOT NULL CHECK (outcome_type IN ('delivered', 'partial', 'rework', 'rollback', 'incident', 'abandoned')),

  summary_md TEXT NOT NULL,
  root_cause_md TEXT,
  lessons_md TEXT,

  impact_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(impact_json)),

  quality_score REAL CHECK (quality_score BETWEEN 0.0 AND 1.0),
  cycle_hours REAL CHECK (cycle_hours IS NULL OR cycle_hours >= 0.0),

  keywords_text TEXT NOT NULL DEFAULT '',

  recorded_at TEXT NOT NULL,
  recorded_by_actor_id TEXT NOT NULL
);

CREATE INDEX idx_pm_outcomes_project_area_time
  ON pm_outcomes(project_id, area, recorded_at DESC);

CREATE INDEX idx_pm_outcomes_work_item
  ON pm_outcomes(work_item_id, recorded_at DESC);

CREATE INDEX idx_pm_outcomes_decision
  ON pm_outcomes(decision_id, recorded_at DESC);

CREATE TABLE pm_outcome_tags (
  outcome_id INTEGER NOT NULL REFERENCES pm_outcomes(outcome_id) ON DELETE CASCADE,
  tag TEXT NOT NULL,

  PRIMARY KEY (outcome_id, tag)
) WITHOUT ROWID;

CREATE INDEX idx_pm_outcome_tags_tag
  ON pm_outcome_tags(tag, outcome_id);

-- FTS indexes for area + keyword retrieval
CREATE VIRTUAL TABLE pm_decisions_fts USING fts5(
  title,
  summary_md,
  rationale_md,
  expected_outcome_md,
  keywords_text,
  content = 'pm_decisions',
  content_rowid = 'decision_id'
);

CREATE TRIGGER pm_decisions_fts_ai
AFTER INSERT ON pm_decisions
BEGIN
  INSERT INTO pm_decisions_fts(rowid, title, summary_md, rationale_md, expected_outcome_md, keywords_text)
  VALUES (new.decision_id, new.title, new.summary_md, new.rationale_md, new.expected_outcome_md, new.keywords_text);
END;

CREATE TRIGGER pm_decisions_fts_ad
AFTER DELETE ON pm_decisions
BEGIN
  INSERT INTO pm_decisions_fts(pm_decisions_fts, rowid, title, summary_md, rationale_md, expected_outcome_md, keywords_text)
  VALUES ('delete', old.decision_id, old.title, old.summary_md, old.rationale_md, old.expected_outcome_md, old.keywords_text);
END;

CREATE TRIGGER pm_decisions_fts_au
AFTER UPDATE ON pm_decisions
BEGIN
  INSERT INTO pm_decisions_fts(pm_decisions_fts, rowid, title, summary_md, rationale_md, expected_outcome_md, keywords_text)
  VALUES ('delete', old.decision_id, old.title, old.summary_md, old.rationale_md, old.expected_outcome_md, old.keywords_text);

  INSERT INTO pm_decisions_fts(rowid, title, summary_md, rationale_md, expected_outcome_md, keywords_text)
  VALUES (new.decision_id, new.title, new.summary_md, new.rationale_md, new.expected_outcome_md, new.keywords_text);
END;

CREATE VIRTUAL TABLE pm_outcomes_fts USING fts5(
  summary_md,
  root_cause_md,
  lessons_md,
  keywords_text,
  content = 'pm_outcomes',
  content_rowid = 'outcome_id'
);

CREATE TRIGGER pm_outcomes_fts_ai
AFTER INSERT ON pm_outcomes
BEGIN
  INSERT INTO pm_outcomes_fts(rowid, summary_md, root_cause_md, lessons_md, keywords_text)
  VALUES (new.outcome_id, new.summary_md, new.root_cause_md, new.lessons_md, new.keywords_text);
END;

CREATE TRIGGER pm_outcomes_fts_ad
AFTER DELETE ON pm_outcomes
BEGIN
  INSERT INTO pm_outcomes_fts(pm_outcomes_fts, rowid, summary_md, root_cause_md, lessons_md, keywords_text)
  VALUES ('delete', old.outcome_id, old.summary_md, old.root_cause_md, old.lessons_md, old.keywords_text);
END;

CREATE TRIGGER pm_outcomes_fts_au
AFTER UPDATE ON pm_outcomes
BEGIN
  INSERT INTO pm_outcomes_fts(pm_outcomes_fts, rowid, summary_md, root_cause_md, lessons_md, keywords_text)
  VALUES ('delete', old.outcome_id, old.summary_md, old.root_cause_md, old.lessons_md, old.keywords_text);

  INSERT INTO pm_outcomes_fts(rowid, summary_md, root_cause_md, lessons_md, keywords_text)
  VALUES (new.outcome_id, new.summary_md, new.root_cause_md, new.lessons_md, new.keywords_text);
END;

CREATE VIEW pm_memory_entries AS
SELECT
  'decision' AS memory_type,
  d.decision_id AS memory_id,
  d.project_id,
  d.work_item_id,
  d.area,
  d.title AS headline,
  d.summary_md AS summary,
  d.keywords_text,
  d.decided_at AS memory_at
FROM pm_decisions d
UNION ALL
SELECT
  'outcome' AS memory_type,
  o.outcome_id AS memory_id,
  o.project_id,
  o.work_item_id,
  o.area,
  o.outcome_type AS headline,
  o.summary_md AS summary,
  o.keywords_text,
  o.recorded_at AS memory_at
FROM pm_outcomes o;

-- ============================================================
-- Review Findings
-- ============================================================

CREATE TABLE pm_review_findings (
  finding_id INTEGER PRIMARY KEY,
  finding_uid TEXT NOT NULL UNIQUE,

  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  work_item_id INTEGER NOT NULL REFERENCES pm_work_items(work_item_id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,

  source TEXT NOT NULL CHECK (source IN ('agent', 'human', 'ci', 'external')),
  review_context TEXT NOT NULL DEFAULT 'code_review'
    CHECK (review_context IN ('code_review', 'plan_review', 'spec_review', 'pr_comment', 'ci_check')),
  category TEXT NOT NULL CHECK (category IN ('correctness', 'security', 'performance', 'maintainability', 'testing', 'spec', 'scope')),
  severity TEXT NOT NULL CHECK (severity IN ('blocking', 'high', 'medium', 'low', 'suggestion')),
  disposition TEXT NOT NULL CHECK (disposition IN ('open', 'fixed', 'accepted_risk', 'dismissed', 'duplicate')),

  file_path TEXT,
  line INTEGER CHECK (line IS NULL OR line >= 1),
  column_number INTEGER CHECK (column_number IS NULL OR column_number >= 1),

  title TEXT NOT NULL,
  details_md TEXT NOT NULL DEFAULT '',
  suggested_fix_md TEXT,

  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolver_actor_id TEXT,

  validation_outcome TEXT CHECK (validation_outcome IN ('true_positive', 'false_positive', 'needs_followup', 'unknown')),
  validation_recorded_at TEXT,

  CHECK ((resolved_at IS NULL AND resolver_actor_id IS NULL) OR resolved_at IS NOT NULL)
);

CREATE INDEX idx_pm_review_findings_work_open
  ON pm_review_findings(work_item_id, severity, detected_at DESC)
  WHERE disposition = 'open';

CREATE INDEX idx_pm_review_findings_project_open
  ON pm_review_findings(project_id, disposition, severity, detected_at DESC);

CREATE INDEX idx_pm_review_findings_project_source
  ON pm_review_findings(project_id, source, category, detected_at DESC);

CREATE INDEX idx_pm_review_findings_run
  ON pm_review_findings(run_id, detected_at DESC);

-- ============================================================
-- Cross-Project Initiatives
-- Phase: 2 (post-MVP). Schema defined for forward compatibility.
-- MVP operates single-project; initiative tables remain empty.
-- ============================================================

CREATE TABLE pm_initiatives (
  initiative_id INTEGER PRIMARY KEY,
  initiative_uid TEXT NOT NULL UNIQUE,

  owner_project_id TEXT REFERENCES projects(project_id) ON DELETE SET NULL,

  title TEXT NOT NULL,
  description_md TEXT NOT NULL DEFAULT '',

  state TEXT NOT NULL CHECK (state IN ('planned', 'active', 'done', 'cancelled')),

  target_start_at TEXT,
  target_end_at TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  CHECK (target_start_at IS NULL OR target_end_at IS NULL OR target_start_at <= target_end_at)
);

CREATE INDEX idx_pm_initiatives_state
  ON pm_initiatives(state, updated_at DESC);

CREATE TABLE pm_initiative_items (
  initiative_id INTEGER NOT NULL REFERENCES pm_initiatives(initiative_id) ON DELETE CASCADE,
  work_item_id INTEGER NOT NULL REFERENCES pm_work_items(work_item_id) ON DELETE CASCADE,

  role TEXT NOT NULL CHECK (role IN ('objective', 'deliverable', 'enabler', 'follow_up')),

  added_at TEXT NOT NULL,

  PRIMARY KEY (initiative_id, work_item_id)
) WITHOUT ROWID;

CREATE INDEX idx_pm_initiative_items_work_item
  ON pm_initiative_items(work_item_id, initiative_id);

-- ============================================================
-- Immutable Event Stream (Project-wide PM Events)
-- ============================================================

CREATE TABLE pm_event_types (
  event_type TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('lifecycle', 'planning', 'graph', 'quality', 'learning', 'value', 'stakeholder', 'sync', 'governance')),
  description TEXT NOT NULL,
  is_state_transition INTEGER NOT NULL DEFAULT 0 CHECK (is_state_transition IN (0, 1)),
  payload_schema_json TEXT
) WITHOUT ROWID;

CREATE TABLE pm_event_project_sequences (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE pm_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uid TEXT NOT NULL UNIQUE,

  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,

  stream_type TEXT NOT NULL
    CHECK (stream_type IN ('work_item', 'dependency', 'iteration', 'decision', 'outcome', 'review_finding', 'urgency_signal', 'initiative', 'sync')),

  stream_id TEXT NOT NULL,

  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('work_item', 'dependency', 'iteration', 'decision', 'outcome', 'review_finding', 'urgency_signal', 'initiative', 'sync')),

  entity_id INTEGER,

  event_type TEXT NOT NULL REFERENCES pm_event_types(event_type),

  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'system', 'external')),
  actor_id TEXT NOT NULL,

  -- source tracks ingestion origin, not provider. Provider is on pm_external_items.source_system.
  source TEXT NOT NULL CHECK (source IN ('conductor', 'provider_webhook', 'provider_poll', 'manual', 'ai', 'migration')),

  correlation_id TEXT,
  causation_event_id INTEGER REFERENCES pm_events(event_id),

  idempotency_key TEXT NOT NULL,

  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),

  is_backfill INTEGER NOT NULL DEFAULT 0 CHECK (is_backfill IN (0, 1)),

  UNIQUE (project_id, sequence),
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX idx_pm_events_stream
  ON pm_events(project_id, stream_type, stream_id, sequence DESC);

CREATE INDEX idx_pm_events_type_time
  ON pm_events(project_id, event_type, occurred_at DESC);

CREATE INDEX idx_pm_events_entity
  ON pm_events(project_id, entity_type, entity_id, sequence DESC);

CREATE INDEX idx_pm_events_correlation
  ON pm_events(correlation_id);

CREATE TRIGGER pm_events_sequence_guard
BEFORE INSERT ON pm_events
BEGIN
  INSERT INTO pm_event_project_sequences(project_id, last_sequence, updated_at)
  VALUES (
    NEW.project_id,
    0,
    COALESCE(NEW.recorded_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )
  ON CONFLICT(project_id) DO NOTHING;

  SELECT CASE
    WHEN NEW.sequence <> (
      SELECT last_sequence + 1
      FROM pm_event_project_sequences
      WHERE project_id = NEW.project_id
    )
    THEN RAISE(ABORT, 'pm_events sequence must be contiguous per project')
  END;
END;

CREATE TRIGGER pm_events_sequence_commit
AFTER INSERT ON pm_events
BEGIN
  UPDATE pm_event_project_sequences
  SET
    last_sequence = NEW.sequence,
    updated_at = COALESCE(NEW.recorded_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE project_id = NEW.project_id;
END;

CREATE TRIGGER pm_events_no_update
BEFORE UPDATE ON pm_events
BEGIN
  SELECT RAISE(ABORT, 'pm_events is append-only');
END;

CREATE TRIGGER pm_events_no_delete
BEFORE DELETE ON pm_events
BEGIN
  SELECT RAISE(ABORT, 'pm_events is append-only');
END;

-- ============================================================
-- Sync Layer (Provider-Agnostic Migration + Steady-State Ingest)
-- Supports GitHub (Phase 1), GitLab/Linear/Jira (Phase 2+).
-- source_system column discriminates provider-specific behavior.
-- ============================================================

CREATE TABLE pm_sync_cursors (
  sync_cursor_id INTEGER PRIMARY KEY,

  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  -- repo_id is nullable: Jira/Linear cursors may be project-level without a repo.
  repo_id TEXT REFERENCES repos(repo_id) ON DELETE CASCADE,

  source_system TEXT NOT NULL CHECK (source_system IN ('github', 'gitlab', 'linear', 'jira', 'manual_import')),
  cursor_kind TEXT NOT NULL CHECK (cursor_kind IN ('issues', 'issue_events', 'issue_comments', 'timeline', 'merge_requests', 'projects')),

  cursor_value TEXT,

  last_attempted_sync_at TEXT,
  last_successful_sync_at TEXT,

  backfill_complete INTEGER NOT NULL DEFAULT 0 CHECK (backfill_complete IN (0, 1)),
  last_error TEXT,

  -- Composite key uses COALESCE for nullable repo_id
  UNIQUE (project_id, COALESCE(repo_id, '__no_repo__'), source_system, cursor_kind)
);

CREATE INDEX idx_pm_sync_cursors_repo
  ON pm_sync_cursors(repo_id, cursor_kind);

CREATE TABLE pm_sync_inbox (
  inbox_id INTEGER PRIMARY KEY,

  source_system TEXT NOT NULL CHECK (source_system IN ('github', 'gitlab', 'linear', 'jira', 'manual_import')),
  delivery_id TEXT NOT NULL,

  project_id TEXT REFERENCES projects(project_id) ON DELETE SET NULL,
  repo_id TEXT REFERENCES repos(repo_id) ON DELETE SET NULL,

  event_type TEXT NOT NULL,

  received_at TEXT NOT NULL,
  processed_at TEXT,

  status TEXT NOT NULL CHECK (status IN ('received', 'processed', 'failed', 'ignored')),

  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  normalized_pm_event_id INTEGER REFERENCES pm_events(event_id),

  error_message TEXT,

  UNIQUE (source_system, delivery_id)
);

CREATE INDEX idx_pm_sync_inbox_status_received
  ON pm_sync_inbox(status, received_at)
  WHERE status IN ('received', 'failed');

CREATE INDEX idx_pm_sync_inbox_repo_time
  ON pm_sync_inbox(repo_id, received_at DESC);

CREATE TABLE pm_sync_conflicts (
  conflict_id INTEGER PRIMARY KEY,

  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  repo_id TEXT REFERENCES repos(repo_id) ON DELETE SET NULL,
  work_item_id INTEGER REFERENCES pm_work_items(work_item_id) ON DELETE SET NULL,

  source_system TEXT NOT NULL CHECK (source_system IN ('github', 'gitlab', 'linear', 'jira', 'manual_import')),
  field_name TEXT NOT NULL,

  local_value_json TEXT NOT NULL CHECK (json_valid(local_value_json)),
  remote_value_json TEXT NOT NULL CHECK (json_valid(remote_value_json)),

  resolution TEXT NOT NULL CHECK (resolution IN ('pending', 'kept_local', 'accepted_remote', 'merged')),

  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_actor_id TEXT
);

CREATE INDEX idx_pm_sync_conflicts_pending
  ON pm_sync_conflicts(project_id, resolution, detected_at DESC)
  WHERE resolution = 'pending';

-- ============================================================
-- Event Subscriptions (Push Notifications)
-- ============================================================

CREATE TABLE pm_event_subscriptions (
  subscription_id TEXT PRIMARY KEY,

  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  subscriber_id TEXT NOT NULL,
  subscriber_type TEXT NOT NULL CHECK (subscriber_type IN ('webhook', 'a2a_callback')),
  -- SSE and WebSocket are connection-based, not stored subscriptions.
  -- They are handled at the transport layer, not in the database.

  callback_url TEXT NOT NULL,

  filter_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(filter_json)),
  -- JSON object matching EventFilterSchema: event_types, entity_types, work_item_ids, etc.

  ttl_hours INTEGER NOT NULL DEFAULT 24 CHECK (ttl_hours >= 1 AND ttl_hours <= 720),

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),

  last_delivery_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  -- Auto-deactivate after 5 consecutive failures
  CHECK (consecutive_failures >= 0)
);

CREATE INDEX idx_pm_event_subscriptions_active
  ON pm_event_subscriptions(project_id, is_active, expires_at)
  WHERE is_active = 1;

CREATE INDEX idx_pm_event_subscriptions_expiry
  ON pm_event_subscriptions(expires_at)
  WHERE is_active = 1;

CREATE TABLE pm_event_delivery_log (
  delivery_id INTEGER PRIMARY KEY AUTOINCREMENT,

  subscription_id TEXT NOT NULL REFERENCES pm_event_subscriptions(subscription_id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES pm_events(event_id) ON DELETE CASCADE,

  attempted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status TEXT NOT NULL CHECK (status IN ('delivered', 'failed', 'retrying')),
  http_status INTEGER,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_pm_event_delivery_log_sub
  ON pm_event_delivery_log(subscription_id, attempted_at DESC);

-- ============================================================
-- Project Settings (Per-Project Configuration)
-- ============================================================

CREATE TABLE pm_project_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,

  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  -- JSON object with configurable per-project knobs:
  -- {
  --   "capacity": { "ewma_alpha": 0.3 },
  --   "velocity": { "trend_threshold": 1.15 },
  --   "anomaly": { "cooldown_hours": 48, "freeze_windows": [] },
  --   "sync": { "source_systems": ["github"] }
  -- }

  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- END PM ENGINE DDL
```

## Event Type Catalog

Seed `pm_event_types` with at least these families.

Lifecycle:
- `work_item.created`
- `work_item.synced`
- `work_item.updated`
- `work_item.state_changed`
- `work_item.completed`
- `work_item.reopened`
- `work_item.cancelled`

Dependency graph:
- `dependency.added`
- `dependency.updated`
- `dependency.resolved`
- `dependency.cycle_rejected`
- `graph.closure_recomputed`
- `graph.critical_path_recomputed`

Planning windows:
- `iteration.created`
- `iteration.state_changed`
- `iteration.capacity_changed`
- `iteration.item_added`
- `iteration.item_removed`
- `iteration.item_reordered`

Quality/review:
- `review.finding_opened`
- `review.finding_fixed`
- `review.finding_dismissed`
- `review.calibration_recorded`

Learning/memory:
- `decision.recorded`
- `decision.superseded`
- `outcome.recorded`
- `prediction.refreshed`

Value/stakeholder:
- `value.profile_scored`
- `urgency.signal_raised`
- `urgency.signal_resolved`

Sync/governance:
- `sync.backfill_started`
- `sync.backfill_completed`
- `sync.delta_applied`
- `sync.cursor_advanced`
- `sync.conflict_detected`

Required event metadata:
- `project_id`, `sequence`, `event_type`, `occurred_at`, `recorded_at`
- `actor_type`, `actor_id`, `source`
- `idempotency_key`
- `correlation_id` for flow grouping
- `causation_event_id` for lineage
- `payload_json` with `schema_version`

## Query Pattern Catalog (20 Hot Queries)

### 1) Next Best Ready Work Item (Unblocked + ROI Aware)
```sql
SELECT
  wi.work_item_id,
  wi.title,
  wi.state,
  ai.wsjf_score,
  ai.value_score,
  ai.spec_readiness,
  ai.rework_probability,
  COALESCE(u.urgency_score, 0.0) AS urgency_score
FROM pm_work_items wi
JOIN pm_work_item_ai_current ai ON ai.work_item_id = wi.work_item_id
LEFT JOIN (
  SELECT
    work_item_id,
    SUM(severity * signal_weight) AS urgency_score
  FROM pm_urgency_signals
  WHERE resolved_at IS NULL
    AND (expires_at IS NULL OR expires_at > :now)
  GROUP BY work_item_id
) u ON u.work_item_id = wi.work_item_id
WHERE wi.project_id = :project_id
  AND wi.state IN ('backlog', 'ready')
  AND NOT EXISTS (
    SELECT 1
    FROM pm_dependencies d
    JOIN pm_work_items pred ON pred.work_item_id = d.predecessor_work_item_id
    WHERE d.successor_work_item_id = wi.work_item_id
      AND d.status = 'active'
      AND d.relation_type IN ('blocks', 'prerequisite')
      AND pred.state NOT IN ('done', 'cancelled')
  )
ORDER BY
  urgency_score DESC,
  COALESCE(ai.wsjf_score, 0.0) DESC,
  COALESCE(ai.value_score, 0.0) DESC,
  COALESCE(ai.rework_probability, 1.0) ASC
LIMIT :limit;
```

### 2) Direct Active Blockers for a Work Item
```sql
SELECT
  d.dependency_id,
  d.relation_type,
  d.strength,
  pred.work_item_id AS blocker_work_item_id,
  pred.title AS blocker_title,
  pred.state AS blocker_state,
  d.created_at
FROM pm_dependencies d
JOIN pm_work_items pred ON pred.work_item_id = d.predecessor_work_item_id
WHERE d.successor_work_item_id = :work_item_id
  AND d.status = 'active'
  AND d.relation_type IN ('blocks', 'prerequisite')
ORDER BY pred.priority_band, d.created_at;
```

### 3) Full Transitive Blocker Chain
```sql
SELECT
  c.ancestor_work_item_id AS blocker_work_item_id,
  wi.title,
  wi.state,
  c.shortest_depth,
  c.path_count
FROM pm_dependency_closure c
JOIN pm_work_items wi ON wi.work_item_id = c.ancestor_work_item_id
WHERE c.descendant_work_item_id = :work_item_id
  AND c.shortest_depth > 0
ORDER BY c.shortest_depth, blocker_work_item_id;
```

### 4) Pre-check: Would New Edge Create a Cycle?
```sql
WITH RECURSIVE reachable(work_item_id) AS (
  SELECT :successor_work_item_id
  UNION
  SELECT d.successor_work_item_id
  FROM pm_dependencies d
  JOIN reachable r ON r.work_item_id = d.predecessor_work_item_id
  WHERE d.status = 'active'
    AND d.relation_type IN ('blocks', 'prerequisite')
)
SELECT EXISTS (
  SELECT 1
  FROM reachable
  WHERE work_item_id = :predecessor_work_item_id
) AS would_cycle;
```

### 5) Critical Path in Active Iteration
```sql
SELECT
  wi.work_item_id,
  wi.title,
  dm.critical_path_hours_p50,
  dm.slack_hours_p50
FROM pm_iteration_items ii
JOIN pm_iterations i ON i.iteration_id = ii.iteration_id
JOIN pm_work_items wi ON wi.work_item_id = ii.work_item_id
JOIN pm_dependency_metrics dm ON dm.work_item_id = wi.work_item_id
WHERE i.project_id = :project_id
  AND i.state = 'active'
  AND ii.allocation_state <> 'removed'
  AND dm.is_on_critical_path = 1
ORDER BY dm.critical_path_hours_p50 DESC;
```

### 6) Bottleneck Queue (Active Work)
```sql
SELECT
  wi.work_item_id,
  wi.title,
  wi.state,
  ai.bottleneck_score,
  dm.open_predecessor_count,
  CAST((julianday(:now) - julianday(wi.last_activity_at)) * 24 AS INTEGER) AS inactivity_hours
FROM pm_work_items wi
JOIN pm_work_item_ai_current ai ON ai.work_item_id = wi.work_item_id
LEFT JOIN pm_dependency_metrics dm ON dm.work_item_id = wi.work_item_id
WHERE wi.project_id = :project_id
  AND wi.state IN ('in_progress', 'blocked', 'in_review')
ORDER BY ai.bottleneck_score DESC, dm.open_predecessor_count DESC, inactivity_hours DESC
LIMIT :limit;
```

### 7) Risk Radar (Spec Risk + Rework Risk)
```sql
SELECT
  wi.work_item_id,
  wi.title,
  wi.state,
  ai.spec_readiness,
  ai.rework_probability,
  wi.risk_level
FROM pm_work_items wi
JOIN pm_work_item_ai_current ai ON ai.work_item_id = wi.work_item_id
WHERE wi.project_id = :project_id
  AND wi.state IN ('ready', 'in_progress')
  AND ai.spec_readiness < :spec_threshold
  AND ai.rework_probability > :rework_threshold
ORDER BY ai.rework_probability DESC, ai.spec_readiness ASC;
```

### 8) Stale AI Projections That Need Refresh
```sql
SELECT
  wi.work_item_id,
  wi.title,
  wi.state,
  ai.computed_at
FROM pm_work_items wi
LEFT JOIN pm_work_item_ai_current ai ON ai.work_item_id = wi.work_item_id
WHERE wi.project_id = :project_id
  AND wi.state NOT IN ('done', 'cancelled')
  AND (ai.work_item_id IS NULL OR ai.computed_at < :refresh_before)
ORDER BY (ai.work_item_id IS NULL) DESC, ai.computed_at ASC, wi.updated_at DESC
LIMIT :limit;
```

### 9) Iteration Capacity vs Forecasted Load
```sql
SELECT
  i.iteration_id,
  i.name,
  i.capacity_hours,
  SUM(COALESCE(ai.estimated_cycle_hours_p50, 0.0)) AS forecast_hours_p50,
  SUM(COALESCE(ai.estimated_cycle_hours_p80, 0.0)) AS forecast_hours_p80,
  (i.capacity_hours - SUM(COALESCE(ai.estimated_cycle_hours_p50, 0.0))) AS remaining_capacity_p50
FROM pm_iterations i
JOIN pm_iteration_items ii ON ii.iteration_id = i.iteration_id
JOIN pm_work_items wi ON wi.work_item_id = ii.work_item_id
LEFT JOIN pm_work_item_ai_current ai ON ai.work_item_id = wi.work_item_id
WHERE i.project_id = :project_id
  AND i.state = 'active'
  AND ii.allocation_state <> 'removed'
GROUP BY i.iteration_id, i.name, i.capacity_hours;
```

### 10) Sprint Carryover Risk (Active Sprint)
```sql
SELECT
  wi.work_item_id,
  wi.title,
  wi.state,
  ai.estimated_cycle_hours_p80,
  CAST((julianday(i.end_at) - julianday(:now)) * 24.0 AS REAL) AS hours_remaining,
  (COALESCE(ai.estimated_cycle_hours_p80, 0.0) - CAST((julianday(i.end_at) - julianday(:now)) * 24.0 AS REAL)) AS risk_margin_hours
FROM pm_iterations i
JOIN pm_iteration_items ii ON ii.iteration_id = i.iteration_id
JOIN pm_work_items wi ON wi.work_item_id = ii.work_item_id
LEFT JOIN pm_work_item_ai_current ai ON ai.work_item_id = wi.work_item_id
WHERE i.project_id = :project_id
  AND i.iteration_type = 'sprint'
  AND i.state = 'active'
  AND wi.state NOT IN ('done', 'cancelled')
  AND i.end_at IS NOT NULL
ORDER BY risk_margin_hours DESC;
```

### 11) High-Value Items Without Owner
```sql
SELECT
  wi.work_item_id,
  wi.title,
  wi.state,
  ai.value_score,
  ai.wsjf_score
FROM pm_work_items wi
JOIN pm_work_item_ai_current ai ON ai.work_item_id = wi.work_item_id
WHERE wi.project_id = :project_id
  AND wi.owner_actor_id IS NULL
  AND wi.state IN ('backlog', 'ready')
ORDER BY ai.wsjf_score DESC, ai.value_score DESC
LIMIT :limit;
```

### 12) Stakeholder Urgency Scoreboard
```sql
SELECT
  st.stakeholder_id,
  st.name,
  COUNT(us.urgency_signal_id) AS active_signal_count,
  SUM(us.severity * us.signal_weight) AS urgency_score
FROM pm_stakeholders st
JOIN pm_urgency_signals us ON us.stakeholder_id = st.stakeholder_id
WHERE st.project_id = :project_id
  AND st.is_active = 1
  AND us.resolved_at IS NULL
  AND (us.expires_at IS NULL OR us.expires_at > :now)
GROUP BY st.stakeholder_id, st.name
ORDER BY urgency_score DESC, active_signal_count DESC;
```

### 13) Decision Memory Search by Area + Keywords
```sql
SELECT
  d.decision_id,
  d.title,
  d.summary_md,
  d.area,
  d.decided_at,
  bm25(pm_decisions_fts) AS rank
FROM pm_decisions_fts
JOIN pm_decisions d ON d.decision_id = pm_decisions_fts.rowid
WHERE pm_decisions_fts MATCH :query
  AND d.project_id = :project_id
  AND d.area = :area
ORDER BY rank
LIMIT :limit;
```

### 14) Outcome Memory Search by Area + Keywords
```sql
SELECT
  o.outcome_id,
  o.outcome_type,
  o.summary_md,
  o.area,
  o.recorded_at,
  bm25(pm_outcomes_fts) AS rank
FROM pm_outcomes_fts
JOIN pm_outcomes o ON o.outcome_id = pm_outcomes_fts.rowid
WHERE pm_outcomes_fts MATCH :query
  AND o.project_id = :project_id
  AND o.area = :area
ORDER BY rank
LIMIT :limit;
```

### 15) Unified Memory Timeline for an Area
```sql
SELECT
  memory_type,
  memory_id,
  headline,
  summary,
  keywords_text,
  memory_at
FROM pm_memory_entries
WHERE project_id = :project_id
  AND area = :area
ORDER BY memory_at DESC
LIMIT :limit;
```

### 16) Open Blocking Findings for a Work Item
```sql
SELECT
  finding_id,
  severity,
  category,
  title,
  file_path,
  line,
  column_number,
  detected_at
FROM pm_review_findings
WHERE work_item_id = :work_item_id
  AND disposition = 'open'
  AND severity IN ('blocking', 'high')
ORDER BY
  CASE severity
    WHEN 'blocking' THEN 1
    WHEN 'high' THEN 2
    ELSE 3
  END,
  detected_at ASC;
```

### 17) Reviewer Calibration (Agent False Positive Rate)
```sql
SELECT
  category,
  COUNT(*) AS total_findings,
  SUM(CASE WHEN validation_outcome = 'true_positive' THEN 1 ELSE 0 END) AS true_positive_count,
  SUM(CASE WHEN validation_outcome = 'false_positive' THEN 1 ELSE 0 END) AS false_positive_count,
  ROUND(
    1.0 * SUM(CASE WHEN validation_outcome = 'false_positive' THEN 1 ELSE 0 END)
    / NULLIF(COUNT(*), 0),
    3
  ) AS false_positive_rate
FROM pm_review_findings
WHERE project_id = :project_id
  AND source = 'agent'
  AND detected_at >= :from_ts
GROUP BY category
ORDER BY false_positive_rate DESC;
```

### 18) Cross-Project Blockers Impacting a Project
```sql
SELECT
  blocked.project_id AS blocked_project_id,
  blocker.project_id AS blocker_project_id,
  blocked.work_item_id AS blocked_work_item_id,
  blocker.work_item_id AS blocker_work_item_id,
  blocker.title AS blocker_title,
  blocker.state AS blocker_state,
  d.relation_type
FROM pm_dependencies d
JOIN pm_work_items blocked ON blocked.work_item_id = d.successor_work_item_id
JOIN pm_work_items blocker ON blocker.work_item_id = d.predecessor_work_item_id
WHERE d.status = 'active'
  AND d.relation_type IN ('blocks', 'prerequisite')
  AND blocked.project_id = :project_id
  AND blocker.project_id <> blocked.project_id
ORDER BY blocker.project_id, blocker.priority_band;
```

### 19) Event Timeline for One Work Item
```sql
SELECT
  event_id,
  sequence,
  event_type,
  occurred_at,
  actor_type,
  actor_id,
  source,
  payload_json
FROM pm_events
WHERE project_id = :project_id
  AND entity_type = 'work_item'
  AND entity_id = :work_item_id
ORDER BY sequence DESC
LIMIT :limit;
```

### 20) GitHub Issue to Work Item Resolution (Hot Sync Lookup)
```sql
SELECT
  ei.work_item_id,
  wi.project_id,
  wi.state,
  ei.external_updated_at,
  ei.last_synced_at
FROM pm_external_items ei
JOIN pm_work_items wi ON wi.work_item_id = ei.work_item_id
WHERE ei.source_system = 'github'
  AND ei.repo_id = :repo_id
  AND ei.external_number = :issue_number
LIMIT 1;
```

## Design Rationale

1. `pm_work_items` is central, not sprint artifacts.
This supports continuous flow by default and keeps iterations optional overlays.

2. AI-derived state is separated from human-entered state.
`pm_work_item_ai_current` avoids manual drift in computed fields while preserving fast ranking queries.

3. Dependency edges are first-class, typed rows.
No parsing comments/labels for blockers. Edges are queryable, enforceable, and analyzable.

4. Cycle prevention happens at write-time.
Trigger-based DAG protection stops invalid state before it enters the graph.

5. Closure and dependency metrics are materialized projections.
Hot transitive/critical-path reads stay cheap; projection jobs recompute after dependency mutations.

6. Event stream is immutable and idempotent.
`pm_events` + append-only triggers + project-local contiguous sequence provide replayable truth.

7. Memory is explicit, queryable, and optimized for retrieval.
Decisions and outcomes are normalized entities with FTS, tags, area scoping, and timeline views.

8. Business value is multidimensional.
`pm_value_profiles` captures economics and strategic impact, not just priority labels.

9. Stakeholder pressure is modeled directly.
Urgency signals and stakeholder relationships let planning reflect real external demand.

10. Cross-project work is native.
Dependencies, initiatives, and repo links allow multi-repo programs without separate schemas.

11. Sync and conflict handling are first-class and provider-agnostic.
Inbox/cursor/conflict tables make migration and steady-state ingestion deterministic and recoverable. The `source_system` discriminator on sync tables allows the same pipeline to ingest from GitHub, GitLab, Linear, Jira, or manual imports.

12. Review findings distinguish source and context.
The `source` column identifies who generated the finding (agent, human, CI). The `review_context` column identifies what was being reviewed (code, plan, spec, PR comment). This separation enables accurate calibration — an AI code review finding has different false-positive patterns than a human PR comment or a CI check.

## Migration Strategy (Provider-Agnostic Sync Layer Design)

The sync layer is designed to ingest from any issue tracker, not just GitHub. Phase 1 implements GitHub; the same ingress pipeline, normalizer, and conflict resolution model apply to GitLab, Linear, Jira, and manual imports in later phases.

### Phase 0: Preconditions
- Enable schema in one migration and seed `pm_event_types`.
- Build label-to-field mapping rules per project per source system (`type`, `area`, `priority`, `risk`).
- Create initial `pm_event_project_sequences` rows for existing projects with `last_sequence = 0`.

### Phase 1: One-Time Backfill
1. For each repo in `repos`, fetch issues (open + recent closed + timeline).
2. Upsert `pm_work_items` by stable external identity.
3. Insert `pm_external_items` mapping (`source_system='github'`, `external_node_id`, `external_number`).
4. Normalize labels into `pm_work_item_labels`; derive typed fields on work item.
5. Insert `work_item.created` and `work_item.synced` PM events with `is_backfill=1`.
6. Parse dependency text patterns (`blocked by #`, `depends on #`) into `pm_dependencies`.
7. Recompute `pm_dependency_closure` and `pm_dependency_metrics`.
8. Mark cursor rows with `backfill_complete=1`.

### Phase 2: Incremental Webhook + Poller Ingestion
Ingress transaction model:
1. Insert raw delivery into `pm_sync_inbox` using `UNIQUE(source_system, delivery_id)`.
2. Normalize payload into one or more `pm_events` records with deterministic `idempotency_key`.
3. Apply projection mutations (`pm_work_items`, labels, external state, findings, etc.) in same transaction.
4. Advance `pm_sync_cursors`.
5. Mark inbox row `processed` or `failed`.

Fallback poller:
- Poll by cursor for missed deliveries and reuse exact same normalizer/transaction path.

### Phase 3: Field Ownership Rules
GitHub authoritative fields:
- title/body markdown
- open/closed lifecycle signal
- GitHub labels/assignees/comments/timeline facts

Conductor PM authoritative fields:
- dependency graph
- iterations and commitments
- AI projections and forecast fields
- value profiles and urgency aggregation
- decisions/outcomes memory
- review finding calibration

Conflict handling:
- Record mismatches in `pm_sync_conflicts`.
- Resolve via policy (`kept_local`, `accepted_remote`, `merged`) and emit governance event.

### Phase 4: Dual-Write and Cutover
1. Keep GitHub as collaboration surface; PM reads switch to `pm_*` tables.
2. Run dual-write checks for 1-2 weeks:
- issue counts per repo
- open/done parity
- dependency cycle invariants
- contiguous `pm_events.sequence`
3. Cut over MCP planning tools (`next issue`, `plan sprint`, `critical path`, memory retrieval) to PM engine only.

### Phase 5: Recovery and Rebuild Guarantees
- Replay from `pm_sync_inbox` for failed deliveries.
- Rebuild projections from `pm_events` when drift is detected.
- Full repo re-backfill remains safe because upserts + idempotency keys prevent duplication.

### Canonical Mapping: GitHub (Phase 1)

Each source system requires its own field mapping. GitHub is the reference implementation; additional providers follow the same pattern with provider-specific normalizers.

- `issues.node_id` -> `pm_external_items.external_node_id`
- `issues.number` -> `pm_external_items.external_number`
- `issues.title` -> `pm_work_items.title`
- `issues.body` -> `pm_work_items.body_md`
- `issues.state=closed` -> `pm_work_items.state=done` unless explicitly cancelled
- `issues.labels[]` -> `pm_work_item_labels` (+ derived typed fields)
- `issues.assignees[0]` -> `pm_work_items.owner_actor_id` (policy-driven)
- timeline events -> `pm_events` with stable idempotency keys

## Implementation Notes
- Prepare and reuse statements for all hot queries.
- Run `ANALYZE` after large backfills.
- Recompute graph closure incrementally on edge mutations; run nightly full closure rebuild as guardrail.
- Keep all writes transactional: event + projection + cursor update must commit together.
