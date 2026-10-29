// Publish only a validated, merged Changesets PR. No npm or package-prefixed tags.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const REPO = 'starslingdev/disks'
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/

interface Manifest {
  name: string
  private: boolean
  version: string
}

interface PullRequest {
  number: number
  user: { login: string }
  merged_at: string | null
  merge_commit_sha: string | null
  head: { sha: string; ref: string; repo: { full_name: string } | null }
  base: { ref: string }
}

export interface Release {
  tag_name: string
  target_commitish: string
  body: string
  prerelease: boolean
  draft: boolean
}

export interface ReleaseIO {
  run: (...args: string[]) => string
  git: (...args: string[]) => string
  api: (path: string) => unknown
  read: (path: string) => string
  write: (path: string, content: string) => void
  exists: (path: string) => boolean
}

const run = (command: string, ...args: string[]): string => execFileSync(command, args, { encoding: 'utf8' }).trim()
const defaultIO: ReleaseIO = {
  run: (command, ...args) => run(command, ...args),
  git: (...args) => run('git', ...args),
  api: (path) => {
    const result = spawnSync('gh', ['api', `repos/${REPO}/${path}`], { encoding: 'utf8' })
    if (result.error) throw result.error
    if (result.status !== 0) {
      if (result.stderr.includes('(HTTP 404)')) return null
      throw new Error(result.stderr || `GitHub API exited with status ${result.status}`)
    }
    return JSON.parse(result.stdout) as unknown
  },
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, content) => writeFileSync(path, content),
  exists: existsSync,
}

export function versionParts(version: string) {
  const match = VERSION.exec(version)
  if (!match) throw new Error(`Unsupported release version: ${version}`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] }
}

type Version = ReturnType<typeof versionParts>
const compare = (a: Version, b: Version): number => a.major - b.major || a.minor - b.minor || a.patch - b.patch

export function releaseNotes(changelog: string, version: string): string {
  const sections = changelog.split(/^## /m)
  const section = sections.find((entry) => entry.split('\n', 1)[0]?.trim() === version)
  const notes = section?.split('\n').slice(1).join('\n').trim()
  if (!notes) throw new Error(`Missing Changesets changelog entry for ${version}`)
  return notes
}

// Exact stable tags reserve ordering even if a newer publication is incomplete.
export function shouldAdvance(version: string, versions: string[]): boolean {
  const candidate = versionParts(version)
  return (
    !candidate.prerelease &&
    !versions.some((other) => {
      const existing = versionParts(other)
      return !existing.prerelease && existing.major === candidate.major && compare(existing, candidate) > 0
    })
  )
}

export function verifyRelease(release: Release, tag: string, sha: string, notes: string, prerelease: boolean): void {
  if (
    release.tag_name !== tag ||
    release.target_commitish !== sha ||
    release.body.trim() !== notes ||
    release.prerelease !== prerelease
  ) {
    throw new Error(`Existing release identity/notes mismatch for ${tag}`)
  }
}

interface Review {
  id: number
  state: string
  commit_id: string
  body: string | null
  user: { login: string; type: string } | null
}

// A version-specific approval must come from a human maintainer reviewing the current PR head.
export function requireMajorApproval(io: ReleaseIO, pr: PullRequest, version: string): void {
  const reviews: Review[] = []
  for (let page = 1; ; page += 1) {
    const batch = io.api(`pulls/${pr.number}/reviews?per_page=100&page=${page}`) as Review[] | null
    if (!batch) throw new Error('Cannot read major-release approvals')
    reviews.push(...batch)
    if (batch.length < 100) break
  }
  const latest = new Map<string, Review>()
  for (const review of reviews.sort((a, b) => a.id - b.id)) {
    if (review.user && review.state !== 'COMMENTED' && review.state !== 'PENDING') {
      latest.set(review.user.login.toLowerCase(), review)
    }
  }
  const acknowledgement = `/approve-major-release v${version}`
  for (const review of latest.values()) {
    const user = review.user
    if (user?.type !== 'User' || user.login.toLowerCase() === pr.user.login.toLowerCase()) continue
    if (review.state !== 'APPROVED' || !pr.head.sha || review.commit_id !== pr.head.sha) continue
    if (!review.body?.split(/\r?\n/).some((line) => line.trim() === acknowledgement)) continue
    const collaborator = io.api(`collaborators/${encodeURIComponent(user.login)}/permission`) as {
      permission: string
    } | null
    if (collaborator && ['write', 'maintain', 'admin'].includes(collaborator.permission)) {
      console.log(`Major release v${version} approved by ${user.login} at ${pr.head.sha}.`)
      return
    }
  }
  throw new Error(
    `Major release requires a current-head human maintainer APPROVE review containing: ${acknowledgement}`,
  )
}

export function publish(io: ReleaseIO = defaultIO, env: NodeJS.ProcessEnv = process.env): void {
  const { git, run: command } = io
  if (env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Publication is restricted to starslingdev/disks main')
  }
  const sha = git('rev-parse', 'HEAD')
  if (sha !== env.RELEASE_SHA) throw new Error('Checkout differs from validated commit')
  const manifest = JSON.parse(io.read('package.json')) as Manifest
  if (manifest.name !== 'disks' || manifest.private !== true) throw new Error('Expected private action package disks')
  const { version } = manifest
  const candidate = versionParts(version)
  const prerelease = Boolean(candidate.prerelease)
  // A routine main commit never becomes a release, even if a previous release is absent.
  const previous = JSON.parse(git('show', 'HEAD^1:package.json')) as Manifest
  if (previous.version === version) {
    console.log('No version transition; nothing to publish.')
    return
  }
  const prs = io.api(`commits/${sha}/pulls?per_page=100`) as PullRequest[] | null
  const releasePr = prs?.find(
    (pr) =>
      pr.merged_at &&
      pr.merge_commit_sha === sha &&
      pr.head.ref === 'changeset-release/main' &&
      pr.head.repo?.full_name === REPO &&
      pr.base.ref === 'main',
  )
  if (!releasePr) throw new Error('Version transition must merge the Changesets release PR')
  const previousVersion = versionParts(previous.version)
  // Until a stable major is published, every candidate and its graduation need approval.
  const firstStableMajor = candidate.major > 0 && !git('tag', '--list', `v${candidate.major}`)
  if (
    firstStableMajor ||
    candidate.major > previousVersion.major ||
    (candidate.major > 0 && candidate.minor === 0 && candidate.patch === 0)
  ) {
    requireMajorApproval(io, releasePr, version)
  }
  const notes = releaseNotes(io.read('CHANGELOG.md'), version)
  if (!io.exists('action.yml') || !io.exists('dist/index.js')) throw new Error('Missing action runtime files')
  // Publication must use the tracked action bytes that passed build freshness and smoke checks.
  git('ls-files', '--error-unmatch', 'action.yml', 'dist/index.js')
  git('diff', '--exit-code', 'HEAD', '--', 'action.yml', 'dist')
  if (git('status', '--porcelain', '--untracked-files=all', '--', 'action.yml', 'dist')) {
    throw new Error('Action runtime tree differs from the validated commit')
  }
  const tag = `v${version}`
  // GitHub CLI's credential helper uses GH_TOKEN without persisting it in the checkout.
  command('gh', 'auth', 'setup-git', '--hostname', 'github.com')
  // Never force-update local exact tags. A conflicting local tag fails closed.
  git('fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main', '--tags')
  git('merge-base', '--is-ancestor', sha, 'origin/main')
  const tags = git('tag', '--list').split('\n').filter(Boolean)
  if (tags.includes(tag) && git('rev-parse', `${tag}^{commit}`) !== sha) {
    throw new Error(`Exact tag ${tag} already belongs to another commit`)
  }
  const getRelease = (): Release | null => io.api(`releases/tags/${tag}`) as Release | null
  let release = getRelease()
  if (release) {
    verifyRelease(release, tag, sha, notes, prerelease)
    if (!tags.includes(tag)) throw new Error('Release exists without its expected tag')
  }
  if (!tags.includes(tag)) {
    git('tag', tag, sha)
    git('push', 'origin', `refs/tags/${tag}`) // no force, ever
  }
  if (!release) {
    if (!env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is required')
    const notesPath = join(env.RUNNER_TEMP, 'disks-release-notes.md')
    io.write(notesPath, `${notes}\n`)
    const args = [
      'gh',
      'release',
      'create',
      tag,
      '--repo',
      REPO,
      '--verify-tag',
      '--target',
      sha,
      '--title',
      tag,
      '--notes-file',
      notesPath,
      '--draft',
    ]
    if (prerelease) args.push('--prerelease')
    command(...args)
    release = getRelease()
    if (!release) throw new Error('New draft release not found')
    verifyRelease(release, tag, sha, notes, prerelease)
  }
  if (release.draft) command('gh', 'release', 'edit', tag, '--repo', REPO, '--draft=false', '--latest=false')
  const published = getRelease()
  if (!published || published.draft) throw new Error('Release publication did not complete')
  verifyRelease(published, tag, sha, notes, prerelease)
  const versions = tags
    .filter((entry) => entry.startsWith('v') && VERSION.test(entry.slice(1)))
    .map((entry) => entry.slice(1))
  if (!shouldAdvance(version, versions)) {
    console.log('Published; leaving floating tag unchanged for prerelease/older release.')
    return
  }
  const major = `v${candidate.major}`
  const oldOid = tags.includes(major) ? git('rev-parse', `refs/tags/${major}`) : ''
  if (oldOid) {
    const oldSha = git('rev-parse', `${major}^{commit}`)
    const oldVersion = (JSON.parse(git('show', `${oldSha}:package.json`)) as Manifest).version
    const old = versionParts(oldVersion)
    if (old.prerelease || old.major !== candidate.major) {
      throw new Error('Floating tag does not identify a stable release in this major')
    }
    if (compare(old, candidate) > 0) return
    if (git('rev-parse', `v${oldVersion}^{commit}`) !== oldSha) {
      throw new Error('Floating tag does not match its exact tag')
    }
    git('merge-base', '--is-ancestor', oldSha, sha)
  }
  // Compare-and-swap prevents concurrent writers, including outside this workflow.
  git('push', `--force-with-lease=refs/tags/${major}:${oldOid}`, 'origin', `${sha}:refs/tags/${major}`)
  console.log(`Published ${tag}; ${major} now points to ${sha}.`)
}

if (import.meta.main) publish()
