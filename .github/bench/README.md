# Benchmark • StarSling Disks • pnpm store (mastra)

Select **Benchmark • StarSling Disks** in Actions and dispatch. The `starsling-runner` dispatch input defaults to `starsling-ubuntu-26.04-4`; no repository variable is required. Override the input to use another registered 4-CPU Ubuntu 26.04 StarSling runner label. If the input is cleared, the same default label is used. GitHub benchmarks use `ubuntu-26.04`, which provides [4 vCPUs for public repositories](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories). Planning rejects blank or multiline labels before starting any benchmark jobs; it does not check runner registration or availability. The validated label is passed explicitly to the reusable workflow. Disks must be enabled for the organization. No additional secrets are required; the local action uses job OIDC.

Every StarSling writer and reader invokes the repository action through `uses: ./`, using `action.yml` and the committed `dist/index.js` from the dispatched commit. Mounting and publication requests use real job OIDC and the installed runner helper. The measurement script records action outputs and timings; it does not mount disks.

One writer per service, starting with an empty store, populates a pnpm store from the same frozen Mastra revision. Five warm jobs per service then restore the GitHub cache or mount the StarSling disk and run pnpm setup and an offline dependency install directly against that store. Readers use private writable disk mounts with `publish: never`, allowing pnpm to update its store index without changing the published generation. No full-store hashing or copy runs before the install.

Default-branch runs publish a new StarSling store. Feature-branch validation reuses the latest successful default-branch writer's disk and Mastra revision, while GitHub uses the branch run's new cache. The Mastra ref input applies to default-branch runs; branch runs use the seed revision. The source revision and disk key appear in the summary. Branch writers exercise a cold private mount without publishing. Jobs render as `Write • starsling / starsling • 0` or `Read • github / github • 1`. Summary matching includes the parent stage so writers and readers remain distinct. The `Plan` and `Summary` jobs appear without a benchmark prefix. Seed discovery accepts legacy writer job names solely to find stores published by older default-branch runs.

Manual dispatch is allowed only in `starslingdev/disks`. Forks and PR events are rejected before allocating a runner. Publication is requested only on the default branch.

## Summary

The headline reports the ratio and time saved for **Dependencies ready** only when all twelve jobs have complete measurements, matching source revisions, and successful setup/install steps. Slower runs say so; incomplete runs make no speedup claim and fail the summary job.

The main table compares the two services' warm jobs:

- **Time to Access:** monotonic time from immediately before restore/mount until the manifest is validated and one payload byte is readable. GitHub includes archive download and extraction; StarSling includes mount activation. This is availability, not network time to first byte.
- **Average Download Speed:** the final cumulative `Received … (100.0%), … MBs/sec` average from each successful `actions/cache/restore` job log, followed by the median of those averages. The action divides bytes by 1024² (MiB/s) but labels it MBs/sec; the summary preserves the familiar MB/s label and explains the units. Partial transfers are excluded. Missing logs produce N/A or reduced log coverage, never a fabricated rate. StarSling is N/A because it mounts rather than downloads an archive.
- **Dependencies ready:** Time to Access plus the successful `Setup pnpm` and `Install Mastra dependencies` step durations, summed per job before taking the median. Actions step timestamps have one-second resolution. Excludes checkout, Node setup, queueing and benchmark bookkeeping; it is not complete workflow or build time.
- **Store size:** logical uncompressed package bytes from writer metadata, excluding symlinks and pnpm's machine-local project registry. Legacy seeds retain their original inventory counts.

**Every step** expands into separate warm-reader and cold-writer tables with GitHub and StarSling side by side for each step. Each cell includes successful sample coverage. Zero-second steps have no ratio; a dash means a step does not apply or did not succeed. Raw measurements and runner metadata remain in a separate collapsed section and per-job artifacts.

## Workload and limits

Both services use the same Node/pnpm versions, frozen Mastra revision, and install flags. Lifecycle scripts are disabled to measure dependency preparation rather than project builds. The global virtual store is disabled so workspace links remain inside each checkout. `--trust-lockfile` skips pnpm 11 registry policy revalidation outside the cached store; package integrity verification remains enabled. Readers use `--offline` and identical copy imports into `node_modules`.

Writer inventory runs after the writer install and reads file metadata only. pnpm validates the packages it consumes during the actual install. Cache misses, cold reader disks, revision mismatches, unexpected access/publication status and failed offline installs fail the run. Disk publication happens after a successful default-branch writer, outside the measured steps. Warm readers require `mount: warm`, record the reported generation, validate the manifest revision, and then install directly from that store.

No privileged cache flushing is performed. Archive extraction warms GitHub's page cache; disk content can be loaded lazily during installation. Concurrent readers may contend for storage. Results depend on runner hardware, image and revision and must not be presented as a fixed product-wide speedup. Keys include run ID and attempt; disks persist and may be retired through the normal disk lifecycle controls.

## Runner access boundary

Restrict the StarSling runner group to an explicit repository allowlist with public-repository access disabled at the group level. Enforce access in GitHub/StarSling runner settings as well as workflow guards: a fork can edit its own YAML. PR validation uses only GitHub-hosted runners and receives no release credentials.

The pinned JavaScript actions require Node 24-capable Actions runners (at least v2.327.1). Update the StarSling runner image before dispatch. Artifact archives are enabled and downloads fail on digest mismatches. Summary log retrieval uses only the injected GitHub client with `actions: read`.
