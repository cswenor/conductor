# Appendix A: Search Query Strategies

Run these queries via `mcp__github__search_issues`:

1. **Title keyword:** `repo:cswenor/conductor is:issue "{keyword}" in:title`
2. **Body keyword:** `repo:cswenor/conductor is:issue "{keyword}" in:body`
3. **Area + keyword:** `repo:cswenor/conductor is:issue label:area:{area} "{keyword}"`
4. **Alternate phrasing:** `repo:cswenor/conductor is:issue "{alt_phrase}"`
5. **Open only:** `repo:cswenor/conductor is:issue is:open "{keyword}"`

Deduplicate results by issue number before returning.

---

# Appendix B: Issue Body Template

```markdown
## Problem / Goal

{problem_summary}

## User Story (if feature)

As a {user_type}, I want {goal} so that {benefit}.

## Why Now

{urgency_rationale}

## Non-goals

- {exclusion_1}
- {exclusion_2}

## Assumptions

- {assumption_1}

## Related Issues (if any)

- #{num} - {title} ({relationship})

## Acceptance Criteria

- [ ] {criterion_1}
- [ ] {criterion_2}

## Definition of Done

- [ ] Code merged to main
- [ ] Tests passing
```

---

# Appendix C: Diff Preview Template

```markdown
## Proposed Update to Issue #{num}

### Additions to Acceptance Criteria:

- - [ ] {new_criterion}

### Additions to Problem Statement:

- {additional_context}

### Labels to Add:

- {label}
```

---

# Appendix D: Merge Plan Template

```markdown
## Merge Plan

**Canonical Issue:** #{num} (existing) OR "New consolidated issue"

**Will close as duplicates:**

- #{num} - {title}

**Content to preserve:**

- From #{num}: {what_to_preserve}

**Supersedes section to add:**

> This issue consolidates #{a}, #{b}, and #{c}.
```

---

# Appendix E: Label Derivation

## Type Labels

| User signals                           | Type Label     |
| -------------------------------------- | -------------- |
| broken, doesn't work, error, crash     | `type:bug`     |
| add, new, want to be able to           | `type:feature` |
| not sure, explore, research            | `type:spike`   |
| multiple features, initiative, project | `type:epic`    |

## Area Labels

| User mentions                         | Area Label       |
| ------------------------------------- | ---------------- |
| UI, button, page, component, CSS      | `area:frontend`  |
| API, endpoint, database, query        | `area:backend`   |
| contract, on-chain, blockchain, smart | `area:contracts` |
| CI, deploy, script, tooling, workflow | `area:infra`     |

> **Note:** Not all area labels may exist in your project. Only create the ones relevant to your work.
