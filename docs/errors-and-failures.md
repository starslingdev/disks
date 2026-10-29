# Error codes and failures

[Back to README](../README.md) · [Disk lifecycle](lifecycle.md)

A **failure** is the step's own fault and always fails the step. A **degradation** fails it only under `on-degraded: fail`.

| `reason` | Kind | What happened | Next |
|---|---|---|---|
| `invalid-input` | failure | An input is outside the [input values](../README.md#inputs), the path does not resolve, or `read-only` was combined with publishing. | Fix the input. |
| `unsafe-path` | failure | The target is outside the job home and workspace, or overlaps another disk. | Choose another path. |
| `nonempty-target` | failure | The target already contains files. | Choose an empty target, or run the step before the tool writes. |
| `conflicting-repeat` | failure | A second step for the same disk asked for another path or access. | Make the steps agree. |
| `cleanup-failed` | failure | A mount that did not complete could not be undone. | Contact support. |
| `unsupported-runner` | degradation | The runner has no StarSling Disks. | Use a StarSling Runner on an enrolled org. |
| `missing-oidc` | degradation | The job has no `id-token: write`, or the token request failed. | Grant `id-token: write`. |
| `untrusted`, `unproven-job` | degradation | StarSling will not mount for this job (a fork, for example), or could not prove it. | |
| `disabled` | degradation | StarSling disabled the disk. | Contact support. |
| `not-publisher`, `settings-mismatch`, `over-limit`, `lease-held`, `parent-moved` | degradation | Mounted, but this job's writes will not publish (see [lifecycle](lifecycle.md)). | |
| `deadline-exceeded`, `unexpected`, `storage-unavailable`, `job-ended` | degradation | Activation timed out, failed unexpectedly, found storage unavailable, or the job ended first. | Retry; contact support if it repeats. |
| `root-timeout`, `sudo-denied`, `root-exit`, `root-parse` | degradation | The runner's helper did not answer within 65 seconds, `sudo -n` refused it, it exited non-zero, or its answer was unreadable. | Retry; share the `disks root side` log group with support. |
| `action-error` | degradation | This action threw. | Share the `disks error` log group with support. |

The log says `disk <name>: mounted warm`, `mounted cold` or `not mounted (<reason>)`, then the publish outcome, and the job summary repeats both. The `disks root side` log group has the runner's stderr and timings; stdout is never logged, since it can echo the job token.
