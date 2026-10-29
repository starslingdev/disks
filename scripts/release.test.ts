// Existing offline ordering, identity, notes and publication retry fixtures.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  publish,
  REPO,
  type Release,
  type ReleaseIO,
  releaseNotes,
  shouldAdvance,
  verifyRelease,
  versionParts,
} from './release.ts'

const env = { GITHUB_REPOSITORY: REPO, GITHUB_REF: 'refs/heads/main', RELEASE_SHA: 'abc', RUNNER_TEMP: tmpdir() }
const manifest = JSON.stringify({ name: 'disks', private: true, version: '1.0.0' })
const record: Release = { tag_name: 'v1.0.0', target_commitish: 'abc', body: 'Notes', prerelease: false, draft: false }

function exercise(existingTag: boolean, existingRelease: boolean, draft: boolean, mismatch = false): void {
  let lookups = 0
  const git = vi.fn((...args: string[]): string => {
    switch (args.join(' ')) {
      case 'rev-parse HEAD':
        return 'abc'
      case 'show HEAD^1:package.json':
        return '{"version":"0.1.0"}'
      case 'tag --list':
        return existingTag ? 'v1.0.0' : ''
      case 'rev-parse v1.0.0^{commit}':
        return mismatch ? 'wrong' : 'abc'
      default:
        return ''
    }
  })
  const command = vi.fn(() => '')
  const io: ReleaseIO = {
    git,
    run: command,
    api: (path) => {
      if (path.startsWith('pulls/'))
        return [
          {
            id: 1,
            state: 'APPROVED',
            commit_id: 'release-head',
            user: { login: 'maintainer', type: 'User' },
            body: '/approve-major-release v1.0.0',
          },
        ]
      if (path.startsWith('collaborators/')) return { permission: 'maintain' }
      if (path.startsWith('commits/'))
        return [
          {
            number: 42,
            user: { login: 'release-bot' },
            merged_at: 'today',
            merge_commit_sha: 'abc',
            head: { sha: 'release-head', ref: 'changeset-release/main', repo: { full_name: REPO } },
            base: { ref: 'main' },
          },
        ]
      lookups += 1
      if (lookups === 1 && !existingRelease) return null
      return { ...record, draft: lookups === 1 ? draft : false }
    },
    read: (path) => (path === 'package.json' ? manifest : '## 1.0.0\n\nNotes\n'),
    write: vi.fn(),
    exists: () => true,
  }
  publish(io, env)
  expect(git.mock.calls.some(([action, arg]) => action === 'tag' && arg !== '--list')).toBe(!existingTag)
  expect(command.mock.calls.some((args) => args.slice(0, 3).join(' ') === 'gh release create')).toBe(!existingRelease)
  expect(
    git.mock.calls.some(([action, lease]) => action === 'push' && lease === '--force-with-lease=refs/tags/v1:'),
  ).toBe(true)
}

describe('release', () => {
  it('orders stable tags numerically and excludes prereleases', () => {
    expect(shouldAdvance('1.9.0', ['1.10.0'])).toBe(false)
    expect(shouldAdvance('1.10.0-rc.1', [])).toBe(false)
    expect(shouldAdvance('1.10.0', ['1.9.0', '2.0.0', '1.11.0-rc.1'])).toBe(true)
    expect(shouldAdvance('1.10.0', ['1.10.0'])).toBe(true)
    for (const bad of ['01.0.0', '1.2', 'v1.2.3', '1.2.3; echo bad']) expect(() => versionParts(bad)).toThrow()
  })

  it('extracts only the matching changelog entry with migration instructions', () => {
    const changelog =
      '# Changelog\n\n## 1.0.0\n\n### Major Changes\n\nBREAKING: rename. Migration: use name.\n\n## 0.1.0\n\nOld\n'
    expect(releaseNotes(changelog, '1.0.0')).toBe('### Major Changes\n\nBREAKING: rename. Migration: use name.')
    expect(() => releaseNotes(changelog, '2.0.0')).toThrow()
  })

  it('resumes partial-success retries', () => {
    for (const [tag, release, draft] of [
      [false, false, false],
      [true, false, false],
      [true, true, true],
      [true, true, false],
    ] as const)
      exercise(tag, release, draft)
  })

  it('stops on conflicting exact tags before publication', () => {
    expect(() => exercise(true, false, false, true)).toThrow('another commit')
  })

  it('does not use publication credentials on routine commits', () => {
    const api = vi.fn()
    const command = vi.fn(() => '')
    const io: ReleaseIO = {
      git: (...args) => (args[0] === 'rev-parse' ? 'abc' : '{"version":"1.0.0"}'),
      run: command,
      api,
      read: () => manifest,
      write: vi.fn(),
      exists: () => true,
    }
    publish(io, env)
    expect(api).not.toHaveBeenCalled()
    expect(command).not.toHaveBeenCalled()
  })

  it('rejects stale compare-and-swap updates against a local bare repository', () => {
    const directory = mkdtempSync(join(tmpdir(), 'disks-tag-fixture-'))
    let cwd = directory
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    try {
      git('init', '--bare', 'remote.git')
      git('init', '-b', 'main', 'work')
      cwd = join(directory, 'work')
      git('config', 'user.name', 'Fixture')
      git('config', 'user.email', 'fixture@example.com')
      git('config', 'commit.gpgsign', 'false')
      git('remote', 'add', 'origin', join(directory, 'remote.git'))
      git('commit', '--allow-empty', '-m', 'old')
      const old = git('rev-parse', 'HEAD')
      git('push', 'origin', `${old}:refs/tags/v1`)
      git('commit', '--allow-empty', '-m', 'new')
      const latest = git('rev-parse', 'HEAD')
      git('push', `--force-with-lease=refs/tags/v1:${old}`, 'origin', `${latest}:refs/tags/v1`)
      expect(() => git('push', `--force-with-lease=refs/tags/v1:${old}`, 'origin', `${old}:refs/tags/v1`)).toThrow()
      expect(git('ls-remote', 'origin', 'refs/tags/v1').startsWith(latest)).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('verifies existing release identity and notes', () => {
    verifyRelease(record, 'v1.0.0', 'abc', 'Notes', false)
    for (const changed of [{ target_commitish: 'wrong' }, { body: 'Other' }, { prerelease: true }]) {
      expect(() => verifyRelease({ ...record, ...changed }, 'v1.0.0', 'abc', 'Notes', false)).toThrow()
    }
  })
})
