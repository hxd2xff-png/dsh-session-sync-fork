# Restore Outcomes Implementation Plan

**Goal:** Make plugin and skill restore outcomes explicit without destroying valid local configuration.
**Architecture:** Keep route envelopes compatible; the browser checks both transport and business outcomes. Prepare profile manifests by merging local dependencies and skipping unavailable cloud local dependencies. Preserve local loader configuration when skipping prevents safely applying remote loader files.
**Tech Stack:** JavaScript ESM, Node test runner.
**Spec:** User-approved scope in conversation m00547.

## Constraints
No source push, no cloud deletion, no hardcoded device paths, no changes to existing tests or CI. Installation remains deferred until restart; never label it installed.

## Task 1: Browser feedback
Modify client.js callCloud, refresh, run and cloudSummary. Reject value.ok === false, retain operation errors during refresh, clear previous success when starting a new operation. Display array item details and translated restore fields. Run node --check client.js and existing client-render tests.

## Task 2: Safe plugin and skill restore
Modify lib/cloud-core.mjs rebindLocalDependencies and pullSnapshot. Preserve local dependencies, fall back to valid local source/package when cloud source missing, omit unavailable dependency and bundle with explicit reason. Preserve local cordis configuration when a dependency is skipped. Return installDeferred and descriptive message. Skill restore rejects absent requested history and returns target directory, restored/skipped names and reason. Verify temporary-directory roundtrip and existing core tests; old throw-on-missing expectation is intentionally superseded, report it without changing tests.

## Task 3: Deployment
Run full tests/typecheck and inspect failures. Pack to temporary directory, back up local mirror tarball, replace tarball and install with --legacy-peer-deps in active profile. Compare runtime source hashes. Do not restart host from its active session. Live UI/restart validation remains explicitly pending if not executable.
