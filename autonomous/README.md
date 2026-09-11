# Moni Autonomous Dev Loop

A controlled engineering review loop between Claude Code (implementer)
and an independent OpenAI reviewer, so a human no longer has to
manually copy reports and instructions between the two. This is **not**
two AIs chatting freely — it is git-as-source-of-truth, structured JSON
contracts, explicit acceptance criteria, bounded iterations,
deterministic tests, a full audit trail, and hard human-approval gates
for anything irreversible.

## Priority order

Every review respects, strictly in this order:

`FINANCIAL CORRECTNESS > DATA INTEGRITY > TRACEABILITY > FRESHNESS > RELIABILITY > INTELLIGENCE > UX > FEATURES`

A prettier product never overrides financial correctness.

## The loop

```
TASK SPEC
   |
CLAUDE IMPLEMENTER
   |
tests / build / probes / diff
   |
REVIEW_PACKET.json
   |
OPENAI REVIEWER
   |
  PASS -> close iteration, produce final report
  HOLD -> REVIEW_RESPONSE.json -> Claude consumes corrections -> implement
          -> retest -> regenerate packet -> reviewer again
  BLOCKED_HUMAN -> STOP, surface exact human action required
```

Repeats until PASS or a human blocker. `MAX_ITERATIONS` (default 5) —
if still HOLD after that many iterations, the loop stops with
`BLOCKED_HUMAN` / `MAX_AUTONOMOUS_ITERATIONS_REACHED`. It never loops
indefinitely.

## Roles are never blurred

- **Claude Code** implements: writes code, runs tests/build, produces
  the review packet, commits to the task branch.
- **The OpenAI reviewer** is read-only: it consumes evidence and
  returns a verdict. It never edits files, commits, pushes, or merges.

## Contracts

Three JSON Schemas live in this directory and are enforced by
`lib/autonomousReviewContracts.js` (via the repo's existing
`lib/jsonSchemaLite.js` — no new dependency):

- `TASK_SPEC.schema.json` — the task contract. Immutable during a run
  unless a human explicitly edits it. See `TASK_SPEC.example.json` for
  the shape, or `TASK_SPEC.first-test-task.json` for the real first
  canary task.
- `REVIEW_PACKET.schema.json` — what Claude must produce every
  iteration: real diff, real test/build evidence, and an explicit
  PASS/FAIL/UNVERIFIED/MISSING_EVIDENCE status per acceptance
  criterion. No field may claim PASS without evidence.
- `REVIEW_RESPONSE.schema.json` — what the reviewer must return:
  `verdict` (PASS/HOLD/BLOCKED_HUMAN), `blocking_findings`,
  `required_changes`, and (for BLOCKED_HUMAN) a typed `human_action`
  reason plus a precise description.

`reviewerVerdictIsInternallyConsistent()` never trusts a reviewer PASS
at face value either — it's cross-checked against the packet's own
acceptance criteria before being accepted, the same "evidence, not
assertion" standard applied symmetrically to both sides of the loop.

## Self-modification guard

A normal task can never weaken the loop that judges it. Any file
matching one of `DEFAULT_PROTECTED_PATTERNS` in
`lib/autonomousReviewContracts.js` — the loop's own workflow, this
reviewer prompt, its schemas, its scripts, or its contracts module —
gets classified `AUTONOMOUS_INFRA_CHANGE` and requires explicit human
approval before it can be applied, regardless of what the task spec
says.

## How a task branch is created

Every autonomous task gets its own branch, named
`autonomous/<task_id>`, derived by `deriveTaskBranchName()` in
`lib/autonomousReviewContracts.js`. The task_id is sanitized to safe
branch-name characters (lowercased, non-alphanumerics collapsed to a
single `-`). Each task tracks a full trace: base SHA, the branch, every
iteration's head SHA and verdict, and the final head SHA
(`lib/autonomousGitContract.js::buildInitialTrace` /
`appendIterationRecord`). The loop never force-pushes and never
rewrites shared history — see `isForcePushArgs()`.

Before every iteration, `checkGitState()` verifies the working tree is
clean, the current branch matches what's expected, and the current SHA
matches either the base SHA (iteration 1) or the previous iteration's
head SHA (iteration > 1). Any mismatch — an unrelated uncommitted
change, an unexpected push, a branch switch — stops the loop with
`GIT_STATE_CHANGED` rather than guessing, rebasing, or resetting.

## Iteration limit

`DEFAULT_MAX_ITERATIONS = 5` (`shouldStopIteration()` in
`lib/autonomousReviewContracts.js`). PASS and BLOCKED_HUMAN always stop
the loop immediately, at any iteration. HOLD continues until either a
later PASS/BLOCKED_HUMAN or the limit is reached, at which point the
loop stops with `MAX_AUTONOMOUS_ITERATIONS_REACHED`.

## Human safety gates (hard stops, always)

The loop may **prepare** any of the following as a proposal/diff for
human review — it may never **execute** one autonomously:

destructive DB operations, DROP/TRUNCATE, deleting user financial data,
RLS/security-policy changes, service-role permission changes,
production migrations, financial-truth formula changes, Net Worth or
derivative-equity semantic changes, external purchases/billing/plan
changes, API secret creation/rotation, production merges, replacing
canonical provider identity, silent data corrections, and anything the
task spec itself classifies `risk_level: HIGH`.

## Rollout status

This is a staged build — later phases are only started once the prior
phase is proven with real evidence, not assumed:

- **Phase A — deterministic foundation** (this directory + the
  `lib/autonomous*` modules + their tests). No external AI calls.
- **Phase B — OpenAI reviewer smoke test.** Proves `OPENAI_API_KEY`
  actually works from inside GitHub Actions, with a trivial fixed
  request, before anything real is built around it.
- **Phase C — Claude Code headless smoke test.** The critical proof:
  can Claude Code run unattended inside GitHub Actions at all, on a
  disposable low-risk change, with zero financial code, zero API
  routes, zero DB, zero Vercel/Supabase involvement. If this fails or
  the required secret is missing, that's reported as a real
  `BLOCKED_HUMAN` limitation — the project goal is never silently
  downgraded to a human-in-the-loop fallback.
- **Phase D — full autonomous loop**, only once both B and C pass. The
  first real task run through it is
  `autonomous-loop-documentation-canary` (see
  `TASK_SPEC.first-test-task.json`) — deliberately low-risk and
  non-financial, and deliberately expected to be able to HOLD on its
  first iteration, to prove the automatic second-iteration path works
  without a human copying anything.

## Cost and logging

Every run produces artifacts: `task-spec.json`,
`iteration-NN-review-packet.json`, `iteration-NN-review-response.json`
per iteration, and a `final-summary.json`. The reviewer packet includes
only the task spec, the relevant diff, relevant files, test/build
evidence, live evidence, and prior findings — never the whole repo.
Secrets are never logged; `lib/aiGateway.js::buildSafeLogEntry`'s
allow-list pattern (list what's safe to log, exclude everything else by
construction) is the model this loop follows for its own logging.

## Fail closed

If the reviewer API is unavailable, its JSON is invalid or fails schema
validation, tests can't run, git state is ambiguous, or required
evidence is missing — the loop stops. It never assumes PASS.
