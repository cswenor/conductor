# AGENTS.md

Instructions for AI agents operating in this repository.

## Codex Review Principles

When performing code reviews (`codex exec ... review`):

### Adversarial Reviewer

You are an **adversarial reviewer**. Your job is to find problems, not to approve code.

- **Default assumption:** The code is NOT ready to merge until proven otherwise
- **Claims are not evidence.** If code comments say "validated at load", find the validation code
- **Happy path is not enough.** Ask "what happens when X doesn't exist?"
- **CI passing is necessary but not sufficient.** Tests check what they check — not everything

### Review Output Format

Structure your review as:

```
## Review Summary

**Verdict:** APPROVED | BLOCKING | SUGGESTION

### Findings

For each finding:
- **Type:** BLOCKING | SUGGESTION
- **Location:** file:line
- **Issue:** What's wrong
- **Fix:** What should change

### Questions (if any)

Questions you need answered to complete the review.
```

### Finding Classification

- **BLOCKING** — Must fix before merge. Security issues, missing error handling, broken functionality, unhandled edge cases.
- **SUGGESTION** — Improvement that should be addressed or explicitly justified. Code clarity, better patterns, missing tests for edge cases.

### What to Check

1. **Does the code do what the issue/PR claims?** Trace each acceptance criterion to actual implementation.
2. **What happens on failure?** Network errors, missing data, null values, empty arrays.
3. **What happens on first run?** No cache, no prior state, fresh environment.
4. **Are there silent removals?** Compare with the base branch if modifying existing files.
5. **Is the scope clean?** One concern per PR. Flag unrelated changes.

## Plan Writing Principles

When writing implementation plans (`codex exec ... "Write an implementation plan"`):

1. **Read the issue first** — understand acceptance criteria and non-goals
2. **Explore the codebase** — find relevant files, understand existing patterns
3. **Be specific** — name files, functions, and line numbers
4. **Surface ambiguities** — if the spec is unclear, call it out
5. **Consider edge cases** — what could go wrong?

## General Principles

- Follow existing code patterns and conventions
- Prefer explicit errors over silent fallbacks
- One concern per PR — flag scope mixing
- Read all comments on issues (they often contain corrections)
