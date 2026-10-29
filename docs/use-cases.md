# Use cases

[Back to README](../README.md) · [Disk lifecycle](lifecycle.md)

## Disks and archive caches

GitHub's [`actions/cache`](https://github.com/actions/cache) stores a tar archive: the job packs the directory, uploads it, and a later job downloads and extracts it. That cost grows with the archive. A pnpm store or a Cargo registry is exactly that shape, and the archive is often the slow part of the job. StarSling Disks skip the archive: the mounted directory itself is the persistent state.

| | `actions/cache` | StarSling Disks |
|---|---|---|
| How the files arrive | Pack, upload, download, extract | Mount the directory in place |
| When they are usable | After the restore step finishes | At pre-job for a home-directory disk, or when this step finishes |
| How writes are kept | A later step uploads a new archive | The job writes the mount; publication runs after a successful job |
| What you configure | An explicit `path` and a `key` | A preset, or a name plus a path |

## Presets

A preset mounts a tool's own default directory, so the tool needs no setting. Its path, size cap and change test come from the StarSling API ([`GET /api/disks/presets`](https://runners.starsling.dev/openapi#tag/disks)). `name` defaults to the preset's name; set it to use a different disk.

```yaml
- uses: starslingdev/disks@v1
  with:
    preset: pnpm-store # or cargo
    publish: on-change
```

Keep each tool on its default location, or the mount lands on a directory the tool no longer uses:

- **pnpm:** leave `PNPM_HOME` and `XDG_DATA_HOME` unset, and pass no `--store-dir`. Keep `pnpm install` in the workflow: the disk supplies the store, while pnpm links dependencies into the project.
- **Cargo:** leave `CARGO_HOME` unset. The preset mounts the registry, not all of `~/.cargo`, which holds rustup's binaries on StarSling Runners. Git dependencies take a second step with their own `name`, and build output (`target/`) is a workspace path, mounted with `path`.

## Publish from the default branch only

Pull requests read the disk and discard what they write. Only the default-branch job asks to publish. One expression covers both:

```yaml
- uses: starslingdev/disks@v1
  with:
    preset: pnpm-store
    publish: ${{ github.ref == 'refs/heads/main' && 'on-change' || 'never' }}
```

A step with `publish` omitted, or set to `never`, does not publish. A read-write mount still accepts private writes, which are discarded at job end. On a same-repository pull request any other value is not allowed to publish (`publish-status` `denied`, reason `not-publisher`); the disk still mounts.

## A disk with only a name

A step that gives neither `path` nor `preset` mounts the disk at `~/.disks/<name>`. A disk that already has a stored path keeps it.

```yaml
- uses: starslingdev/disks@v1
  id: models
  with:
    name: models
    publish: ${{ github.ref == 'refs/heads/main' && 'on-change' || 'never' }}

- run: ./download-models --into "$MODELS_DIR"
  env:
    MODELS_DIR: ${{ steps.models.outputs.path }}
```

`~/.disks/<name>` is under the job user's home, so once published the disk is auto-mounted in later jobs, before their steps. Publish it with `auto-mount: false` to mount it only in steps that ask.

## A path inside the workspace

A disk under the workspace is not mounted at pre-job, because checkout owns that tree. Every job runs the step, after checkout and before the tool. Build output is the usual case:

```yaml
- uses: actions/checkout@v4

- uses: starslingdev/disks@v1
  with:
    name: rust-target
    path: target
    publish: ${{ github.ref == 'refs/heads/main' && 'on-change' || 'never' }}

- run: cargo test --locked
```

`path: target` resolves under `GITHUB_WORKSPACE`. A leading `~` resolves under the job user's home (`~/fixtures`). `~user` is rejected.

## Read-only reference data

Reference data, fixtures, and other inputs a job must not rewrite. `read-only` is only valid with `publish: never`. `on-degraded: fail` fails when storage or access is unavailable. A first or retired disk can still mount cold without degradation; if published data is required, also require the step's `mount` output to be `warm`. With no `path` and no preset, the disk is at `~/.disks/reference-data`.

```yaml
- uses: starslingdev/disks@v1
  with:
    name: reference-data
    access: read-only
    on-degraded: fail
```

With `on-degraded: continue`, an unavailable read-only disk leaves the ordinary directory in place, and that directory may be writable. Read the step's `path` output when the tool has to be told where the disk is.
