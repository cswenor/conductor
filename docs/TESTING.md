# Testing Strategy

> **Status:** Normative. This defines the test pyramid, coverage targets, contract test interfaces, E2E scenarios, and CI gate requirements for Conductor.

## 1. Test Pyramid

```
        ╱╲
       ╱E2E╲          ~10 scenarios, Playwright, full stack
      ╱──────╲
     ╱Contract╲        ~20 tests, Pact/schema validation
    ╱──────────╲
   ╱ Integration╲      ~50 tests, multi-package, real DB
  ╱──────────────╲
 ╱     Unit       ╲    ~500+ tests, Vitest, isolated
╱──────────────────╲
```

| Layer | Count Target | Speed | Dependencies | Purpose |
| --- | --- | --- | --- | --- |
| Unit | 500+ | < 2 min total | None (mocked) | Logic correctness |
| Integration | 50+ | < 5 min total | In-memory SQLite, mock Redis | Cross-module correctness |
| Contract | 20+ | < 1 min total | Schema validation only | Interface compatibility |
| E2E | 10+ | < 10 min total | Full stack (Docker) | User workflow correctness |

---

## 2. Coverage Targets

| Package | Current Files | Current Tests | Target Coverage | Gate |
| --- | --- | --- | --- | --- |
| `packages/shared` | 105 | 72 test files | 80% line coverage | CI blocks merge below 75% |
| `packages/web` | 60 | 19 test files | 60% line coverage | CI blocks merge below 50% |
| `packages/worker` | ~20 | 10 test files | 70% line coverage | CI blocks merge below 60% |

**Coverage provider:** V8 (configured in `vitest.config.ts`).

**Uncoverable exclusions:** Generated types, migration files, dev-only scripts.

---

## 3. Unit Testing

### 3.1 Framework

- **Vitest 4.x** — already configured at project root
- **Environment:** Node.js (jsdom for React components)
- **Test pattern:** `packages/*/src/**/*.test.{ts,tsx}`
- **Commands:** `pnpm test`, `pnpm test:watch`, `pnpm test:coverage`

### 3.2 Mocking Strategy

| Dependency | Mock Strategy | Reason |
| --- | --- | --- |
| Database (SQLite) | In-memory `:memory:` with real migrations | Tests real SQL, fast, no cleanup |
| Redis / BullMQ | `vi.mock()` with custom implementations | Avoid Redis dependency in unit tests |
| GitHub API | `vi.mock()` or MSW (Mock Service Worker) | Deterministic, no rate limits |
| AI providers | `vi.mock()` with canned responses | Deterministic, no cost |
| File system | Real temp directories (cleaned in afterEach) | Tests real I/O paths |
| Time | `vi.useFakeTimers()` | Deterministic timeouts |

### 3.3 Test Data Management

**Seed functions** (to be implemented in shared package):

```typescript
// Test helpers for creating consistent test data
function seedUser(db: Database): User
function seedProject(db: Database, userId: string): Project
function seedRepo(db: Database, projectId: string): Repo
function seedTask(db: Database, projectId: string): Task
function seedRun(db: Database, taskId: string, phase?: RunPhase): Run
```

**Factory pattern** for complex scenarios:

```typescript
const run = RunFactory.create({
  phase: 'executing',
  check_fix_attempts: 2,  // Near retry limit
  review_rounds: 0,
});
```

---

## 4. Integration Testing

### 4.1 Scope

Integration tests verify multi-module interactions with real databases but mocked external services.

| Integration Boundary | What's Real | What's Mocked |
| --- | --- | --- |
| Orchestrator + DB | SQLite, event creation, state mutations | Redis pub/sub |
| Worker + Agent Runtime | Agent error handling, retry logic | AI provider responses |
| API Routes + Auth | Session validation, middleware chain | GitHub OAuth |
| Events + Pub/Sub | Event persistence, stream events | Redis (in-memory substitute) |
| Webhook + Event Pipeline | Normalization, dedup, event creation | GitHub webhook source |

### 4.2 Database Tests

All integration tests use in-memory SQLite with full migration chain:

```typescript
beforeEach(() => {
  db = initDatabase({ path: ':memory:' });
  // Migrations run automatically via initDatabase
  // Seed base data
});

afterEach(() => {
  db.close();
});
```

---

## 5. Contract Tests

### 5.1 Orchestrator ↔ Worker Contract

The worker task protocol (API_CONTRACTS.md § 11.2) defines the interface between orchestrator and worker.

**Contract test approach:** JSON Schema validation on both sides.

```typescript
// orchestrator/contracts/task-request.schema.json
// worker/contracts/task-request.schema.json
// Both MUST be identical — CI validates this

describe('Task Request Contract', () => {
  it('orchestrator output matches worker input schema', () => {
    const request = orchestrator.createTaskRequest(run, task);
    expect(validate(request, taskRequestSchema)).toBe(true);
  });

  it('worker result matches orchestrator input schema', () => {
    const result = worker.createTaskResult(task, output);
    expect(validate(result, taskResultSchema)).toBe(true);
  });
});
```

**Key interfaces to test:**

| Interface | Schema File | Producer | Consumer |
| --- | --- | --- | --- |
| Task Request | `task-request.schema.json` | Orchestrator | Worker |
| Task Result | `task-result.schema.json` | Worker | Orchestrator |
| Worker Registration | `worker-registration.schema.json` | Worker | Orchestrator |
| Heartbeat | `worker-heartbeat.schema.json` | Worker | Orchestrator |
| Stream Event V2 | `stream-event-v2.schema.json` | Pub/Sub | SSE Route |

### 5.2 API ↔ UI Contract

API response shapes tested against TypeScript interfaces:

```typescript
describe('Runs API Contract', () => {
  it('GET /api/runs returns RunsResponse shape', async () => {
    const response = await GET('/api/runs');
    expect(response.status).toBe(200);
    const body = await response.json();
    assertType<RunsResponse>(body);
  });
});
```

---

## 6. E2E Test Scenarios

### 6.1 Framework

- **Playwright** for browser-driven E2E tests
- **Docker Compose** for full stack (Next.js + SQLite + Redis)
- **Test environment:** Isolated `.env.test` with test GitHub App credentials

### 6.2 Scenario List

| # | Scenario | Type | Critical Path? |
| --- | --- | --- | --- |
| 1 | **Happy path: issue → run → plan → execute → check → review → merge → done** | Full lifecycle | Yes |
| 2 | **Plan rejection: operator rejects plan → run cancelled** | Error path | Yes |
| 3 | **Plan revision: operator requests revision → re-plan → approve** | Loop path | Yes |
| 4 | **Check failure + retry: tests fail → AI fix → re-check → pass** | Retry path | Yes |
| 5 | **Review changes requested → rework → re-review → approve** | Loop path | Yes |
| 6 | **Operator pause/resume during execution** | Control path | Yes |
| 7 | **Operator cancel mid-execution** | Abort path | Yes |
| 8 | **Rate limit → exponential backoff → success on retry** | Transient error | No |
| 9 | **Max retry exhaustion → run blocked → operator retry** | Error escalation | No |
| 10 | **Concurrent runs: 3 runs in parallel, no interference** | Isolation | Yes |
| 11 | **SSE reconnect: client disconnects, reconnects with Last-Event-ID** | Real-time | No |
| 12 | **GitHub webhook: PR merged → run completes** | Integration | Yes |
| 13 | **Stale run: watchdog detects stuck run → marks blocked** | Recovery | No |
| 14 | **Project creation → repo detection → first run** | Onboarding | Yes |

### 6.3 E2E Test Data

- **GitHub:** Test organization with test repos (read-only, pre-seeded)
- **Auth:** Test GitHub OAuth app with known credentials
- **Database:** Fresh SQLite per test run (no shared state)
- **Redis:** Fresh Redis per test run (FLUSHDB in beforeAll)

---

## 7. Load Testing

### 7.1 Criteria

| Metric | Target | Tool |
| --- | --- | --- |
| Concurrent active runs | 10 per project | k6 or Artillery |
| WebSocket/SSE connections | 100 concurrent | k6 WebSocket |
| GitHub API call rate | < 5000/hour (installation limit) | Custom counter |
| Webhook throughput | 50 webhooks/second | k6 HTTP |
| Event stream latency | < 500ms (publish to SSE delivery) | Custom measurement |
| Database write throughput | 100 events/second | SQLite benchmark |
| API response latency (p95) | < 200ms for reads, < 500ms for mutations | k6 HTTP |

### 7.2 Load Test Scenarios

| Scenario | Description | Duration |
| --- | --- | --- |
| Steady state | 5 concurrent runs, constant webhook stream | 10 min |
| Spike | 0 → 10 runs in 30 seconds | 2 min |
| Soak | 3 concurrent runs, low webhook rate | 1 hour |
| SSE scale | 100 SSE connections, constant event stream | 10 min |

---

## 8. CI Gate Requirements

### 8.1 Required Checks (Must Pass Before Merge)

| Check | Command | Timeout | Blocking? |
| --- | --- | --- | --- |
| TypeScript type check | `pnpm typecheck` | 2 min | Yes |
| ESLint | `pnpm lint` | 2 min | Yes |
| Unit + Integration tests | `pnpm test` | 5 min | Yes |
| Coverage threshold | `pnpm test:coverage` | 5 min | Yes (see § 2) |
| Contract schema validation | `pnpm test:contracts` | 1 min | Yes |
| Build succeeds | `pnpm build` | 3 min | Yes |

### 8.2 Optional Checks (Informational)

| Check | Command | When |
| --- | --- | --- |
| E2E tests | `pnpm test:e2e` | Nightly or on release branch |
| Load tests | `pnpm test:load` | Weekly or on performance-tagged PRs |
| Security audit | `pnpm audit` | Daily |
| Bundle size | `pnpm build:analyze` | On UI changes |

### 8.3 CI Pipeline

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test:coverage
      - run: pnpm test:contracts
      - run: pnpm build
```

---

## 9. Cross-References

| Topic | Document |
| --- | --- |
| API endpoint schemas (for contract tests) | `docs/API_CONTRACTS.md` |
| Worker task protocol (for contract tests) | `docs/API_CONTRACTS.md` § 11.2 |
| Event types (for event testing) | `docs/EVENT_MODEL.md` § 3 |
| Run phase transitions (for state machine tests) | `docs/RUN_STATE_MACHINE.md` § 5 |
| Error classes (for error handling tests) | `docs/ERROR_HANDLING.md` § 1 |

---

## Appendix A: Codex Adversarial Review Resolutions

Review conducted 2026-02-20. 13 findings (6 BLOCKING, 4 HIGH, 3 MEDIUM).

### Inline Fixes Applied

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| 4 | E2E scenarios use `failed` phase; code has `blocked` | BLOCKING | Fixed to `blocked` in scenarios 9 and 13 |
| 5 | Integration snippet uses `createDatabase`/`runMigrations` (not exported) | BLOCKING | Fixed to `initDatabase({ path: ':memory:' })` |
| 6 | Seed functions described as "already exist"; phase `checking` invalid | BLOCKING | Changed to "to be implemented"; fixed phase to `executing` |
| 12 | API contract example uses `RunListResponse`; actual is `RunsResponse` | MEDIUM | Fixed type name |

### Implementation Gaps (Tracked)

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | `pnpm test:contracts` script does not exist | BLOCKING | To be added to package.json when contract tests implemented |
| 2 | Contract section assumes JSON Schema files; code uses TypeScript interfaces | BLOCKING | Spec defines target; contract testing via Zod or JSON Schema TBD |
| 3 | Playwright + Docker Compose E2E infra not implemented | BLOCKING | Spec defines target; E2E infra to be built |
| 7 | Coverage thresholds not configured in Vitest | HIGH | To be added to vitest.config.ts |
| 8 | No separate test suite commands (test:unit, test:integration) | HIGH | To be added to package.json |
| 9 | `pnpm test:e2e`, `test:load`, `build:analyze` not in scripts | HIGH | To be added when infra exists |
| 10 | CI workflow file does not exist | HIGH | To be created at `.github/workflows/ci.yml` |
| 11 | File counts may be stale | MEDIUM | Counts are approximate; update via automated script |
| 13 | MSW mentioned but not installed | MEDIUM | Aspirational option alongside `vi.mock()` |
