# Disks glossary

Terms used in the action's inputs, outputs, and guides.

| Term | Meaning |
|---|---|
| StarSling Disks | Persistent directories shared across jobs on StarSling Runners. Each disk belongs to one repository. |
| Disk name | A disk's identity within its repository. Defaults to the preset name. A new name identifies a separate disk. |
| Activation | A step's request to mount one disk with the requested access and publication settings. |
| Generation | A disk's published state. A job reads the generation selected at its first mount; later publications do not change that view. |
| Mount state | `warm`: mounted over a published generation; `cold`: mounted empty; `none`: no mount. A cold mount is not a failure. |
| Auto-mount | Mounting a published home-directory disk before job steps run. Workspace disks require an action step. |
| Publication | Keeping a job's private writes as the disk's next generation after the job succeeds. Failed or cancelled jobs do not publish. |
| Pending publication | Writes that may publish after a successful job. The step's `pending` status does not confirm publication. |
| Reason code | A stable value explaining why an activation failed or was degraded. Empty when the activation received everything requested. |
| Failure | An invalid or conflicting request that always fails the step. |
| Degradation | Unavailable storage or access, or a mount without the requested publication. Fails the step only with `on-degraded: fail`. |

See [Disk lifecycle](docs/lifecycle.md) for publication rules and
[Error codes and failures](docs/errors-and-failures.md) for reason codes.
