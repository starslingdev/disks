# Changelog

## 0.1.0 (unreleased)

Initial release of the StarSling Disks action.

- Mount persistent directories by name or tool preset on StarSling Runners.
- Use private read-write mounts or read-only access to published data.
- Request publication after a successful default-branch job with `on-change`, `always`, or `if-missing`.
- Report mount state, generation, publication status, and reason codes through step outputs, logs, and the job summary.
- Choose whether degraded activations continue or fail with `on-degraded`.
- Authenticate requests with GitHub OIDC using the `starsling-disks` audience.
