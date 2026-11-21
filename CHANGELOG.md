# Changelog

## 0.2.0

### Minor Changes

- [#10](https://github.com/starslingdev/disks/pull/10) [`b6d6745`](https://github.com/starslingdev/disks/commit/b6d674572eb1356d974c9d3bfea669dae4fd870a) Thanks [@cosmic-emerald](https://github.com/cosmic-emerald)! - Add the `git-mirror` input. `git-mirror: true` lets StarSling keep a one-commit copy of the repository's default branch and copy it into the job's workspace before a plain `actions/checkout`, so checkout downloads only what changed. It is off unless a job asks, and can be a step's only input.

## 0.1.0

### Minor Changes

- [#1](https://github.com/starslingdev/disks/pull/1) [`8bd3e1d`](https://github.com/starslingdev/disks/commit/8bd3e1d86bb834e2a3ed329dec415268bbf1f7f4) Thanks [@dbworku](https://github.com/dbworku)! - Publish the initial 0.1.0 release of StarSling Disks as a bundled GitHub Action with Changesets-managed release notes and immutable exact version tags.
  
  Use `starslingdev/disks@v0` (or an exact `v0.1.0` tag/SHA) to mount persistent directories on StarSling Runners. Configure disks with `name`, `preset`, `auto-mount`, and `on-degraded: continue|fail`. Outputs report the disk name, mount state (`warm`, `cold`, or `none`), generation, and publication status. A `pending` publication completes only after a successful job; there is no post step. See the README for inputs, outputs, and examples.
