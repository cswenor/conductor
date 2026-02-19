# Conductor PM Engine Intelligence Modules

Status: Draft v3.0 (implementation-ready)
Owner: PM Engine
Updated: 2026-02-19

## Scope
This document specifies the intelligence layer for Conductor's AI-optimized PM engine. Each module includes:
- Input data contract
- Algorithm contract (correctness and performance)
- Output payload contract
- Computational complexity
- Caching and invalidation strategy

The spec is aligned with:
- `docs/pm-engine/DATA_MODEL.md`
- `docs/pm-engine/INTERFACES.md`

## Global Conventions

### 1. Time, ordering, and replay
- All timestamps are ISO-8601 UTC.
- `pm_events` is authoritative event order via `(project_id, sequence)`.
- Any module that reconstructs history MUST process events in ascending `sequence`.
- Rebuilds MUST be deterministic given the same event stream and config.

### 2. Work item state classes
Canonical state sets (from `pm_work_items.state`):
- terminal: `done`, `cancelled`
- active execution: `in_progress`
- waiting: `blocked`, `in_review`
- pre-start: `backlog`, `ready`

### 3. Percentile method (all modules)
For sorted array `x[0..n-1]` and percentile `p in [0,1]`:
- `rank = p * (n - 1)`
- `lo = floor(rank)`, `hi = ceil(rank)`
- `pct = x[lo] + (x[hi] - x[lo]) * (rank - lo)`

If `n = 0`, return `null` with warning `INSUFFICIENT_DATA`.

### 4. Standard module envelope
Each module response uses this envelope (tool-transport independent):

```json
{
  "module": "cycle_time_analytics",
  "project_id": "proj_123",
  "as_of": "2026-02-19T18:00:00Z",
  "window": {
    "from": "2025-11-21T00:00:00Z",
    "to": "2026-02-19T18:00:00Z"
  },
  "inputs": {
    "filters": {},
    "sample_size": 0,
    "model_version": "v1"
  },
  "data": {},
  "diagnostics": {
    "cache_hit": false,
    "latency_ms": 0,
    "warnings": []
  }
}
```

### 5. Complexity symbols
- `E`: pm events scanned
- `W`: work items scanned
- `C`: completed cycles
- `V`: graph nodes
- `D`: graph edges
- `T`: Monte Carlo trials
- `N`: simulated backlog items
- `F`: review findings
- `L`: labeled model rows
- `A`: contributor activity rows

### 6. Shared correctness safeguards
- Ignore negative intervals caused by bad clock ordering and emit warning.
- Treat duplicate semantic events as no-op even if idempotency guard was bypassed.
- Always return confidence or warnings for low-data regimes.
- Never return predicted values without calibration metadata.

### 7. Projection tables
To keep query latency low, intelligence modules SHOULD maintain replayable projections. Suggested tables:
- `pm_cycle_projections`
- `pm_velocity_daily`
- `pm_risk_snapshots`
- `pm_review_calibration_daily`
- `pm_capacity_profiles`
- `pm_anomaly_state`

These projections are derived state only, never source of truth.

---

## 1. Cycle Time Analytics

### Input data
Reads:
- `pm_events` (`work_item.state_changed`, `work_item.completed`, `work_item.reopened`, `work_item.cancelled`)
- `pm_work_items` (`state`, `started_at`, `completed_at`, `area`, `item_type`, `owner_actor_id`)
- Optional scope filter: `pm_iteration_items` + `pm_iterations`

Required event payload shape for state transitions:
```json
{
  "schema_version": 1,
  "work_item_id": 123,
  "from_state": "ready",
  "to_state": "in_progress"
}
```

If `from_state` is missing, reconstruct from prior known state for that item.

### Algorithm
Definition:
- Cycle time = elapsed time from first transition into `in_progress` to transition into `done` for one cycle instance.

Rules:
- Opening rule: cycle opens when item enters `in_progress` and no cycle is open.
- Closing rule: cycle closes when item enters `done`.
- Reopen rule: if item later reopens and re-enters `in_progress`, that is a new cycle instance.
- Cancel rule: cycles ending in `cancelled` are excluded from cycle percentiles, but included in diagnostics.

Time-in-state reconstruction:
- Build intervals `[event_i.occurred_at, event_{i+1}.occurred_at)` keyed by current state.
- Within an open cycle, accumulate dwell by state.

Flow efficiency:
- `active_time = sum(dwell_in_progress)`
- `waiting_time = sum(dwell_blocked + dwell_in_review)`
- `flow_efficiency = active_time / (active_time + waiting_time)`

Bottleneck state:
- Compute P80 dwell per non-terminal state.
- Bottleneck is state with maximum P80 dwell (tie-breaker: highest total dwell share).

Pseudocode:

```text
for each work_item_id in scope:
  events = ordered lifecycle events by sequence
  current_state = state_before_window(work_item_id)
  open_cycle = null

  for event in events:
    next_state = derive_to_state(event)
    ts = event.occurred_at

    if open_cycle != null:
      open_cycle.dwell[current_state] += ts - open_cycle.last_ts
      open_cycle.last_ts = ts

    if open_cycle == null and next_state == 'in_progress':
      open_cycle = {
        start_ts: ts,
        last_ts: ts,
        dwell: map(default=0)
      }

    if open_cycle != null and next_state == 'done':
      duration = ts - open_cycle.start_ts
      if duration >= min_cycle_seconds:
        emit completed_cycle(duration, open_cycle.dwell)
      open_cycle = null

    if open_cycle != null and next_state == 'cancelled':
      emit aborted_cycle(open_cycle)
      open_cycle = null

    current_state = next_state
```

### Output format (`data`)
```json
{
  "summary": {
    "completed_cycles": 148,
    "aborted_cycles": 6,
    "cycle_hours": {
      "p50": 19.4,
      "p80": 42.2,
      "p90": 61.8,
      "p95": 88.0
    },
    "flow_efficiency": 0.63
  },
  "time_in_state": [
    {
      "state": "in_progress",
      "avg_hours": 12.1,
      "p80_hours": 27.5,
      "share": 0.54
    },
    {
      "state": "blocked",
      "avg_hours": 6.8,
      "p80_hours": 18.2,
      "share": 0.30
    },
    {
      "state": "in_review",
      "avg_hours": 3.6,
      "p80_hours": 9.1,
      "share": 0.16
    }
  ],
  "bottleneck": {
    "state": "blocked",
    "criterion": "max_p80_dwell",
    "p80_hours": 18.2
  },
  "stuck_items": [
    {
      "work_item_id": 42,
      "state": "blocked",
      "age_hours": 96.0
    }
  ]
}
```

### Computational complexity
- Event scan: `O(E)` (using `idx_pm_events_type_time` + sequence ordering)
- Per-state percentile calculation: `O(C log C)`
- Total typical: `O(E + C log C)`

### Caching strategy
- Cache key: `(project_id, window, filters_hash, state_model_version)`
- Recommended TTL: 15 minutes
- Incremental projection update cursor: `(project_id, last_sequence_processed)`
- Invalidate on:
  - `work_item.state_changed`
  - `work_item.completed`
  - `work_item.reopened`
  - `work_item.cancelled`

---

## 2. Velocity Engine

### Input data
Reads:
- `pm_events` (`work_item.completed`, fallback `work_item.state_changed` with `to_state=done`)
- `pm_work_items` (`completed_at`, `area`, `item_type`)
- `pm_outcomes` (`outcome_type`, `impact_json`, `quality_score`, `recorded_at`)
- `pm_work_item_ai_current` (`value_score`) as fallback value signal

### Algorithm
Definitions:
- Throughput = count of completed items per time window.
- Output = value delivered, quality-adjusted.

Daily series construction (`d` = date bucket UTC):
- `throughput[d] = count(distinct work_item_id completed on d)`
- `base_value(item) =`
  - `json_extract(pm_outcomes.impact_json, '$.delivered_value')` if numeric
  - else `pm_work_item_ai_current.value_score`
  - else `1.0`
- Outcome multipliers:
  - `delivered=1.0`
  - `partial=0.6`
  - `rework=0.2`
  - `rollback=0.0`
  - `incident=-0.5`
  - `abandoned=0.0`
- `output[d] = sum(base_value(item) * multiplier(item_outcome))`

Rolling windows:
- `throughput_7d`, `throughput_30d`
- `output_7d`, `output_30d`

Trend detection:
- Compute Theil-Sen slope on trailing rolling series:
  - 7d trend uses last 28 points
  - 30d trend uses last 90 points
- Label:
  - accelerating: slope `> +epsilon`
  - decelerating: slope `< -epsilon`
  - stable: otherwise
- Default `epsilon = 0.02 * median(series)` per window.

Pseudocode:

```text
daily = aggregate_by_day(completions, value)
roll7 = rolling_sum(daily, 7)
roll30 = rolling_sum(daily, 30)
trend7 = classify(theil_sen(roll7.tail(28)), epsilon7)
trend30 = classify(theil_sen(roll30.tail(90)), epsilon30)
```

### Output format (`data`)
```json
{
  "velocity": {
    "throughput_7d": 18,
    "throughput_30d": 64,
    "output_7d": 211.5,
    "output_30d": 756.2
  },
  "trend": {
    "throughput": {
      "window": "30d",
      "state": "accelerating",
      "slope_per_day": 0.19
    },
    "output": {
      "window": "30d",
      "state": "stable",
      "slope_per_day": 0.03
    }
  },
  "daily_series": [
    {
      "date": "2026-02-19",
      "throughput": 3,
      "output": 14.8
    }
  ]
}
```

### Computational complexity
- Daily aggregation from completions: `O(W)`
- Rolling calculations: `O(days)`
- Trend estimation (Theil-Sen): `O(days log days)` optimized
- Total typical: `O(W + days log days)`

### Caching strategy
- Persist daily aggregates in `pm_velocity_daily`
- TTL:
  - rolling metrics: 30 minutes
  - trend labels: 2 hours
- Invalidate on:
  - `work_item.completed`
  - `work_item.reopened`
  - `outcome.recorded`
  - `prediction.refreshed` when value model changes

---

## 3. Monte Carlo Simulation

### Input data
Reads:
- Historical cycle durations from Module 1 projection (`pm_cycle_projections`) or reconstructed from `pm_events`
- `pm_work_items` (`state`, `area`, `item_type`, `size_bucket`)
- `pm_work_item_ai_current` (`estimated_cycle_hours_p50/p80/p95`, `forecast_confidence`)
- `pm_dependencies`, `pm_dependency_closure`, `pm_dependency_metrics`
- `pm_iterations`, `pm_iteration_items` (`wip_limit`, `capacity_hours`)

### Algorithm

#### 3.1 Duration sampler construction
Cohort hierarchy:
1. `(area, item_type, size_bucket)`
2. `(area, item_type)`
3. `(item_type)`
4. project-wide fallback

Minimum sample sizes:
- preferred `>= 50`
- acceptable fallback `>= 20`
- if `< 20`, widen cohort and lower confidence

Per-item duration sample:
- If `estimated_cycle_hours_p50/p80` present, fit lognormal:
  - `mu = ln(p50)`
  - `sigma = (ln(p80) - ln(p50)) / 0.841621`
  - sample `x_est ~ lognormal(mu, sigma)`
- Sample empirical bootstrap `x_emp` from cohort durations.
- Blend:
  - `alpha = clamp(forecast_confidence, 0.2, 0.8)`
  - `x = alpha * x_est + (1 - alpha) * x_emp`

#### 3.2 Sprint throughput simulation (N days)
Discrete-event simulation with:
- ready queue (dependency-satisfied items)
- active min-heap by finish time
- concurrency limit from `wip_limit`

Eligibility:
- item must not be terminal
- all active hard predecessors resolved or simulated complete

Pseudocode:

```text
for trial in 1..T:
  t = 0
  completed = 0
  ready = initial_ready_items()
  active = min_heap()  # entries: (finish_time, item_id)

  while len(active) < W and ready not empty:
    item = pop_priority(ready)
    push(active, (t + sample_duration(item), item))

  while active not empty:
    finish_time, item = pop_min(active)
    if finish_time > horizon_hours:
      break

    t = finish_time
    mark_complete(item)
    completed += 1
    release_new_ready_successors(item)

    while len(active) < W and ready not empty:
      nxt = pop_priority(ready)
      push(active, (t + sample_duration(nxt), nxt))

  record throughput_trial = completed
```

#### 3.3 Backlog completion forecast (when N items are done)
- Same simulation loop without fixed horizon.
- Stop each trial when completed count reaches target `N`.
- Record completion timestamp distribution.

#### 3.4 WIP limit impact modeling
- Repeat simulation for candidate limits: `{W-1, W, W+1, W+2}` (bounded at `>=1`).
- Compare throughput and completion-date percentiles.

#### 3.5 Confidence intervals and histogram
- Percentiles: P50/P80/P90/P95 over trial outputs.
- Histogram bins:
  - Freedman-Diaconis width `2 * IQR * n^(-1/3)`
  - fallback fixed 20 bins when IQR=0.

Correctness constraints:
- Deterministic seed derived from request hash unless explicit seed provided.
- Exclude cancelled items from target backlog count.
- Respect unresolved hard dependencies at trial start.

### Output format (`data`)
```json
{
  "simulation": {
    "trials": 10000,
    "seed": 17422381,
    "horizon_days": 14,
    "wip_limit": 4
  },
  "throughput_distribution": {
    "p50": 17,
    "p80": 21,
    "p90": 24,
    "p95": 27,
    "histogram": [
      {
        "bin_start": 10,
        "bin_end": 12,
        "count": 412
      }
    ]
  },
  "backlog_completion": {
    "target_items": 60,
    "p50_date": "2026-03-22",
    "p80_date": "2026-03-31",
    "p95_date": "2026-04-10"
  },
  "wip_scenarios": [
    {
      "wip_limit": 3,
      "throughput_p50": 15,
      "completion_p80_date": "2026-04-05"
    },
    {
      "wip_limit": 4,
      "throughput_p50": 17,
      "completion_p80_date": "2026-03-31"
    },
    {
      "wip_limit": 5,
      "throughput_p50": 18,
      "completion_p80_date": "2026-03-30"
    }
  ],
  "confidence": {
    "sample_quality": 0.78,
    "cohort_fallback_used": false
  }
}
```

### Computational complexity
- Per trial: `O((N + D) log W)`
- Total: `O(T * (N + D) log W)`
- Percentiles/histogram over trials: `O(T log T)`

### Caching strategy
- Cache sampler artifacts by cohort for 6 hours
- Cache scenario outputs by `(project_id, backlog_hash, horizon_days, wip_limit, trials, seed)` for 1 hour
- Invalidate on:
  - new completed cycle data
  - `dependency.added`, `dependency.resolved`, `dependency.updated`
  - `prediction.refreshed` affecting estimates

---

## 4. Rework Prediction

### Input data
Reads:
- `pm_work_items` (`area`, `item_type`, `owner_actor_id`, `priority_band`, `created_at`, `updated_at`)
- `pm_work_item_ai_current` (`spec_readiness`, `estimated_cycle_hours_*`, `forecast_confidence`)
- `pm_events` (pace/churn/session signals via `correlation_id`, reopen patterns)
- `pm_outcomes` (`outcome_type`, `area`, `recorded_at`, `root_cause_md`)
- `pm_review_findings` (`severity`, `category`, `disposition`, `detected_at`)
- `pm_decisions` (`status`, `area`, `decided_at`)
- `pm_work_item_ai_history` (prior prediction vs eventual outcomes for calibration)

### Algorithm
Prediction target:
- `label = 1` if eventual outcome is `rework` or `rollback`
- `label = 0` if eventual outcome is `delivered` or `partial`
- `incident` and `abandoned` excluded from primary calibration set by default

#### 4.1 Feature signals
Normalized to `[0,1]` (higher = higher rework risk):
- `spec_quality_risk = 1 - spec_readiness`
- `area_history_risk = rework_rate(area, 180d)`
- `contributor_experience_risk = 1 - normalized_completed_by_owner_in_area(180d)`
- `pace_risk = normalized_transition_churn(item, 72h)`
- `session_count_risk = normalized_distinct_correlation_ids(item, 7d)`
- `decision_gap_risk = 1` if no accepted decision in same area for this item/context in trailing 90d
- `finding_density_risk = weighted_open_findings / max(1, size_proxy)`

#### 4.2 Signal weighting from historical accuracy
For each signal `s_i`:
- Compute single-signal AUROC on trailing labeled set
- `reliability_i = max(0, 2 * (AUROC_i - 0.5))` in `[0,1]`
- Blend with prior weight `base_i`:
  - `weight_i_raw = base_i * (0.5 + 0.5 * reliability_i)`
- Renormalize `weights` to sum to 1

#### 4.3 Probability model
- Standardize feature vector `z`
- Logistic score: `logit = b + sum(weight_i * z_i)`
- `p_raw = sigmoid(logit)`

#### 4.4 Calibration
- If labeled points `L >= 300`: isotonic regression calibration
- Else if `L >= 80`: Platt scaling
- Else: no-fit fallback using project prior mean and widen confidence interval
- Return calibrated probability `p_cal`

#### 4.5 Risk level and mitigations
Risk levels:
- low: `[0.00, 0.25)`
- medium: `[0.25, 0.50)`
- high: `[0.50, 0.75)`
- critical: `[0.75, 1.00]`

Mitigations are generated from top contributing signals.

### Output format (`data`)
```json
{
  "work_item_id": 412,
  "rework_probability": 0.67,
  "risk_level": "high",
  "weighted_signals": [
    {
      "name": "spec_quality_risk",
      "value": 0.74,
      "weight": 0.29,
      "contribution": 0.21,
      "evidence": "spec_readiness=0.26"
    },
    {
      "name": "decision_gap_risk",
      "value": 1.0,
      "weight": 0.18,
      "contribution": 0.18,
      "evidence": "no accepted decision in area=orchestration within 90d"
    }
  ],
  "calibration": {
    "raw_probability": 0.72,
    "calibrated_probability": 0.67,
    "method": "isotonic",
    "brier_score_30d": 0.142
  },
  "mitigations": [
    "Require explicit acceptance criteria and edge-case checklist",
    "Record decision entry before implementation",
    "Add targeted tests for high-risk files"
  ]
}
```

### Computational complexity
- Per-item inference with precomputed features: `O(S)` where `S` is feature count
- On-demand feature extraction: `O(E_item + F_item)`
- Periodic retraining/calibration: `O(L * S)` to `O(L log L)` depending on solver/calibrator

### Caching strategy
- Per-item feature cache: 10 minutes
- Area-level aggregates (rework priors, experience): 1 hour
- Model artifact + calibration artifact: refresh daily or on drift trigger
- Invalidate on:
  - `outcome.recorded`
  - `review.finding_opened`, `review.finding_fixed`, `review.finding_dismissed`
  - `decision.recorded`, `decision.superseded`
  - major item spec updates (`work_item.updated`)

---

## 5. Dependency Graph Analysis

### Input data
Reads:
- `pm_dependencies` (active ordering edges)
- `pm_work_items` (open/terminal state)
- `pm_work_item_ai_current` (`estimated_cycle_hours_p50`, `wsjf_score`, `value_score`, `rework_probability`)
- `pm_dependency_closure` and `pm_dependency_metrics` (if materialized)
- `pm_urgency_signals` (priority weighting)

Edge inclusion rules:
- Include only edges where:
  - `status = 'active'`
  - `relation_type in ('blocks', 'prerequisite')`
  - `strength = 'hard'`
- Exclude terminal nodes (`done`, `cancelled`) from unresolved graph.

### Algorithm

#### 5.1 DAG construction
- Build adjacency list, reverse adjacency list, and indegree map for open nodes.

#### 5.2 Critical path identification
- If graph is acyclic, run Kahn topological sort.
- Node duration:
  - `estimated_cycle_hours_p50`
  - fallback cohort median from Module 1
  - fallback constant 8h
- Longest path DP over topological order:
  - `dist[v] = duration[v]`
  - relax edges `u -> v`: `dist[v] = max(dist[v], dist[u] + lag(u,v) + duration[v])`
- Backtrack predecessor map for critical path chain.

#### 5.3 Bottleneck scoring
`score_0_100 = 100 * (
  0.40 * norm(transitive_successor_count)
+ 0.25 * norm(open_successor_count)
+ 0.20 * norm(critical_path_membership)
+ 0.15 * norm(blocking_age_hours)
)`

Where:
- `critical_path_membership` is 1 if node on current critical path else 0.

#### 5.4 Cycle detection
- Primary prevention exists via DB triggers on `pm_dependencies`.
- Analytics verification uses Tarjan SCC:
  - SCC size `> 1` indicates cycle.

#### 5.5 Cascading delay simulation
Input: source item `X`, delay `delta_days`.
- Compute baseline earliest finish schedule.
- Add delay to `X.finish`.
- Propagate downstream in topological order:
  - `start_new(v) = max(parent_finish_new + lag)`
  - `finish_new(v) = start_new(v) + duration(v)`
  - `impact(v) = finish_new(v) - finish_baseline(v)`

#### 5.6 Execution order computation
Dependency-safe ordering with weighted priority among currently ready nodes.

Priority score:
`P = 0.45*norm(wsjf_score) + 0.25*norm(value_score) + 0.15*norm(urgency) + 0.10*(1-rework_probability) + 0.05*norm(age_hours)`

Use max-heap over zero-indegree nodes:
- pop highest `P`
- append to execution order
- decrement successor indegrees

### Output format (`data`)
```json
{
  "graph_summary": {
    "nodes": 132,
    "edges": 211,
    "is_dag": true
  },
  "critical_path": {
    "length_hours_p50": 186.5,
    "work_item_ids": [19, 27, 41, 56]
  },
  "bottlenecks": [
    {
      "work_item_id": 27,
      "score": 91.4,
      "open_successors": 6,
      "transitive_successors": 18
    }
  ],
  "cycles": [],
  "cascading_delay": {
    "source_work_item_id": 27,
    "delay_days": 3,
    "impacted_items": [41, 56, 72],
    "projected_iteration_slip_days_p80": 2.4
  },
  "execution_order": [19, 33, 27, 41, 56]
}
```

### Computational complexity
- Graph build: `O(V + D)`
- Topological sort: `O(V + D)`
- Longest-path DP: `O(V + D)`
- Tarjan SCC: `O(V + D)`
- Priority topological ordering: `O((V + D) log V)`

### Caching strategy
- Cache adjacency and indegree snapshots keyed by graph version
- Graph version can be derived from max `(dependency event sequence, affected work item update sequence)`
- TTL: 15 minutes
- Invalidate on:
  - `dependency.added`, `dependency.updated`, `dependency.resolved`
  - `work_item.completed`, `work_item.cancelled`
  - estimate updates (`prediction.refreshed`)

---

## 6. Risk Radar

### Input data
Reads from module outputs and raw tables:
- Velocity signals from Module 2
- Quality/rework signals from Module 4 and `pm_review_findings`/`pm_outcomes`
- Dependency signals from Module 5 and `pm_dependency_metrics`
- Knowledge/capacity signals from Module 9
- Process health from `pm_events`, `pm_work_items`, `pm_iterations`
- Learning quality from Modules 7 and 8

### Algorithm
Compute seven dimension scores in `[0,100]` where higher is worse.

Normalization:
- Convert each submetric to `[0,1]` with policy thresholds.
- Use winsorization at 5th/95th percentile to reduce outlier distortion.

Dimension formulas:

1) Velocity risk
`100 * (0.50*throughput_drop + 0.30*throughput_volatility + 0.20*stale_wip_ratio)`

2) Quality risk
`100 * (0.40*rework_rate + 0.35*open_blocking_findings_ratio + 0.25*rollback_incident_rate)`

3) Dependency risk
`100 * (0.45*blocked_item_ratio + 0.35*transitive_blocker_density + 0.20*cycle_pressure)`

4) Knowledge risk
`100 * (0.50*bus_factor_risk + 0.30*expertise_gap + 0.20*knowledge_decay)`

5) Capacity risk
`100 * (0.50*load_overrun + 0.30*contributor_imbalance + 0.20*unplanned_work_ratio)`

6) Process risk
`100 * (0.35*wip_violation_rate + 0.35*queue_age_growth + 0.30*reopen_rate)`

7) Learning risk
`100 * (0.40*decision_coverage_gap + 0.30*review_calibration_gap + 0.30*repeat_failure_mode_rate)`

Overall risk:
- Base weighted mean:
  - velocity 0.15
  - quality 0.20
  - dependencies 0.15
  - knowledge 0.15
  - capacity 0.15
  - process 0.10
  - learning 0.10
- Concentration amplifier:
  - `overall = clamp(base + 0.15 * max(0, max_dimension - 70), 0, 100)`

Trend detection per dimension:
- Weekly scores across trailing 8 weeks
- Robust slope classification:
  - improving if slope `<= -2` points/week
  - declining if slope `>= +2` points/week
  - stable otherwise

Mitigation generation:
- For each dimension with score >= 60, use top 2 contributing submetrics and map to policy actions.

### Output format (`data`)
```json
{
  "overall_risk": 64.2,
  "risk_level": "high",
  "dimensions": [
    {
      "name": "dependencies",
      "score": 78.0,
      "trend": "declining",
      "drivers": [
        {
          "metric": "blocked_item_ratio",
          "value": 0.41
        },
        {
          "metric": "transitive_blocker_density",
          "value": 0.73
        }
      ],
      "mitigations": [
        "Prioritize top transitive blocker resolution this week",
        "Temporarily cap new intake until blocked ratio < 0.25"
      ]
    }
  ]
}
```

### Computational complexity
- With projection inputs: `O(1)` per dimension, `O(dimensions)` total
- From raw recompute: `O(E + W + D + F + A)`

### Caching strategy
- Persist periodic snapshots in `pm_risk_snapshots`
- TTL:
  - dashboard read: 1 hour
  - high-severity pull: 5 minutes
- Event-driven invalidation on:
  - `outcome.recorded` with `rollback` or `incident`
  - `dependency.cycle_rejected`
  - repeated WIP policy violations

---

## 7. Decision Memory and Learning

### Input data
Reads:
- `pm_decisions`, `pm_decision_tags`, `pm_decisions_fts`
- `pm_outcomes`, `pm_outcome_tags`, `pm_outcomes_fts`
- `pm_memory_entries` view
- `pm_work_items` (context)
- `pm_review_findings` and `runs` (for downstream quality context)

### Decision storage format
Primary storage is relational:
- Decisions: `pm_decisions`
- Outcomes: `pm_outcomes`
- Tags: `pm_decision_tags`, `pm_outcome_tags`
- Search: FTS5 via `pm_decisions_fts`, `pm_outcomes_fts`

Portable export format (optional): JSONL

```json
{"record_type":"decision","project_id":"p1","decision_uid":"dec_123","area":"api","status":"accepted","decided_at":"2026-02-10T09:00:00Z"}
{"record_type":"outcome","project_id":"p1","outcome_uid":"out_991","decision_uid":"dec_123","outcome_type":"rework","recorded_at":"2026-02-17T16:21:00Z"}
```

### Algorithm

#### 7.1 Outcome tracking normalization
Map `pm_outcomes.outcome_type` to user-facing buckets:
- `merged`: `delivered`, `partial`
- `rework`: `rework`
- `reverted`: `rollback`
- `abandoned`: `abandoned`
- `incident`: kept separate but contributes to failure-mode mining

Reason extraction order:
1. structured keys from `impact_json`
2. `root_cause_md`
3. linked high-severity review findings

#### 7.2 Approach suggestion for new work
1. Candidate retrieval:
- FTS over decisions + outcomes using title/body/keywords + area filter.
2. Similarity scoring:
- lexical relevance (BM25)
- structural match (area, item_type, dependency shape)
- quality bonus (low rework history, fewer review rounds)
3. Return top-K recommendations with rationale and caution tags.

Scoring example:
`score = 0.45*lexical + 0.25*area_match + 0.15*topology_match + 0.15*outcome_quality`

#### 7.3 Pattern mining
- Rework rate by area:
  - `count(outcome in {rework, rollback}) / count(all outcomes)`
- Average review rounds by area:
  - join work items to run outcomes
- Common failure modes:
  - term extraction from `root_cause_md` + `lessons_md` + finding titles
  - cluster repeated modes by keyword overlap

#### 7.4 Decision decay detection
Decision stale score in `[0,1]`:
`decay = 0.40*age_factor + 0.40*contradiction_factor + 0.20*non_usage_factor`

Where:
- `age_factor`: grows after default 180 days
- `contradiction_factor`: repeated negative outcomes in same area after adoption
- `non_usage_factor`: low retrieval/use in similar new work

Flag stale when `decay >= 0.65`.

### Output format (`data`)
```json
{
  "suggested_approaches": [
    {
      "decision_id": 88,
      "title": "Use optimistic concurrency on task updates",
      "score": 0.82,
      "supporting_outcomes": [341, 355],
      "cautions": ["Requires retry envelope"]
    }
  ],
  "patterns": {
    "rework_rate_by_area": [
      {
        "area": "orchestration",
        "rate": 0.31
      }
    ],
    "avg_review_rounds_by_area": [
      {
        "area": "api",
        "avg_rounds": 1.4
      }
    ],
    "failure_modes": [
      {
        "mode": "timeout handling gaps",
        "count": 12
      }
    ]
  },
  "stale_decisions": [
    {
      "decision_id": 41,
      "decay_score": 0.77,
      "reason": "contradicted_by_recent_rollbacks"
    }
  ]
}
```

### Computational complexity
- Candidate retrieval with FTS: `O(log N + K)` typical
- Rerank top-K: `O(K)`
- Pattern mining batch: `O(N + F)`
- Decay scoring batch: `O(N)`

### Caching strategy
- FTS retrieval cache: 30 minutes
- Pattern mining artifacts: daily
- Decay scores: daily, plus invalidation on `decision.superseded` and `outcome.recorded`

---

## 8. Review Calibration

### Input data
Reads:
- `pm_review_findings` (`source`, `category`, `severity`, `disposition`, `validation_outcome`, `file_path`, `detected_at`, `resolved_at`)
- `pm_events` (`review.finding_opened`, `review.finding_fixed`, `review.finding_dismissed`, `review.calibration_recorded`)
- `pm_outcomes` and `runs` for escaped-defect and round-trip context

### Finding taxonomy
Finding type key:
- `finding_type = source + ':' + category + ':' + normalized_title_signature`

Severity levels:
- `blocking`, `high`, `medium`, `low`, `suggestion`

Disposition mapping to requested buckets:
- accepted -> `fixed`
- dismissed -> `dismissed`, `duplicate`
- modified -> `fixed` where implemented patch diverges materially from suggested fix
- deferred -> `accepted_risk`, or unresolved `open` beyond SLA

### Algorithm
1. Aggregate by `(finding_type, severity)` over window.
2. Compute metrics:
- `hit_rate = (accepted + modified) / resolved_non_deferred`
- `false_positive_rate = dismissed / resolved_non_deferred`
- `deferred_rate = deferred / total_findings`
3. False positive pattern detection:
- Group by path prefix, area, model version, severity.
- Use baseline comparison with minimum sample and Wilson interval to avoid small-sample noise.
- Flag when group dismissal rate is both statistically above baseline and practically significant.
4. Trend:
- Weekly hit-rate slope over trailing 8 windows.

### Output format (`data`)
```json
{
  "calibration": [
    {
      "finding_type": "agent:correctness:null-check",
      "severity": "high",
      "sample": 73,
      "hit_rate": 0.78,
      "false_positive_rate": 0.14,
      "deferred_rate": 0.08,
      "trend": "improving"
    }
  ],
  "false_positive_patterns": [
    {
      "scope": "src/sync/*",
      "finding_type": "agent:performance:allocation",
      "dismissal_lift": 2.3,
      "recommended_action": "tighten performance heuristic for small collections"
    }
  ]
}
```

### Computational complexity
- Aggregate scan: `O(F)`
- Grouping and sort for pattern analysis: `O(F log F)`
- Trend fitting: `O(groups * windows)`

### Caching strategy
- Materialize daily/hourly aggregates in `pm_review_calibration_daily`
- TTL: 6 hours
- Invalidate on:
  - finding disposition changes
  - validation outcome updates
  - newly recorded downstream outcomes tied to reviewed work

---

## 9. Capacity Modeling

### Input data
Reads:
- `pm_events` (actor activity: item completion, state transitions, review events)
- `pm_work_items` (`owner_actor_id`, `area`, `item_type`, `completed_at`)
- `pm_review_findings` (`resolver_actor_id`, `source`, `category`)
- `pm_iterations`, `pm_iteration_items` (planned load)
- `runs` (if available) for review rounds and execution duration
- Optional git history projection from core tables (`events` stream or sync ingest) for commit/PR attribution

### Algorithm

#### 9.1 Contributor velocity profiles
For each contributor `u`:
- Build weekly delivered-value series from completed items.
- EWMA velocity:
  - `ewma_t = alpha*x_t + (1-alpha)*ewma_{t-1}`, default `alpha=0.3`
- Estimate uncertainty from trailing residual variance.

#### 9.2 Area expertise mapping
For contributor `u`, area `a`:
`expertise(u,a) = 0.50*delivery_share + 0.30*review_share + 0.20*recency_score`

Where:
- `delivery_share`: fraction of value delivered in area
- `review_share`: fraction of accepted/fixed findings resolved in area
- `recency_score`: exponential decay by inactivity

#### 9.3 Throughput forecasting per contributor
`forecast_30d(u) = ewma_velocity(u) * availability_factor(u) * focus_factor(u)`

- `availability_factor`: active_days_last_30 / 30
- `focus_factor`: penalty for high context switching (many areas in short period)

#### 9.4 Bus factor computation
Per area:
- Sort contributors by decayed expertise descending.
- Bus factor = minimum `k` contributors required to cover 70 percent of area expertise.

Project bus factor:
- minimum bus factor among critical areas (areas with highest active load or strategic weight).

#### 9.5 Knowledge decay detection
Decayed expertise:
- `active_expertise(u,a,t) = expertise_at_t0 * 2^(-days_inactive / half_life_days)`
- default half-life: 60 days

Area flagged at risk when all true:
- active backlog/load in area above threshold
- total active expertise below threshold
- bus factor <= 1

### Output format (`data`)
```json
{
  "contributors": [
    {
      "actor_id": "alice",
      "velocity_profile": {
        "ewma_points_per_week": 11.2,
        "uncertainty": 2.1
      },
      "forecast": {
        "throughput_30d": 44.8
      },
      "top_areas": [
        {
          "area": "api",
          "expertise": 0.82
        },
        {
          "area": "sync",
          "expertise": 0.41
        }
      ]
    }
  ],
  "bus_factor": {
    "project": 2,
    "areas": [
      {
        "area": "orchestration",
        "bus_factor": 1,
        "risk": "high"
      }
    ]
  },
  "knowledge_decay": [
    {
      "area": "sync",
      "at_risk": true,
      "reason": "single high-expertise contributor inactive 47d"
    }
  ]
}
```

### Computational complexity
- Activity aggregation: `O(A)`
- Per-area contributor sorting for bus factor: `O(areas * contributors * log contributors)`
- Expertise matrix update (sparse): `O(nonzero_contributions)`

### Caching strategy
- Persist contributor and area profiles in `pm_capacity_profiles`
- TTL:
  - contributor forecasts: 24 hours
  - utilization overlays: 1 hour
- Invalidate on:
  - `work_item.completed`
  - major review activity updates
  - git ingest events (commit/PR)
  - iteration planning changes

---

## 10. Anomaly Detection

### Input data
Reads:
- Velocity series from Module 2
- Backlog/WIP state from `pm_work_items`, `pm_iterations`, `pm_iteration_items`
- Rework/quality series from `pm_outcomes`, `pm_review_findings`
- Process series from `pm_events`
- Risk snapshots from Module 6

### Anomaly classes
Minimum supported classes:
- velocity_drop
- backlog_growth_spike
- rework_spike
- wip_limit_violation
- stale_item_accumulation

### Algorithm

#### 10.1 Baseline computation
Hybrid baseline per metric:
1. Static threshold from policy config (hard guardrail)
2. Dynamic baseline:
- rolling median
- MAD (median absolute deviation)
- optional seasonal adjustment (weekday index from velocity engine)

Deviation score:
- `z_robust = (value - median) / max(eps, 1.4826 * MAD)`

Trigger candidate when:
- `abs(value - baseline) > max(static_delta, k * MAD)`
- and persistence condition met (default 2 consecutive intervals)

#### 10.2 Corroboration and suppression
- High/critical anomalies require corroboration by at least one related signal.
- Apply cooldown windows after acknowledgement to avoid alert storms.
- Skip planned anomalies during configured freeze windows.

#### 10.3 Severity scoring
`severity_0_100 = 100 * (0.50*magnitude + 0.30*duration + 0.20*blast_radius)`

Where:
- `magnitude`: normalized robust z-score
- `duration`: normalized persistence length
- `blast_radius`: fraction of active work/contributors affected

Severity levels:
- low: `< 35`
- medium: `[35, 60)`
- high: `[60, 80)`
- critical: `>= 80`

### Output format (`data`)
```json
{
  "anomalies": [
    {
      "type": "velocity_drop",
      "metric": "throughput_7d",
      "current": 9,
      "baseline": 17,
      "deviation_z": -2.7,
      "severity": 76,
      "level": "high",
      "started_at": "2026-02-14T00:00:00Z",
      "last_seen_at": "2026-02-19T00:00:00Z",
      "supporting_signals": [
        "stale_item_accumulation",
        "blocked_ratio_increase"
      ],
      "recommended_actions": [
        "Reduce intake until blocked ratio normalizes",
        "Escalate top blockers by transitive impact"
      ]
    }
  ]
}
```

### Computational complexity
- Incremental baseline update per metric: `O(1)` amortized
- Batch recompute per metric: `O(time_points)`
- Multi-metric pass: `O(metrics * time_points)`
- Corroboration join: `O(anomalies log anomalies)`

### Caching strategy
- Persist baseline and anomaly state in `pm_anomaly_state`
- Feed cache TTL: 5 minutes
- Invalidate immediately on severe new events:
  - rollback/incident outcomes
  - dependency cycles
  - repeated WIP limit violations

---

## Operational Requirements Across Modules

1. Explainability
- Every score or prediction MUST include top contributing signals.
- Every forecast MUST include confidence metadata and sample-size diagnostics.

2. Determinism and auditability
- Rebuild from `pm_events` MUST match stored projections.
- Monte Carlo MUST support deterministic seed mode.

3. Low-data behavior
- If sample size below thresholds, modules MUST widen cohort, lower confidence, and emit warnings.
- Modules MUST NOT emit narrow confidence intervals in sparse regimes.

4. Performance SLO targets
- Hot path analytics read: p95 under 300 ms from projection tables.
- Forecast/simulation read: p95 under 2 s for default trial count.
- Backfill/replay can be asynchronous but must be idempotent.

5. Safety checks
- Any module detecting impossible states (negative durations, invalid transitions, cycle despite guard) emits diagnostics and increments integrity counters.

