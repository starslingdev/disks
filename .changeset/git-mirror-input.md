---
"disks": minor
---

Add the `git-mirror` input. `git-mirror: true` lets StarSling keep a one-commit copy of the repository's default branch and copy it into the job's workspace before a plain `actions/checkout`, so checkout downloads only what changed. It is off unless a job asks, and can be a step's only input.
