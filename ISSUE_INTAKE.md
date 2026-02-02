# Issue Intake

## Philosophy

**The PM agent's job is to minimize human effort while maximizing issue clarity.**

Questions are a fallback, not a requirement. If the agent can infer scope, intent, repo, risks, and acceptance criteria from context alone, it does not ask. If something is ambiguous *and* material, it asks—once, concisely.

The PM agent is not a questionnaire. It is a sense-making engine with conversational affordances.

---

## Core Principle

> **Conductor isn't a chatbot—it's an organization that happens to speak naturally.**

The PM agent behaves like a senior PM who:
- Listens carefully
- Does their homework before speaking
- Proposes instead of interrogates
- Shuts up when they already understand

---

## The Conversation Model

### 1. You Speak Freely

Type anything:
- A paragraph
- A rant
- A Slack message copy-pasted
- A bug report verbatim
- "This thing is broken and annoying"
- A feature idea in stream of consciousness

No structure required. No mode switching. No forms.

### 2. The PM Agent Harvests Context (Invisible)

Before asking anything, the agent:
- Inspects registered repos
- Reads recent PRs and commits
- Checks open issues for duplicates or related work
- Scans error logs / stack traces (if pasted)
- Identifies relevant code areas
- Classifies the work internally (bug, feature, refactor, docs)
- Infers ownership and affected systems

This happens silently. The user doesn't see it. It's logged for audit.

**Context Retrieval Budget (Normative)**

To prevent slow inference and hallucinated context, retrieval is bounded and ordered:

| Resource | Limit | Notes |
|----------|-------|-------|
| Repo candidates | 5 max | Reduce before deep reads |
| Files read (per repo) | 20 max | Prioritize recently modified |
| Recent PRs scanned | 15 max | Title + description only |
| Open issues checked | 30 max | For duplicate detection |
| Commit history | 50 max | Recent commits in target area |

**Retrieval order:**

1. **Shallow pass (all candidate repos):** title/body + labels + file paths mentioned + error strings → narrow to ≤2 repos
2. **Deep pass (top candidate only):** targeted file reads, recent PRs, related issues
3. **If repo confidence still < 0.7:** ask one repo disambiguation question before any additional deep reads

**Rule:** If no repo candidate reaches confidence threshold after shallow pass, ask before investing in deep context.

### 3. The Agent Decides: Ask or Propose

Binary decision point based on confidence thresholds:

**Confidence Dimensions (Normative)**

| Dimension | Threshold | If Below |
|-----------|-----------|----------|
| `repo_confidence` | 0.7 | Ask repo disambiguation (1 question) |
| `intent_confidence` | 0.6 | Ask intent clarification (1 question) |
| `type_confidence` | 0.8 | Propose with flagged assumption |
| `criteria_confidence` | 0.5 | Ask for acceptance criteria OR propose template options |

**Decision rules:**

- If any dimension is below threshold → ask (max 1 question per turn, max 2 turns total)
- If all dimensions ≥ threshold → propose immediately
- After 2 clarification turns → propose anyway with flagged assumptions

**Case A — Confidence is high (all thresholds met)**

Agent does not ask questions. It says:

> "Here's the issue I'm proposing. Tell me if anything is wrong."

And presents a complete draft.

**Case B — One or two blocking unknowns (threshold not met)**

Agent asks only what it must:
- "Is this happening in prod or only staging?"
- "Should this change behavior or just fix a bug?"
- "Is backwards compatibility required?"
- "Which of these two repos should own this?"

No interrogations. No checklists. Maximum two questions before proposing anyway.

### 4. Proposal Is the Checkpoint

The PM agent always converges toward a **proposal**, not an endless chat.

Even when uncertain, it should say:

> "I'm going to assume X unless you say otherwise."

This is what senior PMs do. The human reviews a draft, not a transcript.

---

## What "Magical" Means

Magical ≠ unstructured
Magical = **anticipatory**

The agent should:
- Infer type without asking ("this is clearly a bug")
- Infer scope without asking ("auth middleware + session refresh")
- Infer acceptance criteria from codebase norms
- Infer repo from context (file paths, error messages, past work)
- Infer priority from language ("blocking", "urgent", "customers affected")
- Infer related issues and potential conflicts

Questions only appear when **inference would be irresponsible**.

---

## Hard Stop Conditions

To prevent chat drift, the PM agent has stop rules:

| Rule | Behavior |
|------|----------|
| **Max 2 clarification turns** | After 2 rounds of questions, propose anyway with stated assumptions |
| **User keeps talking** | Agent still proposes; doesn't wait for "done" signal |
| **Ambiguity remains** | Propose with flagged uncertainties, let human correct |
| **Silence** | After proposal, wait for human action (accept/revise/reject) |

The checkpoint is always a proposal. Never "let's keep discussing."

---

## The Issue Proposal

When the PM agent proposes an issue, it presents:

### Required Fields
- **Title**: Clear, specific, actionable
- **Description**: What and why (not how—agents figure that out)
- **Repo**: Which repository this targets
- **Type**: Bug / Feature / Refactor / Docs / Chore

### Inferred Fields (shown for review)
- **Scope**: Files/modules likely affected
- **Acceptance Criteria**: What "done" looks like
- **Risks**: What could go wrong, edge cases
- **Priority**: Suggested based on language and context
- **Related Issues**: Duplicates, dependencies, conflicts

### Context Summary
To build trust, proposals include a brief summary of what the agent looked at:

> 📋 **Context:** Looked at `acme/webapp` (files: `auth/middleware.ts`, `session.ts`), recent PRs (#812, #815), 3 related issues

This is not spam—it's transparency. Humans trust proposals more when they can see the agent did homework.

### Flagged Uncertainties
If the agent made assumptions, it flags them:

> ⚠️ Assumed this is a bug fix, not a behavior change
> ⚠️ Assumed production environment
> ⚠️ Could not determine if backwards compatibility is required

Human can correct these before accepting.

---

## UI Design

The intake UI reinforces proposal-over-dialogue:

```
┌─────────────────────────────────────────────────────────────┐
│  Conversation                    │  Proposal                │
│  ─────────────────               │  ─────────────────────── │
│                                  │                          │
│  You: "The login is broken       │  Title: Fix session      │
│  for users with expired          │  expiration handling     │
│  sessions, they get a blank      │  for expired sessions    │
│  page instead of redirect"       │                          │
│                                  │  Type: Bug               │
│  PM: "Got it. I see this is      │  Repo: acme/webapp       │
│  in the auth middleware.         │                          │
│  Here's what I'm proposing..."   │  Description:            │
│                                  │  Users with expired...   │
│                                  │                          │
│                                  │  Acceptance Criteria:    │
│                                  │  - Expired sessions...   │
│                                  │                          │
│                                  │  [Accept & Create]       │
│                                  │  [Revise]  [Regenerate]  │
└─────────────────────────────────────────────────────────────┘
```

### Actions

| Button | Behavior |
|--------|----------|
| **Accept & Create** | Creates issue in GitHub, optionally starts run (see note) |
| **Revise** | Human provides natural language feedback, agent updates proposal |
| **Regenerate** | Agent tries again with fresh assumptions |
| **Cancel** | Discard without creating |

No "Next" steps. No wizard. No form fields to fill.

**Auto-start run rule (Normative):**

If `auto_start_run` is enabled and user clicks "Accept & Create", Conductor must still record an explicit `OperatorAction(action='start_run')` with `operator` = the human who clicked Accept.

There is no implicit run start. The intake phase creates the issue; the execution phase is always an explicit operator action, even if triggered in the same click. This preserves audit integrity and matches the Protocol invariant that all control actions are explicit.

---

## Issue Guarantees

Once the PM agent creates an issue, it guarantees:

| Guarantee | What It Means |
|-----------|---------------|
| **Runnable** | Execution agents can start immediately |
| **Bounded** | Scope is clear; no open-ended exploration |
| **Risked** | Known edge cases and concerns are flagged |
| **Criteriad** | Acceptance criteria exist (explicit or inferred) |
| **Targeted** | Correct repo and project |
| **Unsurprising** | The PR that results won't surprise the human |

Execution agents trust issues created through intake. They don't re-validate scope or re-ask questions.

### Runnable Issue Contract (Normative)

The "Accept & Create" button is enabled only when all contract requirements are satisfied. These are validated from the rendered proposal, not a form.

| Requirement | Minimum Bar |
|-------------|-------------|
| **Title** | Imperative verb + specific scope (e.g., "Fix session handling", not "Session issue") |
| **Type** | Exactly one of: `bug`, `feature`, `refactor`, `docs`, `chore` |
| **Repo** | Exactly one target repository |
| **Description** | Includes user-visible problem or intent (what/why, not how) |
| **Acceptance Criteria** | At least 3 bullet points OR 1 Gherkin-style scenario |
| **Non-goals** | At least 1 explicit boundary (can be "Out of scope: none identified") |
| **Risks** | At least 1 risk OR explicit "Risks: none known" |

**Validation rule:** If any requirement is missing, the proposal shows a warning and "Accept & Create" is disabled until corrected.

**AC special case:** If acceptance criteria cannot be inferred and `require_acceptance_criteria` is true, agent MUST ask exactly one question offering two template options:
> "I need acceptance criteria to make this runnable. Which fits better?
> A) [inferred template based on type]
> B) [alternative template]
> Or describe what 'done' looks like."

If user refuses or remains unclear after 2 turns → refuse to create.

---

## What the PM Agent Does NOT Do

| Anti-Pattern | Why It's Wrong |
|--------------|----------------|
| Ask questions it could answer itself | Wastes human time |
| Present a checklist or form | Breaks natural conversation |
| Wait for explicit "I'm done" | Humans don't work that way |
| Create issues without proposal review | Humans must approve artifacts |
| Start execution without issue | Issue is the contract |
| Engage in open-ended brainstorming | Converge to proposal |
| Fabricate issues from incoherent input | Hallucinated work is worse than no work |

### Refusal Condition (Normative)

If the human input is fundamentally unclear, the agent must ask for clarification rather than fabricate an issue. A bad issue is worse than no issue.

**Refusal triggers (any one is sufficient):**

| Trigger | Example |
|---------|---------|
| No clear objective | "Make it better" with no specifics |
| Bug without observable symptom | "Something is wrong" with no error/behavior |
| Contradictory constraints | "Change the behavior but don't change anything" |
| Repo ambiguous across >2 candidates | Multiple repos match, user won't clarify |
| No actionable response after 2 turns | User keeps adding unrelated context |

**Refusal behavior:**

1. Ask exactly one clarifying question targeting the specific gap
2. If unclear after 2 turns total → refuse with explanation:
   > "I can't responsibly create a runnable issue without understanding [specific gap]. Please provide [specific ask] and try again."
3. Log refusal with reason in audit trail

**Rule:** One question max per turn; two turns max; then refuse. Never fabricate to avoid refusal.

---

## Integration with Execution

After issue creation:

1. **Issue exists in GitHub** with full context
2. **Human can start run immediately** (button in UI, or later from Backlog)
3. **Execution agents receive issue as input** — they trust it

The PM agent's work is done. Execution is a separate phase with separate agents.

```
Intake (PM Agent) → Issue (Artifact) → Execution (Planning/Implementation Agents)
```

---

## Conversation Examples

### Example 1: High Confidence (No Questions)

**Human:**
> "The password reset emails are going to spam for gmail users"

**PM Agent:**
> "I see this is likely a deliverability issue. Here's what I'm proposing:
>
> **Fix Gmail spam classification for password reset emails**
>
> Password reset emails are being flagged as spam for Gmail users. Likely causes include missing email authentication (SPF/DKIM/DMARC) or content triggering spam filters.
>
> *Acceptance Criteria:*
> - Password reset emails reach Gmail inbox (not spam)
> - Email authentication passes validation (SPF, DKIM, DMARC)
> - No regression for other email providers
>
> *Non-goals:* General email template redesign
>
> *Risks:* DNS propagation delays if authentication records need updates
>
> 📋 *Context:* Looked at `acme/email-service` (files: `sendgrid.ts`, `templates/`), recent PR #234
>
> *Repo: acme/email-service*
>
> Does this look right?"

No questions asked. Proposal presented.

### Example 2: One Blocking Unknown

**Human:**
> "Users are complaining about slow page loads"

**PM Agent:**
> "I found several areas that could affect page load. One question:
>
> Is this the dashboard specifically, or all pages? (I see the dashboard has had recent performance issues in past PRs)"

**Human:**
> "Dashboard mainly, but also the settings page"

**PM Agent:**
> "Got it. Here's what I'm proposing:
>
> **Optimize dashboard and settings page load performance**
>
> ..."

One question. Then proposal.

### Example 3: Ambiguity Flagged

**Human:**
> "Add dark mode"

**PM Agent:**
> "Here's what I'm proposing:
>
> **Implement dark mode theme**
>
> Add a dark color scheme option to the application with user preference persistence.
>
> *Acceptance Criteria:*
> - Toggle in settings to switch themes
> - Preference persists across sessions
> - All existing components render correctly in dark mode
>
> ⚠️ *Assumed:* This is a user preference, not a system-follows-OS-setting. Let me know if you want automatic detection.
>
> ⚠️ *Assumed:* Full application scope. Let me know if this should be limited to specific pages first.
>
> *Repo: acme/webapp*"

Assumptions flagged. Human can correct or accept.

---

## Policy Knobs

### Per-Project Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `intake.max_clarification_turns` | 2 | Questions before forced proposal |
| `intake.auto_start_run` | false | Offer to start run immediately after creation |
| `intake.require_acceptance_criteria` | true | Block creation if criteria cannot be inferred or provided |
| `intake.infer_priority` | true | Suggest priority from language |

### Context Sources

The PM agent pulls context from:
- Registered repos (code, recent commits, open PRs)
- Open issues (duplicates, related work)
- Past completed runs (patterns, common issues)
- Team conventions (from past issue/PR language)

---

## Audit Trail

Every intake conversation is logged using the standard data model entities:

### Entity Mapping (Normative)

| Intake Artifact | Data Model Entity | Notes |
|-----------------|-------------------|-------|
| Proposal draft | `Artifact(type='issue_proposal', version=N)` | Stored in DB; version increments on revision |
| Final accepted proposal | `Artifact(type='issue_proposal', version=final)` | Marked as accepted |
| Issue creation | `GitHubWrite(kind='issue_create')` | Tracks GitHub API call |
| Intake transcript | `Event` stream | Events: `intake.started`, `intake.context_retrieved`, `intake.question_asked`, `intake.proposal_generated`, `intake.accepted`, `intake.refused` |
| Context summary | Embedded in proposal | See "Context Summary" below |

### What's Logged

- Full transcript (human + agent messages as events)
- Context retrieved (files read, issues checked, repos scanned)
- Inferences made (with confidence scores)
- Proposal versions (each revision is a new Artifact version)
- Final issue created (GitHubWrite record with issue URL)
- Refusals (with reason)

This is viewable in Conductor UI under the issue's intake history.

### Idempotency

Issue creation must be idempotent using `idempotency_key`. Retries must not create duplicate issues.

**Mechanism:**
- `GitHubWrite.idempotency_key` is assigned before creation attempt
- On retry, check if `GitHubWrite` already has a `github_url` → skip creation
- Marker in issue body: `<!-- conductor:intake {"intake_id":"..."} -->`

---

## Further Reading

- [VISION.md](VISION.md) — Product vision and philosophy
- [ARCHITECTURE.md](ARCHITECTURE.md) — System components
- [CONTROL_PLANE_UX.md](CONTROL_PLANE_UX.md) — UI screens and operator workflows
