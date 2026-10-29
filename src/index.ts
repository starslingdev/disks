/** Bundled action entrypoint. Report uncaught errors as step failures. */
import * as core from '@actions/core'
import { run } from './main.js'

try {
  await run()
} catch (e) {
  core.setFailed(`disks action failed: ${e instanceof Error ? e.message : String(e)}`)
  console.error(e)
}
