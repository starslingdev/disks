<div align="center">

# Disks
High-performance persistent storage for GitHub Actions.

</div>

[Disks](#what-are-starsling-disks) are persistent filesystems mounted into [Runners](https://starsling.dev/products/runners). They let concurrent jobs reuse build caches, datasets, and artifacts through ordinary directories.

> [!NOTE]
> Examples target `v0`, starting with `v0.1.0`. Until that release is published, use a commit SHA. The `0.x` series is for early adoption and may include breaking changes. Pin a commit SHA for production workflows ([Releases](#releases)).

## Quickstart

The example uses the `starsling-ubuntu-26.04-4` runner label. Replace it with another label from your StarSling Runners configuration if needed. The workflow below publishes the pnpm store from the default branch. Every other job on an enrolled runner mounts it before the steps run and installs against a warm store.

```yaml
jobs:
  build:
    runs-on: starsling-ubuntu-26.04-4
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4

      - uses: starslingdev/disks@v0
        with:
          preset: pnpm-store
          publish: ${{ github.ref == 'refs/heads/main' && 'on-change' || 'never' }}

      - run: pnpm install --frozen-lockfile
```

The step goes before anything writes the store. When `pnpm install` runs, the mount supplies the store, and pnpm still links the project.

## Performance comparison

| | GitHub `actions/cache` | StarSling Disks |
|---|---|---|
| Time to access stored files | Download and extract the cache archive | Mount the published disk |
| Dependency preparation | Install from the restored store | Install directly from the mounted store |
| Download speed | Reported by the cache restore action | Not applicable; no archive download |

The [pnpm store benchmark](.github/bench/README.md) compares **Time to Access** and **Dependencies ready** on a frozen Mastra revision. Its summary reports measured durations, cache download speed, and time saved for that run. Dependencies ready includes storage access, pnpm setup, and dependency installation. Results depend on the store, runner hardware, and workload.

StarSling Disks let jobs read and write data directly, eliminating the time spent packing, uploading, downloading, and extracting cache archives.

## What are StarSling Disks?

A disk is a directory a job reads and writes in place: there is no archive to pack, upload, download or extract. A dependency store is one use; build output, toolchains, datasets and working directories that fan out to later jobs are others.

Each disk has a name, scoped to its repository, and a job can mount several; this step activates one. Every job reads one fixed published generation and writes privately. After a successful default-branch job, StarSling publishes its writes, one publisher at a time; failed jobs discard theirs. See the [glossary](CONTEXT.md) for terminology.

## Prerequisites

1. **StarSling Runners.** Use a runner label from your StarSling Runners configuration. GitHub-hosted runners have no disk to mount; the step skips there ([Limits of this action](#limits-of-this-action)).
2. **An org enrolled for StarSling Disks.** Enrollment is what makes Disks available on the org's runners. An unenrolled org skips the same way.

## Guides

- [Use cases](docs/use-cases.md): dependency stores, build output, and read-only reference data.
- [Disk lifecycle](docs/lifecycle.md): mounts, private writes, publication, and retirement.
- [Error codes and failures](docs/errors-and-failures.md): reason codes, failure behavior, and diagnostic logs.

## Presets and limits

For available presets, their paths, size caps, change tests, and disk limits, see [`GET /api/disks/presets`](https://runners.starsling.dev/openapi#tag/disks). [`GET /api/disks`](https://runners.starsling.dev/openapi#tag/disks) lists an org's disks with their stored settings. StarSling validates preset names when the disk is activated.

## Inputs

| Input | Values | Description |
|---|---|---|
| `name` | disk name | The disk, by name. Defaults to the preset's name; required without a preset. A name with no disk yet mounts empty. Lower-case letters, digits and dashes, starting with a letter, at most 63 characters. |
| `path` | path | Target directory. `~/…` is under the job user's home, a relative path is under the workspace. Defaults to the disk's stored path, then the preset's, then `~/.disks/<name>`, so a published disk never moves. |
| `preset` | a [preset](#presets-and-limits) | Supplies the path, size cap and change test. |
| `size-cap` | for example `20GB` | Cap on the disk's size; a publication past it retires the disk. Defaults to the preset's, then the [default](#presets-and-limits). |
| `auto-mount` | `true`, `false` | Whether the runner mounts the disk before the job's steps. Defaults to `true`. |
| `access` | `read-write`, `read-only` | `read-write` (default) is a private writable view, discarded at job end. `read-only` requires `publish: never`. |
| `publish` | `never`, `on-change`, `always`, `if-missing` | Publication intent. Defaults to `never`. See [publish modes](docs/lifecycle.md#publish-modes). |
| `on-degraded` | `continue`, `fail` | What a degradation does (see [Error codes and failures](docs/errors-and-failures.md)). `continue` (default) carries on without the disk, or without its publication; `fail` fails the step. |

`size-cap` and `auto-mount`, like the preset's change test, are the disk's settings: each successful default-branch publication stores its step's, so an omitted one returns to its default.

## Outputs

| Output | Meaning |
|---|---|
| `name` | The disk's name: the `name` input, else the preset's. |
| `path` | The absolute target, once resolved. Empty when the step gave no `path` and ended before StarSling answered. |
| `access` | `read-write` or `read-only` as mounted; a repeat reports the existing mount's. Empty when unmounted. |
| `mount` | `warm` (over a published generation), `cold` (mounted empty: a first or retired disk) or `none`. |
| `generation` | The generation this job read. Empty unless `mount` is `warm`. |
| `publish-status` | `not-requested`, `not-needed`, `pending`, `denied`, `lease-held` or `unavailable`. `pending` means the writes may publish after the job succeeds, not that they did. |
| `reason` | A [reason code](docs/errors-and-failures.md), else empty. Step-time only: it never reports the post-job publication. |

## Limits of this action

Docker's data root, a workspace root as the mount and container jobs are out of scope. On a GitHub-hosted runner the step is a no-op that writes every output; `on-degraded: fail` makes it fail instead.

## Releases

`dist/index.js` is committed on `main` and checked fresh by CI, so every commit SHA, branch and tag is runnable. `vX.Y.Z` tags never move; the major tag (`v0`) moves forward to the latest non-prerelease version in that major, after publication succeeds. Prefer a commit SHA:

```yaml
- uses: starslingdev/disks@<full-sha> # v0.1.0
```

Contributors add Changesets; automation opens a release PR with version bumps, generated changelog entries and the compiled action. Merging that PR with required checks passing publishes `vX.Y.Z` and advances `vX`. See [the release guide](docs/releases.md) for setup, retries and prereleases.
