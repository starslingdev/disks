# Dependency security

Use the exact pnpm version in `package.json`. The workspace policy applies to this repository's dependencies locally and in CI:

- **Quarantine:** every registry dependency, including transitives and frozen lockfile entries,
  must be at least 72 hours old. Missing publication timestamps fail closed. There are no age
  exceptions.
- **Trust downgrade:** `trustPolicy: no-downgrade` rejects weaker publication trust evidence.
  `trustLockfile: false` rechecks the lockfile instead of assuming a contributor generated it
  under the same policy. Integrity pinning remains in addition to these checks.
- **Install scripts:** `ignoreScripts: true` disables project and dependency install lifecycle
  scripts. `strictDepBuilds: true` and an empty `allowBuilds` map also make the dependency build
  policy explicit. Build, lint and test commands are invoked intentionally through pnpm; they
  remain executable. Do not add install-script exceptions to make an update pass unnoticed.
- **Dependency majors:** Renovate requires Dependency Dashboard approval before creating major
  update PRs and never automerges them, including dev dependencies and GitHub Actions. Review
  their migration notes and merge explicitly. Compatible dev-dependency updates may automerge
  after required checks pass. Renovate also applies a three-day age gate and requires a timestamp.

The workflow and dependency policies are version-controlled. Protect their changes through required
PR review and required CI checks on `main`. A quarantine or trust failure requires investigation;
do not bypass it with lockfile-trust flags, broad exclusions, or an install-script allowance.

The [Mastra benchmark](../.github/bench/README.md) installs a separate third-party workspace at a frozen revision. Both benchmark services pass `--trust-lockfile` to avoid registry policy lookups during offline store reuse, while leaving pnpm package integrity checks enabled. That workload configuration does not apply to installation of this repository's dependencies or release validation.

Action release majors have an additional version-specific human approval check in the release
publisher. Release CI rebuilds, checks and smoke-tests the committed action; publication uses the
same SHA and never recompiles with write credentials.

Typechecking uses the pinned official TypeScript compiler.
