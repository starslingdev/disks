/** Validate an activation request, authenticate the job, and report the runner response. */
import * as core from '@actions/core'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { askRunner, type RunnerCall, supportedRunner } from './runner.js'

// Audience for GitHub OIDC tokens used to authenticate Disks requests.
const AUDIENCE = 'starsling-disks'
const STEP_DEADLINE_MS = 60_000
/** The spawn waits this much longer, so a helper that stops on the deadline can still write its answer. */
const ROOT_GRACE_MS = 5_000

/** The step's inputs, as documented in action.yml. */
export const INPUTS = ['name', 'path', 'preset', 'size-cap', 'auto-mount', 'access', 'publish', 'on-degraded'] as const

export type Inputs = Partial<Record<(typeof INPUTS)[number], string>>

/** What the runner answers, or what this action decided before asking. These become the step's outputs. */
export interface StepResult {
  readonly outcome: 'mounted' | 'skipped' | 'failed'
  readonly publishStatus: string
  readonly fails: boolean
  readonly mounted: boolean
  readonly hit: boolean
  readonly reason?: string
  readonly path?: string
  readonly generation?: string
  /** Mounted access, preserved across repeated activations; absent when unmounted. */
  readonly access?: 'read-write' | 'read-only'
}

/**
 * The `mount` output: `warm` over a published generation, `cold` for an empty mount (a first or
 * retired disk), `none` without a mount. The runner's `hit` only counts on a mount.
 */
export function mountState(result: StepResult): 'warm' | 'cold' | 'none' {
  if (!result.mounted) return 'none'
  return result.hit ? 'warm' : 'cold'
}

const INPUT_CHOICES = {
  'auto-mount': ['true', 'false'],
  access: ['read-write', 'read-only'],
  publish: ['never', 'on-change', 'always', 'if-missing'],
  'on-degraded': ['continue', 'fail'],
} satisfies Partial<Record<keyof Inputs, readonly string[]>>

/**
 * The documented choices for the inputs this action itself judges (action.yml), and `read-only` only
 * with intent `never`: anything else is `invalid-input`, which fails the step before it asks or
 * mints, whatever `on-degraded` says. The disk, preset and size cap are StarSling's to judge.
 */
export function validInputs(inputs: Inputs): boolean {
  return (
    Object.entries(INPUT_CHOICES).every(([key, choices]) => {
      const value = inputs[key as keyof typeof INPUT_CHOICES]
      return value === undefined || choices.includes(value)
    }) && !(inputs.access === 'read-only' && (inputs.publish ?? 'never') !== 'never')
  )
}

/**
 * The path rule: a leading `~` against the job user's home, a relative path against the workspace,
 * no other expansion. `undefined` for `~user`, which names another user's home.
 */
export function expandPath(path: string, home: string, workspace: string): string | undefined {
  if (path.startsWith('~') && path !== '~' && !path.startsWith('~/')) return undefined
  const absolute = path.startsWith('~') ? posix.join(home, path.slice(1)) : posix.resolve(workspace, path)
  return absolute.length > 1 ? absolute.replace(/\/+$/, '') : absolute
}

/** The step's own target, resolved by the path rule, printable ASCII, or `invalid-input`. */
function target(path: string | undefined, home: string, workspace: string): string | undefined {
  if (path === undefined) return undefined
  const absolute = expandPath(path, home, workspace)
  return absolute !== undefined && /^\/[\x21-\x7e]*$/.test(absolute) ? absolute : 'invalid-input'
}

function unavailable(reason: string, fails: boolean, outcome: 'skipped' | 'failed' = 'skipped'): StepResult {
  return { reason, outcome, publishStatus: 'unavailable', fails, mounted: false, hit: false }
}

/** The runner's one JSON answer line, narrowed by hand: only validated fields are forwarded. */
export function readResult(stdout: string): StepResult | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '')
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { reason, outcome, publishStatus, path, fails, mounted, hit, generation, access } = parsed as Record<
    string,
    unknown
  >
  if (
    (outcome !== 'mounted' && outcome !== 'skipped' && outcome !== 'failed') ||
    typeof publishStatus !== 'string' ||
    typeof fails !== 'boolean' ||
    typeof mounted !== 'boolean' ||
    typeof hit !== 'boolean'
  ) {
    return undefined
  }
  return {
    outcome,
    publishStatus,
    fails,
    mounted,
    hit,
    ...(typeof reason === 'string' ? { reason } : {}),
    ...(typeof path === 'string' ? { path } : {}),
    ...(typeof generation === 'string' ? { generation } : {}),
    ...(access === 'read-write' || access === 'read-only' ? { access } : {}),
  }
}

/** Mint the job's OIDC token for Disks; `undefined` without `id-token: write`. */
async function mintToken(): Promise<string | undefined> {
  try {
    return await core.getIDToken(AUDIENCE)
  } catch {
    return undefined
  }
}

/** Why the helper produced no step result. The runner's own JSON reason is not one of these. */
export type RootMiss = 'root-timeout' | 'sudo-denied' | 'root-exit' | 'root-parse'

/**
 * Phrases `sudo -n` prints when it will not run the command. A missing binary
 * (`sudo: /usr/bin/env: command not found`) is not a refusal; that is `root-exit`.
 */
const SUDO_REFUSAL =
  /a password is required|a terminal is required to read the password|no tty present and no askpass program specified|sorry, you must have a tty to run sudo|is not in the sudoers file|is not allowed to (?:run sudo|execute )|interactive authentication is required/

/** Status 0 is `root-parse` only after `readResult` has already rejected stdout. Timeout wins over the signal it uses (`SIGTERM`). */
export function classifyRootMiss(call: RunnerCall): RootMiss {
  if (call.errorCode === 'ETIMEDOUT') return 'root-timeout'
  if (call.status === 0) return 'root-parse'
  if (call.viaSudo && SUDO_REFUSAL.test(call.stderr)) return 'sudo-denied'
  return 'root-exit'
}

/** A line that begins with `::` is a workflow command. Indent those so stderr cannot close the group or forge an annotation. */
export function defuse(text: string): string {
  const safe = text.replace(/^::/gm, ' ::')
  return safe.endsWith('\n') ? safe : `${safe}\n`
}

function logSpawn(reason: RootMiss | undefined, call: RunnerCall, mintMs: number): void {
  core.info(`disks root side: ${call.wallMs}ms (token ${mintMs}ms)`)
  if (reason === undefined && !call.stderr) return
  const error = call.errorCode ?? call.errorMessage
  const detail =
    reason === undefined
      ? ''
      : [
          reason,
          `status=${call.status ?? 'none'}`,
          `signal=${call.signal ?? 'none'}`,
          ...(error === undefined ? [] : [`error=${error}`]),
          ...(reason === 'root-parse' ? ['stdout was not a step result'] : []),
        ].join(' ')
  // Never log stdout: a crashed helper may echo stdin, which contains the token.
  // The runner recognizes workflow commands anywhere in a line. Disable them for the whole
  // diagnostic, including disk names in stderr, and use an unpredictable token to resume parsing.
  const resume = randomUUID()
  core.startGroup('disks root side')
  core.info(`::stop-commands::${resume}`)
  try {
    core.info([detail, call.stderr || '(no stderr)'].filter(Boolean).join('\n').replace(/\n$/, ''))
  } finally {
    core.info(`::${resume}::`)
    core.endGroup()
  }
}

/** The step's activation; its result carries the step's own resolved target whenever the answer has none. */
export async function activate(env: NodeJS.ProcessEnv, inputs: Inputs, strict: boolean): Promise<StepResult> {
  const home = homedir()
  const workspace = env.GITHUB_WORKSPACE
  const path = workspace ? target(inputs.path, home, workspace) : undefined
  if (path === 'invalid-input') return unavailable('invalid-input', true, 'failed')
  const at = (result: StepResult): StepResult =>
    result.path === undefined && path !== undefined ? { ...result, path } : result
  if (!inputs.name || !validInputs(inputs)) return at(unavailable('invalid-input', true, 'failed'))
  if (!workspace || !supportedRunner()) return at(unavailable('unsupported-runner', strict))
  const started = Date.now()
  const token = await mintToken()
  if (token === undefined) return at(unavailable('missing-oidc', strict))
  const mintMs = Date.now() - started
  const call = askRunner(
    {
      token,
      inputs: { ...inputs, ...(path === undefined ? {} : { path }) },
      home,
      workspace,
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      deadlineMs: Date.now() + STEP_DEADLINE_MS,
    },
    STEP_DEADLINE_MS + ROOT_GRACE_MS,
  )
  const result = call.errorCode !== 'ETIMEDOUT' && call.status === 0 ? readResult(call.stdout) : undefined
  if (result !== undefined) {
    logSpawn(undefined, call, mintMs)
    return at(result)
  }
  const reason = classifyRootMiss(call)
  logSpawn(reason, call, mintMs)
  return at(unavailable(reason, strict))
}

/** Describe publication consistently in logs and summaries. Pending writes require a successful job. */
export function describePublish(publish: string | undefined, status: string, reason: string | undefined): string {
  switch (status) {
    case 'pending':
      return 'publish pending (requires a successful job)'
    case 'not-needed':
      return 'publish not needed (if-missing hit)'
    case 'not-requested':
    case 'denied':
    case 'lease-held':
    case 'unavailable':
      return `publish skipped (${reason ?? (status === 'not-requested' ? `publish: ${publish ?? 'never'}` : `publish-status: ${status}`)})`
    default:
      return `publish unknown (${status})`
  }
}

/** Summary builders interpolate HTML without escaping text. */
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Write the publish log line, then the job summary table built by `core.summary`. The summary is
 * presentation, not an output: callers treat a failure here as a warning, never a failed mount.
 */
export async function render(name: string, publish: string | undefined, result: StepResult): Promise<void> {
  const description = describePublish(publish, result.publishStatus, result.reason)
  const line = `disk ${name}: ${description}`.replace(/[\r\n]+/g, ' ')
  core.info(defuse(line).replace(/\n$/, ''))
  if (!process.env.GITHUB_STEP_SUMMARY) return
  const rows: string[][] = [
    ['Publish', description],
    ['publish', publish ?? 'never'],
    ['publish-status', result.publishStatus],
    ['reason', result.reason ?? ''],
    ['generation', result.generation ?? ''],
    ['mount', mountState(result)],
  ].map((row) => row.map((value) => escapeHtml(value || '(empty)')))
  await core.summary
    .addHeading(escapeHtml(`StarSling Disks ${name}`), 3)
    .addRaw(
      'Publication happens after the job and requires an unambiguous success. ' +
        'These values describe the step-time result; pending is not published.',
      true,
    )
    .addTable([
      [
        { data: 'Field', header: true },
        { data: 'Value', header: true },
      ],
      ...rows,
    ])
    .write()
}
