/** Read action inputs, activate a disk, and write outputs and diagnostics. */
import * as core from '@actions/core'
import {
  activate,
  defuse,
  INPUTS,
  type Inputs,
  mirrorOnly,
  mountState,
  render,
  type StepResult,
  validInputs,
} from './disks.js'

/** Log text on one line, so a disk name or message cannot forge a second log line. */
const oneline = (value: string): string => value.replace(/[\r\n]+/g, ' ')

/** The step's inputs from the runner's `INPUT_<NAME>` environment, via the toolkit; an empty one is absent. */
function readInputs(): Inputs {
  const inputs: Inputs = {}
  for (const name of INPUTS) {
    const value = core.getInput(name)
    if (value) inputs[name] = value
  }
  if (!inputs.name && inputs.preset) inputs.name = inputs.preset
  return inputs
}

/** The step's outputs, the step-time publish outcome, then the step's verdict. */
async function finish(inputs: Inputs, strict: boolean, result: StepResult): Promise<void> {
  const outputs = {
    name: inputs.name ?? '',
    path: result.path ?? '',
    // What the mount is, not what this step asked: a repeat over a writable mount stays writable.
    access: result.mounted ? (result.access ?? '') : '',
    mount: mountState(result),
    generation: result.generation ?? '',
    'publish-status': result.publishStatus,
    reason: result.reason ?? '',
  }
  for (const [output, value] of Object.entries(outputs)) core.setOutput(output, value)
  const name = oneline(inputs.name ?? '?')
  const fails = result.fails || (strict && !result.mounted)
  const mount = mountState(result)
  const what = `disk ${name}: ${mount === 'none' ? 'not mounted' : `mounted ${mount}`}${result.reason ? ` (${oneline(result.reason)})` : ''}`
  if (fails) core.error(what)
  else if (result.reason) core.notice(what)
  else core.info(what)
  // The summary is presentation, not an output: its failure warns, and never turns a mount into a failure.
  try {
    await render(name, inputs.publish, result)
  } catch (err) {
    core.warning(`disk ${name}: job summary not written (${oneline(err instanceof Error ? err.message : String(err))})`)
  }
  if (fails) process.exitCode = 1
}

/** A step with only `git-mirror`: report what the runner reads from the workflow, and activate nothing. */
function mirrorStep(inputs: Inputs): void {
  const valid = validInputs(inputs)
  const outputs = { name: '', path: '', access: '', mount: 'none', generation: '', 'publish-status': 'not-requested' }
  for (const [output, value] of Object.entries(outputs)) core.setOutput(output, value)
  core.setOutput('reason', valid ? '' : 'invalid-input')
  if (!valid) {
    core.error('git mirror: invalid-input (git-mirror is true or false)')
    process.exitCode = 1
    return
  }
  core.info(
    inputs['git-mirror'] === 'true'
      ? 'git mirror: on for this job (StarSling reads it from the workflow before the job starts)'
      : 'git mirror: off for this job',
  )
}

/** Complete one activation. Output-write errors propagate to the entrypoint. */
export async function run(): Promise<void> {
  const inputs = readInputs()
  if (mirrorOnly(inputs)) return mirrorStep(inputs)
  const strict = inputs['on-degraded'] === 'fail'
  const result = await activate(process.env, inputs, strict).catch((err: unknown): StepResult => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    core.startGroup('disks error')
    core.info(defuse(detail).replace(/\n$/, ''))
    core.endGroup()
    return {
      reason: 'action-error',
      outcome: 'skipped',
      publishStatus: 'unavailable',
      fails: strict,
      mounted: false,
      hit: false,
    }
  })
  await finish(inputs, strict, result)
}
