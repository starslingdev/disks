# Disk lifecycle

[Back to README](../README.md) · [Use cases](use-cases.md)

## One durable copy, private writes

- **One durable copy.** Each disk has a single published state, its current generation, kept by StarSling. Mounts are views of that generation; jobs do not each keep their own durable copy, and there is no sync or merge step.
- **A job reads one fixed generation.** It is fixed for the job at its first mount (pre-job, or this step). Another job publishing meanwhile does not change what a running job sees; the new generation is what the *next* job mounts. Any number of jobs can read the same generation at once.
- **Writes are private to the job.** A read-write mount accepts writes, but no other job can see them. At job end they are discarded — unless the job asked to publish, was the disk's publisher, and succeeded, in which case they become the disk's new generation.
- **One publisher at a time.** Of concurrent jobs asking to publish the same disk, only one can be its publisher; the others report `lease-held` and their writes are discarded. Concurrent writes are never merged. Serialize publishing jobs (for example, one default-branch job per disk) when every job's progress must land.
- **A bounded lifetime.** A published disk persists across jobs and runners until it retires: after a publication over its size cap, after 30 days no step has named it, or when a new name's first publication takes its path. A retired disk mounts empty; the next publication starts again from what that job wrote.

Publication is separate from the mount. A trusted job's writes stay private to that job. A step on the default branch can ask to publish those writes. StarSling publishes them after the job succeeds, so there is no save step. A failed or cancelled job does not publish. A publication that fails leaves the job result alone.

## Before the job

On a trusted job with `id-token: write`, the runner mounts every published disk whose path is under the job user's home, unless the disk was published with `auto-mount: false`. Each mount is read-write. Writes are private to the job and are discarded at job end, so tools use the directory unchanged.

The job log's StarSling group lists one row per disk: name, path, access, and the generation it reads (commit and time of publication), or the reason it did not mount (`storage-unavailable`, `nonempty-target`, `disabled`, and others).

> [!IMPORTANT]
> Disks under the workspace, and disks published with `auto-mount: false`, always need this step. While the job is still being verified before its steps run, home-directory disks need the step for reads too; the job log says so in that case.

A fork pull request, a Dependabot pull request, or an event outside the read allow-list gets no mount (`untrusted`). A job that does not grant `id-token: write` gets no mount (`missing-oidc`). The job then runs cold.

## This step

The step activates one disk, by name.

- **First use of a name.** The name mounts an empty directory (`mount` is `cold`), and the first successful publication creates the disk. Nothing is registered ahead of time.
- **Already mounted at pre-job.** The step attaches a publish intent to that mount. Everything already written to it, by earlier steps too, counts toward the publication. Asking for `read-only` or a different path than the mount fails with `conflicting-repeat`.
- **Not mounted yet.** The step asks the runner to mount it at the step's `path`, else the stored path, else the preset's path, else `~/.disks/<name>`.

Invalid inputs fail the step with `invalid-input`, regardless of `on-degraded`. This includes `read-only` combined with publishing, an invalid input choice, or a path that cannot be resolved.

## Publish modes

Set `publish` on the step that should keep its writes. All publication modes require a successful job.

| `publish` | When a generation is published |
|---|---|
| `never` (or omitted) | Never. The job can still write to a read-write mount, but those writes are discarded at job end. |
| `on-change` | The change test finds a change, or the step's settings differ from the stored ones. |
| `always` | Even when nothing changed. |
| `if-missing` | Only when no usable generation exists. On a usable generation the status is `not-needed`. |

Of several concurrent jobs asking to publish the same disk, only one can publish. The others report `publish-status=lease-held`, keep their private writes for the job, and discard them at job end. With `on-degraded: fail`, `lease-held` fails the step: the disk mounted, but the activation is degraded.

Same-repository pull requests, and jobs on other branches or tags, read at pre-job and discard their writes. Their `publish-status` is `not-requested`.

## Job end

StarSling publishes eligible writes after the job succeeds. Failed or cancelled jobs leave the published generation unchanged. Writes that do not publish are discarded. Publication runs outside the job, so a publication failure does not change the job result.

The action reports only what is known when the step finishes. `publish-status: pending` means publication may happen; `generation` identifies the state the job read. Neither output confirms a later publication. Repeated activations append their own logs and summaries.

A disk retires after a publication exceeds its size cap, after 30 days without a step naming it, or when another name is published at its path. Rewriting files can grow a disk toward its cap. A retired disk mounts empty.

## Changing a disk

- **Move it.** Use a new name. The old one retires after 30 days unused. Publishing a `path` that differs from the stored path reports `settings-mismatch`.
- **Change the size cap, the change test, or `auto-mount`.** Publish again. The new settings apply on the next successful publication.
- **Rename it at the same path.** Publish the old name with `auto-mount: false`, then publish the new name at that path. The new name's first successful publication retires the old disk.
- **Mount it somewhere else for one job.** A step that does not publish may pass its own `path`, for a disk the runner has not already mounted.
