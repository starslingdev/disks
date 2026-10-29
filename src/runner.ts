/** Invoke the Disks helper installed on StarSling Runners. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Stable executable path; runtime and storage details belong to the helper. */
const RUNNER_COMMAND = '/opt/starsling/libexec/disks-step'

/** Whether this machine provides the Disks entrypoint. Storage readiness is the runner's decision. */
export function supportedRunner(command: string = RUNNER_COMMAND): boolean {
  return existsSync(command)
}

/** The helper's whole environment, nothing inherited from the job; it also runs from `/`. */
const RUNNER_ENV = ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME=/root'] as const

/** Subprocess overrides used by integration tests. */
export interface RunnerSeam {
  readonly command?: string
  readonly sudo?: string
  readonly viaSudo?: boolean
}

/**
 * Process output and diagnostics. Never log stdout: the helper may echo the request's OIDC token.
 */
export interface RunnerCall {
  readonly stdout: string
  readonly stderr: string
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly errorCode: string | undefined
  readonly errorMessage: string | undefined
  /** True when the helper was started through `sudo -n` rather than as root already. */
  readonly viaSudo: boolean
  readonly wallMs: number
}

function spawnErrorCode(error: Error | undefined): string | undefined {
  if (error === undefined || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

/** Send one step request to the runner. The action classifies a call that produced no answer. */
export function askRunner(request: object, timeoutMs: number, seam: RunnerSeam = {}): RunnerCall {
  const viaSudo = seam.viaSudo ?? (process.geteuid?.() ?? -1) !== 0
  const clean = ['-i', ...RUNNER_ENV, seam.command ?? RUNNER_COMMAND]
  // sudo inherits the job's locale and would translate a refusal. `env -i` still clears the helper.
  const [command, args] = viaSudo
    ? ['/usr/bin/env', ['LANG=C', 'LC_ALL=C', seam.sudo ?? '/usr/bin/sudo', '-n', '/usr/bin/env', ...clean]]
    : ['/usr/bin/env', clean]
  const started = Date.now()
  const result = spawnSync(command, args, {
    cwd: '/',
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: timeoutMs,
  })
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
    signal: result.signal,
    errorCode: spawnErrorCode(result.error),
    errorMessage: result.error?.message.split('\n')[0],
    viaSudo,
    wallMs: Date.now() - started,
  }
}
