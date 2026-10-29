# Releasing Disks

`package.json` is the only release version source. The root `disks` package is private because
this repository distributes a GitHub Action, not an npm package. There are no internal packages
to version or publish. npm OIDC, provenance, registry credentials and npm bootstrap are inapplicable.

## Contributing

Use the Node version in `.node-version`, install the pinned pnpm version, and run `pnpm install --frozen-lockfile`.
For user-visible changes run `pnpm changeset`, select `disks`, and choose:

- **patch** for compatible fixes;
- **minor** for compatible features;
- **major** for incompatible input, output or behavior changes.

Write the summary for consumers. For every breaking change include **Breaking changes** and
**Migration** instructions with a concrete before/after example. These paragraphs are preserved
in the Major Changes changelog section and GitHub release notes. Docs/tooling changes that do not
need a release can omit a changeset. Continue building and committing `dist/` with source changes;
all branches and commit SHAs remain directly runnable.

## Initial 0.1.0 release

The package starts at `0.0.0`, an unpublished baseline. The initial minor changeset proposes
`0.1.0`. Configure the release App and environments described under [Repository setup](#repository-setup)
before merging the initial implementation.

1. Merge the implementation into `main`. Validation runs, and the publisher skips `0.0.0`
   without reading a previous package manifest or creating any tags or releases.
2. Changesets opens `changeset-release/main` with version `0.1.0`, generated changelog notes,
   and the bundled action. Review and merge that release PR after its required checks pass.
3. The publisher validates the merged release commit, publishes the exact `v0.1.0` release,
   then points `v0` at the same commit. Consumers can use `starslingdev/disks@v0`,
   `starslingdev/disks@v0.1.0`, or the release commit SHA.

The initial `0.1.0` release follows the normal release PR review path; it does not require the
special major-release acknowledgement. Later `0.x` releases advance `v0` only after publication.
The `0.x` series is for early adoption and may include breaking changes; describe migrations
in the changeset. Promotion to `1.0.0` uses a major changeset and the explicit approval below.

## Release sequence

1. A change and its changeset merge to `main`. The `release` workflow runs the same read-only
   validation workflow used by PRs: frozen installation, typecheck, lint, tests, build freshness,
   action smoke tests and metadata/workflow validation.
2. `changesets/action` maintains `changeset-release/main`. `pnpm release:version` consumes
   changesets, updates the package version and changelog, refreshes the lockfile,
   and runs the existing tsdown build. Generated `dist/` is part of the reviewable release PR.
   The GitHub changelog formatter adds PR, commit and contributor links when GitHub can resolve them.
3. Required PR checks and review gate merging that release PR. Before merging a major release,
   a human maintainer must approve its current head with the version-specific acknowledgement below.
   Publication validates the resulting main commit again, then a separate `release` environment job checks out that exact SHA. It does
   not install dependencies or build with publication credentials. It also verifies that tracked
   action metadata and runtime assets still match that exact commit before tagging. Node 24 runs
   `scripts/release.ts` directly using native type stripping; `pnpm release:publish` invokes the same entry point locally.
4. The publisher requires a version transition, the major-release approval when applicable,
   and a merged, same-repository Changesets PR at that SHA. It creates `vX.Y.Z` without force, creates a draft GitHub release from that version's
   changelog section, verifies its identity, then publishes it. The committed action metadata,
   compiled entry point and bundled dependencies are the distribution; no install is needed.
5. Only after successful stable publication does `vX` advance to the same commit. No GitHub
   release is created for `vX`. Exact tags never move. Numeric version ordering, ancestry checks,
   one workflow concurrency lock and a force-with-lease comparison prevent backward/concurrent
   floating updates. A newer exact stable tag reserves its version even if its publication failed.

Changesets' private-package versioning is enabled and its tagging is disabled. We deliberately
omit Changesets' npm publish/tag commands and action publication: workspace tag conventions can
produce `disks@0.1.0`; consumers require `v0.1.0`. The small action-only publisher handles that gap.
Routine main commits with no version transition create no release.

## Explicit major-release approval

For a new major, a human maintainer with repository write, maintain, or admin permission must
submit an **Approve** review on the current release PR head. Include this exact line in the review
body, substituting the version from the release PR's package manifest:

```text
/approve-major-release v1.0.0
```

The publisher checks this before creating tags or releases. Approval must be for the current PR
head and the exact release version. Approvals from bots or the release PR author are rejected;
stale approvals, dismissed approvals, later change requests, and reviewers without write access
cannot satisfy the gate. Major prerelease candidates and their stable graduation also require
approval. Patch and minor releases, including the initial `0.1.0`, use the normal release PR review
path. When promoting to `1.0.0`, review the generated release notes and explicitly approve
`v1.0.0` before merging.

This gate uses GitHub review records and collaborator permissions, so it remains enforced even
if environment reviewers have not been configured. A missing acknowledgement fails publication;
do not merge the major release PR until the required current-head review is present.

## Workflow and job names

| Workflow | File | Jobs shown in GitHub |
|---|---|---|
| `release` | [release.yaml](../.github/workflows/release.yaml) | `validate` (calls `ts`), `release-pr`, `publish` |
| `ts` | [ts.yaml](../.github/workflows/ts.yaml) | `test`, `Validate action.yml and workflows` |
| `CodeQL` | [codeql.yml](../.github/workflows/codeql.yml) | `Analyze`, `Analyze PR` |
| Benchmark • StarSling Disks | [benchmark-storage.yml](../.github/workflows/benchmark-storage.yml) | `Plan`, `Write • <service>`, `Read • <service>`, `Summary` |
| Benchmark Worker • StarSling Disks | [benchmark-storage-cell.yml](../.github/workflows/benchmark-storage-cell.yml) | `<service> • <replica>`, nested under its caller |

GitHub combines reusable job names with their caller, for example
`validate / test` or `Read • starsling / starsling • 1`. Use the check names
from actual runs when configuring branch protection. See the [benchmark guide](../.github/bench/README.md)
for dispatch inputs and summary metrics.

## Repository setup

Release automation publishes only from **`starslingdev/disks`, branch `main`**.
Forks cannot publish through these jobs. Configure the following repository settings
before enabling releases.

- Install a dedicated GitHub App only on `starslingdev/disks`, with **Contents: read/write** and
  **Pull requests: read/write** (Metadata read is implicit). No Actions, Workflows, administration
  or npm permission is needed. The installation token is restricted to this repository and revoked
  after the job. It creates the release PR and signed commits through the GitHub API. Ordinary
  `GITHUB_TOKEN` writes suppress follow-up CI, so they are unsuitable for the release PR.
- Create environment **`release-pr`** and allow only the **`main` branch**, with no tag rules.
  Add environment variable `RELEASE_APP_ID` and environment secret `RELEASE_APP_PRIVATE_KEY`
  containing the App's complete PEM private key. The `release-pr` job references this environment;
  it can access the credentials only after the environment's protection rules pass. Leave required
  reviewers unset to keep release PR creation automatic. These credentials belong in this
  environment, not in repository-level settings or the publication environment.
- Protect `main`: require PRs, review and the `ts` validation checks (`test` and
  `Validate action.yml and workflows`, including their reusable-workflow variants as displayed
  after the first run). Require branches to be current or use a merge queue. Do not exempt the App
  from those rules. Apply your usual CodeQL requirement too.
- Create environment **`release`**, allow only the **`main` branch**, and optionally require
  additional release reviewers. The version-specific major approval above is always required by code.
  This environment is used only by the `publish` job and does not need the App credentials.
  Publication uses only the job's `GITHUB_TOKEN` with Contents write and Pull requests read.
  Keep repository default workflow permissions read-only.
- Enable GitHub **immutable releases** where available. Draft-first publication works with this
  setting: there are no later binary attachments or exact-tag mutations. Protect exact `v*.*.*`
  tags from update/deletion with a ruleset while allowing the publication actor to create them;
  floating `vX` tags must remain movable by that actor. Do not configure a bypass that permits
  routine exact-tag rewrites.
- GitHub Marketplace listing/verification is separate repository-owner setup. This workflow creates
  usable action tags and GitHub releases; it does not enroll the action in Marketplace. If private,
  configure Actions access for consuming repositories.

No release, tag push, or package publication is needed to validate this implementation. The initial
changeset proposes `0.1.0`; review its release notes before merging the first release PR.

## Retry and prerelease operations

Rerun the failed workflow at its original SHA. A manual `release` dispatch is also available on
`main`, but has no arbitrary version/ref input: it releases only if that commit merged the version
PR. If main has advanced, rerun the original run rather than dispatching the newer routine commit.
Do not push tags manually. Retries verify existing exact tags and release SHA, notes and prerelease
status, resume a missing/draft release and finish a missing floating update. Mismatches fail closed;
inspect and resolve their cause rather than overwriting an exact tag. API/auth failures fail rather
than being mistaken for a missing release. A failed newer release cannot be displaced by an older
retry. GitHub's concurrency queue may coalesce pending runs; rerun a skipped release commit if needed.

To start prereleases, merge a maintainer PR running `pnpm changeset pre enter rc`; add normal changesets.
The resulting release PR uses versions like `1.1.0-rc.0`. Those receive exact tags and prerelease GitHub
releases, but never update `vX`. To graduate, merge `pnpm changeset pre exit` in a maintainer PR and
review the stable release PR. Snapshot builds (`--snapshot`) are not published by this pipeline.
Never hand-edit a version to start a release.

## Local validation

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm check:dist`.
The existing release fixtures run through Vitest as part of `pnpm test` and cover numeric ordering,
prereleases, changelog extraction, partial-success retries and identity mismatches. The initial-release
fixture also exercises the license-only parent commit, real Changesets generation of `0.1.0`,
the merged release PR gate, and publication of `v0.1.0` followed by `v0` against a local Git remote.
Only GitHub API calls and release commands are simulated; no remote release is published.
For a release-plan experiment, use a temporary copy, replace the changelog formatter with the default
formatter to avoid GitHub API calls, add one changeset, and run `pnpm changeset status --output plan.json`
then `pnpm changeset version`. Never run a publication command for these experiments.

Verified upstream references: [Changesets action v2.1.2](https://github.com/changesets/action/tree/v2.1.2),
[configuration](https://changesets.dev/guide/config),
[non-npm versioning](https://changesets.dev/guide/beyond-npm),
[App token action](https://github.com/actions/create-github-app-token/tree/v3), and
[GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).
