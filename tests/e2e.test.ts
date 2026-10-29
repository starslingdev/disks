/**
 * End-to-end tests for the action: each test drives `run()` (src/main.ts) through the real
 * `@actions/core` — real INPUT_* env, real GITHUB_OUTPUT / GITHUB_STEP_SUMMARY files, real log
 * stream — and asserts only what a workflow would observe: outputs, summary, log lines, exit code.
 * The only fakes are the two external boundaries a test machine cannot provide: the StarSling
 * runner seam (src/runner.ts, canned `RunnerCall`s) and the OIDC endpoint (a local HTTP stub).
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunnerCall, RunnerSeam } from '../src/runner.js'

const seam = vi.hoisted(() => ({
  supported: false,
  command: undefined as string | undefined,
  call: undefined as RunnerCall | undefined,
  runner: undefined as RunnerSeam | undefined,
  timeoutMs: undefined as number | undefined,
  request: undefined as object | undefined,
}))

vi.mock('../src/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runner.js')>()
  return {
    supportedRunner: () => (seam.command !== undefined ? actual.supportedRunner(seam.command) : seam.supported),
    askRunner: (request: object, timeoutMs: number) => {
      seam.request = request
      if (seam.runner !== undefined) return actual.askRunner(request, seam.timeoutMs ?? timeoutMs, seam.runner)
      return seam.call
    },
  }
})

const { run } = await import('../src/main.js')

const INPUT_ENV = [
  'INPUT_NAME',
  'INPUT_PATH',
  'INPUT_PRESET',
  'INPUT_SIZE-CAP',
  'INPUT_AUTO-MOUNT',
  'INPUT_ACCESS',
  'INPUT_PUBLISH',
  'INPUT_ON-DEGRADED',
] as const

type Outputs = Record<string, string>

interface RunResult {
  outputs: Outputs
  summary: string
  log: string
  exitCode: number | undefined
}

const parseOutputs = (text: string): Outputs => {
  const outputs: Outputs = {}
  for (const match of text.matchAll(/^(.+?)<<ghadelimiter_\S+\n([\s\S]*?)\nghadelimiter_\S+$/gm)) {
    const [, name, value] = match
    if (name) outputs[name] = value ?? ''
  }
  return outputs
}

const baseCall = (partial: Partial<RunnerCall>): RunnerCall => ({
  stdout: '',
  stderr: '',
  status: 0,
  signal: null,
  errorCode: undefined,
  errorMessage: undefined,
  viaSudo: false,
  wallMs: 3,
  ...partial,
})

describe('disks (end-to-end)', () => {
  let dir: string
  let outputFile: string
  let summaryFile: string
  let server: Server
  let tokenUrl: string
  let tokenAudience: string | null
  let logChunks: string[]
  const savedEnv = new Map<string, string | undefined>()

  const setEnv = (name: string, value: string | undefined) => {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  const runOnce = async (inputs: Record<string, string>): Promise<RunResult> => {
    for (const name of INPUT_ENV) setEnv(name, inputs[name.replace('INPUT_', '').toLowerCase()])
    await writeFile(outputFile, '')
    await writeFile(summaryFile, '')
    logChunks = []
    process.exitCode = undefined
    seam.request = undefined
    await run()
    return {
      outputs: parseOutputs(await readFile(outputFile, 'utf8')),
      summary: await readFile(summaryFile, 'utf8'),
      log: logChunks.join(''),
      exitCode: process.exitCode,
    }
  }

  // One workspace/output/summary triple for the whole file, like one job on a real runner:
  // @actions/core caches the summary file path in its singleton, as it does in production.
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'disks-e2e-'))
    outputFile = join(dir, 'outputs')
    summaryFile = join(dir, 'summary')
    setEnv('GITHUB_WORKSPACE', join(dir, 'ws'))
    setEnv('GITHUB_OUTPUT', outputFile)
    setEnv('GITHUB_STEP_SUMMARY', summaryFile)
    server = createServer((req, res) => {
      tokenAudience = new URL(req.url ?? '/', 'http://localhost').searchParams.get('audience')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ value: 'test-token' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    tokenUrl = `http://127.0.0.1:${port}/token?api-version=1`
    setEnv('ACTIONS_ID_TOKEN_REQUEST_URL', tokenUrl)
    setEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'request-token')
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    savedEnv.clear()
    await rm(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    tokenAudience = null
    logChunks = []
    seam.supported = false
    seam.command = undefined
    seam.call = undefined
    seam.runner = undefined
    seam.timeoutMs = undefined
    process.exitCode = undefined
    setEnv('ACTIONS_ID_TOKEN_REQUEST_URL', tokenUrl)
    setEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'request-token')
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      logChunks.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('handles unsupported runners, strict activation and path expansion', async () => {
    seam.supported = false

    const result = await runOnce({ name: 'smoke', path: '~/.disks/disks-smoke' })

    expect(result.outputs).toEqual({
      name: 'smoke',
      path: `${homedir()}/.disks/disks-smoke`,
      mount: 'none',
      generation: '',
      access: '',
      'publish-status': 'unavailable',
      reason: 'unsupported-runner',
    })
    expect(result.summary).toContain('<h3>StarSling Disks smoke</h3>')
    expect(result.summary).toContain('Publication happens after the job and requires an unambiguous success.')
    expect(result.summary).toContain('<td>Publish</td><td>publish skipped (unsupported-runner)</td>')
    expect(result.log).toContain('::notice::disk smoke: not mounted (unsupported-runner)')
    expect(result.log).toContain('disk smoke: publish skipped (unsupported-runner)')
    expect(result.exitCode).toBeUndefined()

    const strict = await runOnce({ name: 'smoke', path: 'target', 'on-degraded': 'fail' })

    expect(strict.outputs.path).toBe(join(dir, 'ws', 'target'))
    expect(strict.outputs.reason).toBe('unsupported-runner')
    expect(strict.log).toContain('::error::disk smoke: not mounted (unsupported-runner)')
    expect(strict.exitCode).toBe(1)

    const preset = await runOnce({ preset: 'cargo' })
    expect(preset.outputs.name).toBe('cargo')
    expect(preset.log).toContain('disk cargo: not mounted (unsupported-runner)')
  })

  it('fails invalid input before asking the runner', async () => {
    const publishing = await runOnce({ name: 'smoke', access: 'read-only', publish: 'always' })
    expect(publishing.outputs.reason).toBe('invalid-input')
    expect(publishing.log).toContain('::error::disk smoke: not mounted (invalid-input)')
    expect(publishing.summary).toContain('<td>Publish</td><td>publish skipped (invalid-input)</td>')
    expect(publishing.exitCode).toBe(1)

    const badTarget = await runOnce({ name: 'smoke', path: '~root/secret' })
    expect(badTarget.outputs.reason).toBe('invalid-input')
    expect(badTarget.exitCode).toBe(1)
    expect(seam.request).toBeUndefined()
  })

  it('mounts a warm disk and reports the publish as pending', async () => {
    seam.supported = true
    seam.call = baseCall({
      stdout: JSON.stringify({
        outcome: 'mounted',
        publishStatus: 'pending',
        fails: false,
        mounted: true,
        hit: true,
        generation: 'g7',
        access: 'read-write',
      }),
      stderr: 'helper: using volume 7\n',
    })

    const result = await runOnce({
      name: 'pnpm-store',
      path: '~/.local/share/pnpm/store',
      'auto-mount': 'false',
      publish: 'on-change',
      'on-degraded': 'continue',
    })

    expect(tokenAudience).toBe('starsling-disks')
    expect(seam.request).toMatchObject({
      token: 'test-token',
      inputs: {
        name: 'pnpm-store',
        path: `${homedir()}/.local/share/pnpm/store`,
        'auto-mount': 'false',
        publish: 'on-change',
        'on-degraded': 'continue',
      },
    })
    expect(seam.request).not.toHaveProperty('inputs.cache')
    expect(seam.request).not.toHaveProperty('inputs.default-mount')
    expect(seam.request).not.toHaveProperty('inputs.on-unavailable')
    expect(result.outputs).toEqual({
      name: 'pnpm-store',
      path: `${homedir()}/.local/share/pnpm/store`,
      mount: 'warm',
      generation: 'g7',
      access: 'read-write',
      'publish-status': 'pending',
      reason: '',
    })
    expect(result.summary).toContain('<td>Publish</td><td>publish pending (requires a successful job)</td>')
    expect(result.log).toContain('disk pnpm-store: mounted warm')
    expect(result.log).toContain('disk pnpm-store: publish pending (requires a successful job)')
    expect(result.log).toContain('disks root side:')
    expect(result.log).toContain('helper: using volume 7')
    expect(result.exitCode).toBeUndefined()

    seam.call = baseCall({
      stdout: JSON.stringify({
        outcome: 'mounted',
        publishStatus: 'not-needed',
        fails: false,
        mounted: true,
        hit: true,
        generation: 'g7',
        access: 'read-only',
      }),
    })
    const hit = await runOnce({ name: 'reference', publish: 'if-missing' })
    expect(hit.outputs.mount).toBe('warm')
    expect(hit.outputs.access).toBe('read-only')
    expect(hit.summary).toContain('<td>Publish</td><td>publish not needed (if-missing hit)</td>')
    expect(hit.log).toContain('disk reference: publish not needed (if-missing hit)')

    seam.call = baseCall({
      stdout: JSON.stringify({
        outcome: 'mounted',
        publishStatus: 'denied',
        reason: 'not-publisher',
        fails: false,
        mounted: true,
        hit: false,
        access: 'read-write',
      }),
    })
    const denied = await runOnce({ name: 'pnpm-store', publish: 'on-change' })
    expect(denied.outputs.mount).toBe('cold')
    expect(denied.log).toContain('::notice::disk pnpm-store: mounted cold (not-publisher)')
    expect(denied.outputs['publish-status']).toBe('denied')
    expect(denied.summary).toContain('<td>Publish</td><td>publish skipped (not-publisher)</td>')
    expect(denied.log).toContain('disk pnpm-store: publish skipped (not-publisher)')
  })

  it('reports activation failures and safely logs diagnostics', async () => {
    seam.supported = true

    seam.call = baseCall({ status: 1, viaSudo: true, stderr: 'sudo: a password is required\n' })
    const sudo = await runOnce({ name: 'smoke' })
    expect(sudo.outputs.reason).toBe('sudo-denied')
    expect(sudo.log).toContain('sudo-denied status=1')
    expect(sudo.exitCode).toBeUndefined()

    seam.call = baseCall({ status: 0, stdout: 'not a step result' })
    const parse = await runOnce({ name: 'smoke' })
    expect(parse.outputs.reason).toBe('root-parse')
    expect(parse.log).toContain('stdout was not a step result')

    seam.call = baseCall({ status: null, signal: 'SIGTERM', errorCode: 'ETIMEDOUT' })
    const timeout = await runOnce({ name: 'smoke' })
    expect(timeout.outputs.reason).toBe('root-timeout')

    seam.call = baseCall({
      status: 2,
      stdout: 'request token that must never be logged',
      stderr: 'Disk activation: alias::error::forged annotation\n' + '::endgroup::\n::add-mask::forged-mask\n',
    })

    const result = await runOnce({ name: 'smoke' })
    const stop = result.log.match(/::stop-commands::([^\r\n]+)/)
    const resume = stop?.[1]
    expect(resume).toBeTruthy()
    expect(result.log).not.toContain('request token that must never be logged')
    const start = result.log.indexOf(`::stop-commands::${resume}`)
    const end = result.log.indexOf(`::${resume}::`)
    expect(start).toBeLessThan(result.log.indexOf('alias::error::forged annotation'))
    expect(end).toBeGreaterThan(result.log.indexOf('::add-mask::forged-mask'))
    expect(result.log.slice(end)).toContain('::endgroup::')
    expect(result.log.slice(end)).toContain('::notice::disk smoke: not mounted (root-exit)')
    expect(result.outputs.reason).toBe('root-exit')

    for (const reason of ['deadline-exceeded', 'unexpected']) {
      const diagnostic = `Disk activation: ${reason}; retry the job`
      seam.call = baseCall({
        stdout: JSON.stringify({
          reason,
          outcome: 'skipped',
          publishStatus: 'unavailable',
          fails: false,
          mounted: false,
          hit: false,
        }),
        stderr: `${diagnostic}\n`,
      })
      for (const strict of [false, true]) {
        const failure = await runOnce({ name: 'smoke', 'on-degraded': strict ? 'fail' : 'continue' })
        expect(failure.outputs.reason).toBe(reason)
        expect(failure.outputs.mount).toBe('none')
        expect(failure.outputs['publish-status']).toBe('unavailable')
        expect(failure.summary).toContain(`<td>reason</td><td>${reason}</td>`)
        expect(failure.log).toContain(diagnostic)
        expect(failure.exitCode).toBe(strict ? 1 : undefined)
      }
    }

    setEnv('ACTIONS_ID_TOKEN_REQUEST_URL', undefined)
    setEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', undefined)
    const noToken = await runOnce({ name: 'smoke' })
    expect(noToken.outputs.reason).toBe('missing-oidc')
    expect(seam.request).toBeUndefined()
  })

  it('executes the real runner subprocess seam (supportedRunner, env -i, sudo -n, and timeout)', async () => {
    const seamDir = join(dir, 'seam')
    await mkdir(seamDir, { recursive: true })
    const helper = join(seamDir, 'disks-step')
    const fakeSudo = join(seamDir, 'sudo')

    seam.command = helper
    const missing = await runOnce({ name: 'smoke' })
    expect(missing.outputs.reason).toBe('unsupported-runner')

    await writeFile(
      helper,
      [
        '#!/bin/sh',
        'set -eu',
        'test "$#" = "0"',
        'test "$HOME" = "/root"',
        'test "$PWD" = "/"',
        '! printenv INPUT_NAME >/dev/null 2>&1',
        'payload="$(cat)"',
        'case "$payload" in',
        '  *\'"token":"test-token"\'*) ;;',
        '  *) echo "missing token in stdin" >&2; exit 2 ;;',
        'esac',
        'echo "helper: real subprocess ok" >&2',
        'printf \'%s\\n\' \'{"outcome":"mounted","publishStatus":"pending","fails":false,"mounted":true,"hit":true,"generation":"g9","access":"read-write"}\'',
      ].join('\n'),
    )
    await chmod(helper, 0o755)

    seam.runner = { command: helper, viaSudo: false }
    const mounted = await runOnce({ name: 'pnpm-store', path: '~/.local/share/pnpm/store', publish: 'on-change' })
    expect(mounted.outputs).toMatchObject({
      mount: 'warm',
      generation: 'g9',
      access: 'read-write',
      'publish-status': 'pending',
      reason: '',
    })
    expect(mounted.log).toContain('helper: real subprocess ok')

    await writeFile(fakeSudo, ['#!/bin/sh', 'echo "sudo: a password is required" >&2', 'exit 1'].join('\n'))
    await chmod(fakeSudo, 0o755)
    seam.runner = { command: helper, sudo: fakeSudo, viaSudo: true }
    const refused = await runOnce({ name: 'smoke' })
    expect(refused.outputs.reason).toBe('sudo-denied')

    await writeFile(helper, ['#!/bin/sh', 'sleep 2'].join('\n'))
    await chmod(helper, 0o755)
    seam.runner = { command: helper, viaSudo: false }
    seam.timeoutMs = 50
    const timedOut = await runOnce({ name: 'smoke' })
    expect(timedOut.outputs.reason).toBe('root-timeout')
  })
})
