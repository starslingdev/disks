---
"disks": minor
---

Publish the initial 0.1.0 release of StarSling Disks as a bundled GitHub Action with Changesets-managed release notes and immutable exact version tags.

Use `starslingdev/disks@v0` (or an exact `v0.1.0` tag/SHA) to mount persistent directories on StarSling Runners. Configure disks with `name`, `preset`, `auto-mount`, and `on-degraded: continue|fail`. Outputs report the disk name, mount state (`warm`, `cold`, or `none`), generation, and publication status. A `pending` publication completes only after a successful job; there is no post step. See the README for inputs, outputs, and examples.
