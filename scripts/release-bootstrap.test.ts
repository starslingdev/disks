import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { publish, REPO, type Release, type ReleaseIO, releaseNotes } from './release.ts'

it('generates 0.1.0 and publishes it only after the release PR merges', () => {
  const root = resolve(import.meta.dirname, '..')
  const directory = mkdtempSync(join(tmpdir(), 'disks-initial-release-'))
  const work = join(directory, 'work')
  mkdirSync(work)
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const changeset = (...args: string[]): void => {
    execFileSync(process.execPath, [join(root, 'node_modules/@changesets/cli/bin.js'), ...args], {
      cwd: work,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  try {
    git('init', '--bare', join(directory, 'remote.git'))
    git('init', '-b', 'main')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.com')
    git('config', 'commit.gpgsign', 'false')
    git('remote', 'add', 'origin', join(directory, 'remote.git'))
    cpSync(join(root, 'LICENSE'), join(work, 'LICENSE'))
    git('add', 'LICENSE')
    git('commit', '-m', 'Initial commit')

    for (const name of ['package.json', 'pnpm-workspace.yaml', '.gitignore', 'CHANGELOG.md', 'action.yml', 'dist']) {
      cpSync(join(root, name), join(work, name), { recursive: true })
    }
    // Exercise the installed Changesets CLI with a local formatter, without GitHub lookups.
    symlinkSync(join(root, 'node_modules'), join(work, 'node_modules'), 'dir')
    // Keep the fixture reproducible after the real initial changeset has been consumed.
    const packagePath = join(work, 'package.json')
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>
    manifest.version = '0.0.0'
    writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(join(work, 'CHANGELOG.md'), '# Changelog\n')
    mkdirSync(join(work, '.changeset'))
    writeFileSync(
      join(work, '.changeset/initial-release.md'),
      '---\n"disks": minor\n---\n\nPublish the initial 0.1.0 release.\n',
    )
    const configPath = join(work, '.changeset/config.json')
    const config = JSON.parse(readFileSync(join(root, '.changeset/config.json'), 'utf8')) as Record<string, unknown>
    config.changelog = ['@changesets/cli/changelog', null]
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
    git('add', '.')
    git('commit', '-m', 'feat: add Disks action')
    git('push', '-u', 'origin', 'main')
    let sha = git('rev-parse', 'HEAD')
    let releaseHead = ''
    let merged = false
    let release: Release | null = null
    const api = vi.fn((path: string): unknown => {
      if (path === `commits/${sha}/pulls?per_page=100`) {
        return merged
          ? [
              {
                number: 1,
                user: { login: 'release-bot' },
                merged_at: '2026-01-01T00:00:00Z',
                merge_commit_sha: sha,
                head: { sha: releaseHead, ref: 'changeset-release/main', repo: { full_name: REPO } },
                base: { ref: 'main' },
              },
            ]
          : []
      }
      if (path === 'releases/tags/v0.1.0') return release
      throw new Error(`Unexpected GitHub request: ${path}`)
    })
    const command = vi.fn((...args: string[]): string => {
      switch (args.slice(0, 3).join(' ')) {
        case 'gh auth setup-git':
          return ''
        case 'gh release create': {
          expect(args[3]).toBe('v0.1.0')
          expect(args).toContain('--draft')
          expect(args).not.toContain('--prerelease')
          expect(git('ls-remote', 'origin', 'refs/tags/v0')).toBe('')
          const notes = readFileSync(join(directory, 'disks-release-notes.md'), 'utf8')
          release = { tag_name: 'v0.1.0', target_commitish: sha, body: notes, prerelease: false, draft: true }
          return ''
        }
        case 'gh release edit':
          expect(args).toContain('--draft=false')
          expect(git('ls-remote', 'origin', 'refs/tags/v0')).toBe('')
          if (!release) throw new Error('No release to publish')
          release = { ...release, draft: false }
          return ''
        default:
          throw new Error(`Unexpected release command: ${args.join(' ')}`)
      }
    })
    const io: ReleaseIO = {
      git,
      run: command,
      api,
      read: (path) => readFileSync(join(work, path), 'utf8'),
      write: (path, content) => writeFileSync(path, content),
      exists: (path) => existsSync(join(work, path)),
    }
    const environment = () => ({
      GITHUB_REPOSITORY: REPO,
      GITHUB_REF: 'refs/heads/main',
      RELEASE_SHA: sha,
      RUNNER_TEMP: directory,
    })

    // The first merge has a license-only parent. It must succeed without attempting publication.
    expect(git('ls-tree', '--name-only', 'HEAD^1', '--', 'package.json')).toBe('')
    publish(io, environment())
    expect(api).not.toHaveBeenCalled()
    expect(command).not.toHaveBeenCalled()
    expect(git('tag', '--list')).toBe('')

    git('switch', '-c', 'changeset-release/main')
    const planPath = join(directory, 'plan.json')
    changeset('status', '--output', planPath)
    expect(JSON.parse(readFileSync(planPath, 'utf8'))).toMatchObject({
      releases: [{ name: 'disks', type: 'minor', oldVersion: '0.0.0', newVersion: '0.1.0' }],
    })
    changeset('version')
    expect(JSON.parse(io.read('package.json'))).toMatchObject({ version: '0.1.0', license: 'MIT' })
    expect(releaseNotes(io.read('CHANGELOG.md'), '0.1.0')).toContain('initial 0.1.0 release')
    expect(existsSync(join(work, '.changeset/initial-release.md'))).toBe(false)
    git('add', '.')
    git('commit', '-m', 'chore: release Disks')
    releaseHead = git('rev-parse', 'HEAD')
    expect(() => publish(io, { ...environment(), GITHUB_REF: 'refs/heads/changeset-release/main' })).toThrow(
      'Publication is restricted',
    )
    git('switch', 'main')
    git('merge', '--no-ff', 'changeset-release/main', '-m', 'chore: release Disks')
    git('push', 'origin', 'main')
    sha = git('rev-parse', 'HEAD')

    // A version transition alone is insufficient: GitHub must confirm the merged release PR.
    expect(() => publish(io, environment())).toThrow('Version transition must merge the Changesets release PR')
    expect(command).not.toHaveBeenCalled()
    expect(git('ls-remote', '--tags', 'origin')).toBe('')
    merged = true
    publish(io, environment())
    expect(release).toMatchObject({ tag_name: 'v0.1.0', target_commitish: sha, draft: false })
    expect(git('ls-remote', '--tags', 'origin').split('\n').sort()).toEqual([
      `${sha}\trefs/tags/v0`,
      `${sha}\trefs/tags/v0.1.0`,
    ])
    expect(readFileSync(join(work, 'LICENSE'), 'utf8')).toBe(readFileSync(join(root, 'LICENSE'), 'utf8'))

    publish(io, environment())
    expect(command.mock.calls.filter((args) => args.slice(0, 3).join(' ') === 'gh release create')).toHaveLength(1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
