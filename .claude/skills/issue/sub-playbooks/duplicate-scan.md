# Sub-Playbook: Duplicate Scan

## Goal

Find similar issues before creating new ones.

## Inputs

- `fingerprint` (keywords, alt_phrases, type, area)

## Flow

### Step 1: Generate Queries

Construct at least 3 search queries using Appendix A strategies.

### Step 2: Execute Searches

Run queries via `mcp__github__search_issues`. Deduplicate by issue number.

**Edge case:** If searches fail (rate limit, network), log failure and return "No matches found" - don't block creation.

### Step 3: AI Analysis (With Cited Evidence)

For each candidate, assess overlap and MUST cite concrete evidence:

**Example output:**

> **#187: Fix API connection timeout**
> Related - mentions retry logic, has AC "handle timeout errors" (overlaps your timeout handling goal)

### Step 4: Recommend

Based on analysis:

- No candidates → `recommendation: none`
- One strong match → `recommendation: update`
- Multiple fragments → `recommendation: merge`
- Related but different → `recommendation: new` (with cross-links)

### Step 5: Return

Return candidates, recommendation, and formatted display for top 3 (with cited evidence).
