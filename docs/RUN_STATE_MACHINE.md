# Run State Machine

> **Status:** Normative. This is the canonical definition of run phases, statuses, and transitions. PROTOCOL.md delegates to this document for the state machine specification. All other docs MUST reference this document for phase values and transitions.

## 1. Three Layers of State

Conductor tracks run progress at three granularity levels:

| Layer | Enum | Values | Persisted? | Purpose |
| --- | --- | --- | --- | --- |
| **RunPhase** | Macro phase | 10 values | Yes (`runs.phase`) | UI display, gate triggers, operator understanding |
| **RunStatus** | Derived status | 4 values | No (computed) | Quick filtering: what needs attention? |
| **RunStep** | Micro step | 13 values | Yes (`runs.step`) | Internal execution tracking, credential resolution |

**Key invariant:** `RunPhase` is the source of truth. `RunStatus` is derived. `RunStep` is internal detail.

---

## 2. RunPhase Enum (Canonical)

```typescript
type RunPhase =
  | 'pending'                  // Run created, environment setup in progress
  | 'planning'                 // AI agents designing the approach
  | 'awaiting_plan_approval'   // Plan ready, waiting for human gate
  | 'executing'                // Implementation underway (coding, applying changes)
  | 'checking'                 // Automated quality gates (tests, lint, security scan)
  | 'awaiting_review'          // PR created, waiting for review (AI + human)
  | 'awaiting_merge'           // PR approved, waiting for human merge gate
  | 'completed'                // Merged and cleaned up successfully
  | 'failed'                   // Unrecoverable error; requires human decision
  | 'cancelled';               // Aborted by operator
```

### 2.1 Phase Definitions

| Phase | Entry Condition | What Happens | Exit Condition |
| --- | --- | --- | --- |
| `pending` | Run created via UI/API | Worktree setup, routing decision, environment bootstrap | Environment ready → `planning` |
| `planning` | Environment ready OR plan revision requested | AI planner creates/revises plan artifact | Plan artifact validated → `awaiting_plan_approval` |
| `awaiting_plan_approval` | Valid plan artifact exists | **Human gate.** Operator reviews plan. | Approved → `executing`; Revise → `planning`; Reject → `cancelled` |
| `executing` | Plan approved OR code changes requested | AI implementer writes code, creates commits | PR created → `checking`; Error → `failed` |
| `checking` | PR created OR code changes pushed | Automated checks: tests, lint, security scan (parallel) | All pass → `awaiting_review`; Any fail → `executing` (retry) or `failed` (max attempts) |
| `awaiting_review` | All checks pass | AI reviewer + human reviewer evaluate PR | Approved → `awaiting_merge`; Changes requested → `executing` |
| `awaiting_merge` | PR approved | **Human gate.** Operator merges PR (or auto-merge at L3). | Merged → `completed`; Reverted → `failed` |
| `completed` | PR merged | Cleanup: worktree destroyed, ports released, final audit | Terminal state |
| `failed` | Unrecoverable error at any phase | Run is stopped. Operator must decide: retry, fix manually, or cancel. | Retry → `planning` or `executing` (see § 5.4); Cancel → `cancelled` |
| `cancelled` | Operator cancels at any phase | Cleanup: worktree destroyed, ports released, cancellation recorded | Terminal state |

### 2.2 Terminal vs Non-Terminal Phases

| Category | Phases | Can Transition Out? |
| --- | --- | --- |
| **Terminal** | `completed`, `cancelled` | No (except reopen → new run) |
| **Failed** | `failed` | Yes (retry → previous phase, or cancel → `cancelled`) |
| **Active** | All others | Yes (forward, back, or to `failed`/`cancelled`) |

---

## 3. RunStatus Enum (Derived)

```typescript
type RunStatus = 'active' | 'paused' | 'blocked' | 'finished';
```

**RunStatus is NEVER persisted.** It is computed from `RunPhase` + `paused_at`:

```typescript
function deriveStatus(phase: RunPhase, paused_at: string | null): RunStatus {
  if (phase === 'completed' || phase === 'cancelled') return 'finished';
  if (phase === 'failed') return 'blocked';
  if (paused_at !== null) return 'paused';
  return 'active';
}
```

| Status | Meaning | Phases |
| --- | --- | --- |
| `active` | Run is progressing | `pending`, `planning`, `awaiting_plan_approval`, `executing`, `checking`, `awaiting_review`, `awaiting_merge` |
| `paused` | Operator intentionally paused a healthy run | Any non-terminal phase with `paused_at` set |
| `blocked` | Unrecoverable error; needs human intervention | `failed` |
| `finished` | Run is done | `completed`, `cancelled` |

### 3.1 Pause Semantics

**Pause is an overlay, not a phase.** The `paused_at` timestamp is set/cleared independently of phase:

- Pause: sets `paused_at = now()`, run stays in current phase but no work proceeds
- Resume: clears `paused_at`, work resumes from current phase
- Phase transitions while paused: NOT allowed (must resume first)

This means the UI can show "Paused (was: executing)" — the underlying phase is preserved.

### 3.2 Pause/Resume Atomicity

Pause and resume are serialized under the same `SELECT ... FOR UPDATE` lock as phase transitions (§ 5.3). The lock validates `(phase, paused_at)` atomically:

```sql
BEGIN;
SELECT phase, paused_at FROM runs WHERE run_id = $1 FOR UPDATE;
-- Pause: reject if already paused or terminal
-- Resume: reject if not paused
-- Phase transition: reject if paused_at IS NOT NULL
COMMIT;
```

**Precedence:** If a pause request and a phase transition arrive simultaneously, the first to acquire the lock wins. The loser is rejected with a `phase.transition_rejected` event. There is no implicit auto-resume — the operator must explicitly resume before any phase transition can proceed.

---

## 4. RunStep Enum (Internal)

```typescript
type RunStep =
  | 'setup_worktree'
  | 'route'
  | 'planner_create_plan'
  | 'reviewer_review_plan'
  | 'wait_plan_approval'
  | 'implementer_apply_changes'
  | 'tester_run_tests'
  | 'reviewer_review_code'
  | 'create_pr'
  | 'wait_pr_merge'
  | 'cleanup'
  | 'linter_check'
  | 'security_scan';
```

**Step-to-Phase mapping:**

| Phase | Steps Active During This Phase |
| --- | --- |
| `pending` | `setup_worktree`, `route` |
| `planning` | `planner_create_plan`, `reviewer_review_plan` |
| `awaiting_plan_approval` | `wait_plan_approval` |
| `executing` | `implementer_apply_changes`, `create_pr` |
| `checking` | `tester_run_tests`, `linter_check`, `security_scan` |
| `awaiting_review` | `reviewer_review_code` |
| `awaiting_merge` | `wait_pr_merge` |
| `completed` | `cleanup` |
| `cancelled` | `cleanup` |

> **Note:** Both `completed` and `cancelled` trigger the `cleanup` step (worktree destruction, port release). The step runs as a fire-and-forget operation — cleanup failure does not change the terminal phase.

---

## 5. Transition Table (Canonical)

### 5.1 Valid Transitions

| # | From | To | Trigger | Condition |
| --- | --- | --- | --- | --- |
| T1 | `pending` | `planning` | `agent_output` | Environment ready, routing complete |
| T2 | `planning` | `awaiting_plan_approval` | `agent_output` | Plan artifact validated |
| T3 | `awaiting_plan_approval` | `executing` | `operator_action` | Plan approved |
| T4 | `awaiting_plan_approval` | `planning` | `operator_action` | Revision requested (with feedback) |
| T5 | `awaiting_plan_approval` | `cancelled` | `operator_action` | Plan rejected |
| T6 | `executing` | `checking` | `agent_output` | PR created or code pushed |
| T7 | `checking` | `awaiting_review` | `gate_result` | All automated checks pass |
| T8 | `checking` | `executing` | `gate_result` | Check failed, retries remaining |
| T9 | `checking` | `failed` | `gate_result` | Check failed, max retries exceeded |
| T10 | `awaiting_review` | `awaiting_merge` | `gate_result` | Review approved (AI + human) |
| T11 | `awaiting_review` | `executing` | `gate_result` | Changes requested |
| T12 | `awaiting_merge` | `completed` | `gate_result` | PR merged (webhook confirmation) |
| T13 | `awaiting_merge` | `failed` | `gate_result` | Merge conflict or CI regression |
| T14 | `failed` | `planning` | `operator_action` | Retry from planning |
| T15 | `failed` | `executing` | `operator_action` | Retry from execution |
| T16 | `failed` | `cancelled` | `operator_action` | Abandon run |
| T17 | Any non-terminal | `failed` | `error` | Unrecoverable error |
| T18 | Any non-terminal | `cancelled` | `operator_action` | Operator cancel |

### 5.2 Invalid Transitions

Any transition not listed in § 5.1 is **invalid**. On an invalid transition attempt:

1. The transition is rejected (phase does not change)
2. An event is logged: `{ type: "phase.transition_rejected", from, to, reason: "invalid_transition" }`
3. If the source was an agent: the agent is notified of the rejection
4. If the source was a bug: the error is logged and operator notified

**Examples of invalid transitions:**
- `completed` → anything (terminal)
- `cancelled` → anything (terminal)
- `pending` → `executing` (must go through planning)
- `checking` → `awaiting_merge` (must go through review)
- `awaiting_review` → `planning` (must go through executing first)

### 5.3 Race Condition Handling

Phase transitions are serialized per-run using `SELECT ... FOR UPDATE` on the `runs` row:

```sql
BEGIN;
SELECT phase FROM runs WHERE run_id = $1 FOR UPDATE;
-- Validate transition is legal (from current phase to requested phase)
-- If valid: UPDATE runs SET phase = $new_phase, ...
-- If invalid: ROLLBACK, log rejection
COMMIT;
```

If two events arrive simultaneously requesting conflicting transitions, the first to acquire the lock wins. The second is rejected with a `phase.transition_rejected` event.

### 5.4 Retry Semantics

When a run enters `failed`, the operator may retry. Retry targets are **deterministic and limited** — not arbitrary "return to previous phase":

| Retry Target | When Allowed | What Happens |
| --- | --- | --- |
| `planning` (T14) | Any failure | Re-plan from scratch. Previous plan artifact is archived, not deleted. |
| `executing` (T15) | Failure from `executing`, `checking`, `awaiting_review`, or `awaiting_merge` | Resume implementation. Previous commits are preserved on the branch. |

**Retry is NOT allowed to:** `pending` (environment setup is one-time), `checking` (must go through executing), `awaiting_review`/`awaiting_merge` (must re-enter via normal flow).

#### Retry Counters

The `runs` table tracks retry budgets:

```sql
ALTER TABLE runs ADD COLUMN check_fix_attempts  INT NOT NULL DEFAULT 0;  -- T8 counter
ALTER TABLE runs ADD COLUMN review_rounds       INT NOT NULL DEFAULT 0;  -- T11 counter
ALTER TABLE runs ADD COLUMN failed_retries      INT NOT NULL DEFAULT 0;  -- T14/T15 counter
```

| Counter | Incremented On | Max Default | On Exceed |
| --- | --- | --- | --- |
| `check_fix_attempts` | T8 (checking → executing) | 3 | T9 (checking → failed) |
| `review_rounds` | T11 (awaiting_review → executing) | 5 | T17 (→ failed, reason: `max_review_rounds`) |
| `failed_retries` | T14 or T15 (failed → planning/executing) | 3 | T16 forced (→ cancelled, reason: `max_retries_exhausted`) |

Operators can override defaults per-project in `project_settings.max_check_attempts`, `.max_review_rounds`, `.max_failed_retries`.

### 5.5 Transition Authorization

Every transition requires an authenticated actor. Authorization rules:

| Trigger Type | Actor | Authorization Check |
| --- | --- | --- |
| `operator_action` | Authenticated user (session) | User must be project member with `operator` or `admin` role |
| `agent_output` | Worker process | Valid worker credential (see WORKER_CREDENTIALS.md), scoped to this run |
| `gate_result` | System (automated) | Internal — no external actor; validated by gate evaluation engine |
| `error` | System | Internal — no external actor; triggered by error handler |

**Enforcement:**

```typescript
interface TransitionRequest {
  run_id: string;
  from_phase: RunPhase;
  to_phase: RunPhase;
  trigger: TriggerType;
  actor_id: string;          // user_id, worker_id, or 'system'
  actor_type: 'operator' | 'agent' | 'system';
  reason?: string;           // Required for T4, T14, T15, T16
}
```

On unauthorized attempt:
1. Transition is rejected
2. Event logged: `{ type: "phase.transition_denied", actor_id, reason: "unauthorized" }`
3. Audit trail entry created (see AUTH.md § 9)

**Cross-run isolation:** An operator credential scoped to project A cannot transition runs in project B. Worker credentials are scoped to a single run.

### 5.6 Stale Run Detection

Runs can become stuck if agents crash, webhooks are lost, or operators abandon work. A watchdog process scans for stale runs:

| Phase | Stale Threshold | Action |
| --- | --- | --- |
| `pending` | 10 minutes | → `failed` (reason: `setup_timeout`) |
| `planning` | 30 minutes | → `failed` (reason: `planning_timeout`) |
| `executing` | 2 hours (configurable) | → `failed` (reason: `execution_timeout`) |
| `checking` | 15 minutes | → `failed` (reason: `check_timeout`) |
| `awaiting_plan_approval` | 7 days | Notification only (human gate — do not auto-fail) |
| `awaiting_review` | 7 days | Notification only (human gate) |
| `awaiting_merge` | 7 days | Notification only (human gate) |

**Watchdog cadence:** Runs every 60 seconds. Configurable per-project via `project_settings.stale_thresholds`.

**Human gates are never auto-failed.** The watchdog sends escalating notifications (1d, 3d, 7d) but only operators can cancel or advance human-gated phases.

**Paused runs are excluded** from stale detection. The stale clock resets on resume.

### 5.7 Trigger Type Taxonomy

All transition triggers use a canonical vocabulary:

```typescript
type TriggerType =
  | 'operator_action'    // Human operator via UI/API
  | 'agent_output'       // AI agent completed a step
  | 'gate_result'        // Automated gate (tests, lint, review) produced a verdict
  | 'error'              // Unrecoverable error from any source
  | 'timeout'            // Watchdog stale detection (§ 5.6)
  | 'github_webhook';    // GitHub event (PR merged, check completed, review submitted)
```

**Mapping to transitions:**

| Trigger | Used By |
| --- | --- |
| `operator_action` | T3, T4, T5, T14, T15, T16, T18 |
| `agent_output` | T1, T2, T6 |
| `gate_result` | T7, T8, T9, T10, T11, T12, T13 |
| `error` | T17 |
| `timeout` | Stale transitions (§ 5.6) |
| `github_webhook` | T12 (PR merge confirmation), feeds into gate_result for T7/T10 |

> **Note:** `github_webhook` is a _source_ that often feeds into `gate_result`. For example, a GitHub PR review webhook is received, processed by the gate engine, and emitted as a `gate_result` trigger. T12 (merge) is the exception — webhook confirmation is the direct trigger since merge is an external fact, not a gate evaluation.

---

## 6. Workflow Template Phase Mapping

Workflow templates (WORKFLOW_ENGINE.md) define custom phase names. These map to canonical `RunPhase` values:

| Template Phase | Canonical RunPhase | Notes |
| --- | --- | --- |
| `planning` | `planning` | Direct mapping |
| `plan_approval` | `awaiting_plan_approval` | Gate phase |
| `implementing` | `executing` | Template uses descriptive name |
| `testing` | `checking` | Part of automated checks |
| `linting` | `checking` | Part of automated checks (parallel with testing) |
| `security_scan` | `checking` | Part of automated checks |
| `reviewing` | `awaiting_review` | Combines AI + human review |
| `reworking` | `executing` | Changes requested → back to executing |
| `merge_approval` | `awaiting_merge` | Gate phase |
| `researching` | `planning` | Spike template maps to planning |
| `decomposing` | `planning` | Epic template maps to planning |
| `coordinating` | `executing` | Epic template maps to executing |
| `quick_review` | `awaiting_review` | Incident template, 1 round max |

**Rule:** The `runs.phase` column always stores canonical `RunPhase` values. Template phase names are stored in the `run_phases.phase_name` column for display purposes.

---

## 7. UI Phase Labels

The Control Plane maps canonical phases to operator-friendly labels:

| RunPhase | UI Label | Marble State | Color |
| --- | --- | --- | --- |
| `pending` | Queued | ⏸ | Gray |
| `planning` | Planning | ● | Blue |
| `awaiting_plan_approval` | Plan Approval | ◉ (pulse) | Amber |
| `executing` | Implementing | ● | Blue |
| `checking` | Checking | ● | Blue |
| `awaiting_review` | Review | ◉ (pulse) | Amber |
| `awaiting_merge` | Merge Gate | ◉ (pulse) | Amber |
| `completed` | Done | ✓ | Green |
| `failed` | Failed | ✗ | Red |
| `cancelled` | Cancelled | ✗ | Red (outline) |

**Paused overlay:** When `paused_at` is set, the marble shows ⏸ (gray) regardless of underlying phase. Tooltip shows: "Paused (was: {phase label})".

**Human gate indicator:** Phases with ◉ (pulsing) are the ones where operator action is needed. These are the phases that appear in the "Needs Attention" panel.

---

## 8. GitHub Projects Mirroring

When phase changes, the corresponding GitHub Projects v2 field is updated:

| RunPhase | GitHub Project Status |
| --- | --- |
| `pending` | Planning |
| `planning` | Planning |
| `awaiting_plan_approval` | Awaiting Approval |
| `executing` | In Progress |
| `checking` | In Progress |
| `awaiting_review` | In Review |
| `awaiting_merge` | In Review |
| `completed` | Done |
| `failed` | Blocked |
| `cancelled` | Done |

---

## 9. Lifecycle Diagram

```
                       ┌──────────┐
                       │ pending  │
                       └────┬─────┘
                            │ T1
                            ▼
                 ┌──────────────────────┐
  T14 ┌─────────►      planning        │◄──────────────┐
      │          └──────────┬───────────┘               │
      │                     │ T2                        │ T4
      │                     ▼                           │
      │          ┌──────────────────────────┐           │
      │          │ awaiting_plan_approval   ├───────────┘
      │          └──────┬──────────┬────────┘
      │           T3 │  │          │ T5
      │              │  │          └──────────────────────────┐
      │              ▼  │                                     │
      │  T8 ┌────────────────────┐  T11                      │
      │  ┌──►    executing       │◄─────────┐                │
      │  │  └────────┬───────────┘          │                │
      │  │           │ T6                    │                │
      │  │           ▼                       │                │
      │  │  ┌────────────────────┐           │                │
      │  └──┤     checking       │           │                │
      │     └──┬─────┬───────────┘           │                │
      │   T9 │ │     │ T7                    │                │
      │      │ │     ▼                       │                │
      │      │ │  ┌──────────────────────┐   │                │
      │      │ │  │   awaiting_review    ├───┘                │
      │      │ │  └──────────┬───────────┘  (changes req.)   │
      │      │ │             │ T10                            │
      │      │ │             ▼                                │
      │      │ │  ┌──────────────────────┐                    │
      │      │ │  │   awaiting_merge     │                    │
      │      │ │  └──────┬──────┬────────┘                    │
      │      │ │    T12 │      │ T13                         │
      │      │ │        ▼      │                              │
      │      │ │  ┌──────────────────────┐                    │
      │      │ │  │     completed        │  ← Terminal        │
      │      │ │  └──────────────────────┘                    │
      │      │ │                                              │
      │      ▼ ▼                                              │
      │  ┌──────────────────────┐                             │
  T15 └──┤       failed         │                             │
         └──────────┬───────────┘                             │
                    │ T16                                     │
                    ▼                                         │
         ┌──────────────────────┐                             │
         │     cancelled        │◄────────────────────────────┘
         └──────────────────────┘  ← Terminal

  T17: Any non-terminal ──► failed    (on error or timeout)
  T18: Any non-terminal ──► cancelled (on operator cancel)
```

---

## 10. Reconciliation with Other Documents

This document is the **single authority** for run lifecycle state. Other documents that previously defined phase values or transitions MUST be updated to defer here:

### 10.1 PROTOCOL.md Reconciliation

| PROTOCOL.md (old) | This Document (canonical) | Action Required |
| --- | --- | --- |
| `blocked` phase | `failed` phase | Replace `blocked` with `failed` everywhere. `blocked` is a derived RunStatus, not a phase. |
| 8-value RunPhase enum | 10-value RunPhase enum | Add `checking`, `awaiting_merge`. Remove `blocked` as phase. |
| Direct `awaiting_review` → `completed` | Must go through `awaiting_merge` (T10 → T12) | Update transition diagram and event examples |
| `PhaseTransitionedPayload.trigger.type` excludes `github_webhook` | § 5.7 defines 6 trigger types including `github_webhook` | Align trigger type enum |
| Phase enum defined inline | Defer to `RUN_STATE_MACHINE.md § 2` | Replace inline enum with reference |

### 10.2 WORKFLOW_ENGINE.md Reconciliation

| WORKFLOW_ENGINE.md (old) | This Document (canonical) | Action Required |
| --- | --- | --- |
| Template phases treated as runtime state | Template phases are display-only (§ 6) | `runs.phase` stores canonical values; `run_phases.phase_name` stores template names |
| `run.phase_changed` events use template names | Events must use canonical `RunPhase` values | Template name included in event metadata, not as the phase value |
| Template-defined transitions | Templates define phase _ordering_, not transition rules | Transition validation always uses § 5.1, regardless of template |

### 10.3 Migration Checklist

When updating other documents to defer to this one:

- [ ] PROTOCOL.md: Remove inline RunPhase enum, reference § 2
- [ ] PROTOCOL.md: Update transition diagram to match § 9
- [ ] PROTOCOL.md: Add `checking`, `awaiting_merge` to event examples
- [ ] PROTOCOL.md: Replace `blocked` phase with `failed` in all examples
- [ ] PROTOCOL.md: Align trigger types with § 5.7
- [ ] WORKFLOW_ENGINE.md: Add note that `runs.phase` is always canonical
- [ ] WORKFLOW_ENGINE.md: Update `run.phase_changed` event docs
- [ ] CONTROL_PLANE_UX_V3.md: Verify UI label table matches § 7
- [ ] DATA_MODEL.md: Add retry counter columns from § 5.4
- [ ] ROUTING_AND_GATES.md: Reference § 5.5 for authorization

---

## 11. Cross-References

| Topic | Document |
| --- | --- |
| Phase transition events | `docs/PROTOCOL.md` § Event Schema |
| Workflow template definitions | `docs/orchestrator/WORKFLOW_ENGINE.md` |
| Gate evaluation rules | `docs/ROUTING_AND_GATES.md` § Gate Evaluation |
| UI phase display | `docs/ui/CONTROL_PLANE_UX_V3.md` § 2, § A.1, § A.7 |
| Database phase storage | `docs/DATA_MODEL.md` § runs table |
| RunStep credential mapping | `docs/WORKER_CREDENTIALS.md` § Step Credentials |
| Transition authorization | `docs/AUTH.md` § 9 Audit Trail |
| Stale threshold configuration | `docs/DATA_MODEL.md` § project_settings table |

---

## Appendix A: Codex Adversarial Review Resolutions

9 findings from Codex adversarial review, all resolved:

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | BLOCKING | PROTOCOL.md and WORKFLOW_ENGINE.md don't defer to this document | Added § 10 with reconciliation tables and migration checklist |
| 2 | BLOCKING | No authorization model for transitions | Added § 5.5 with actor types, role checks, and audit events |
| 3 | HIGH | Retry targets inconsistent ("previous phase" vs specific phases) | Fixed § 2.1 failed row; added § 5.4 with deterministic retry targets |
| 4 | HIGH | Retry budgets undefined | Added § 5.4 with counters, max defaults, and exceed behavior |
| 5 | HIGH | Concurrent pause + phase transition undefined | Added § 3.2 with atomic lock on `(phase, paused_at)` |
| 6 | HIGH | No stale run detection | Added § 5.6 with per-phase thresholds and watchdog behavior |
| 7 | MEDIUM | Lifecycle diagram ambiguous around checking/review/merge | Redrawn § 9 with explicit transition IDs on every edge |
| 8 | MEDIUM | Trigger type taxonomy inconsistent | Added § 5.7 with canonical TriggerType enum and mapping table |
| 9 | SUGGESTION | Enum count wrong (said 12, has 10); cleanup missing for cancelled | Fixed count to 10; added `cancelled` → `cleanup` in step mapping |
