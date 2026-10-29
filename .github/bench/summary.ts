import * as fs from 'node:fs'
import * as path from 'node:path'
import type * as Core from '@actions/core'
import type { Measurement } from './store.js'

export interface Job {
  id: number
  name: string
  conclusion: string | null
  steps?: { name: string; conclusion: string | null; started_at?: string; completed_at?: string }[]
}
interface Arguments {
  github: {
    paginate: (endpoint: unknown, options: Record<string, unknown>) => Promise<Job[]>
    rest: {
      actions: {
        listJobsForWorkflowRunAttempt: unknown
        downloadJobLogsForWorkflowRun: (options: Record<string, unknown>) => Promise<{ data: unknown }>
      }
    }
  }
  context: { repo: { owner: string; repo: string }; runId: number }
  core: typeof Core
}
export const median = (values: (number | undefined)[]) => {
  const a = values.filter((v): v is number => v !== undefined && Number.isFinite(v)).sort((a, b) => a - b)
  return a.length ? ((a[Math.floor((a.length - 1) / 2)] ?? 0) + (a[Math.floor(a.length / 2)] ?? 0)) / 2 : null
}
export function stepSeconds(job: Job, name: string): number | undefined {
  const step = job.steps?.find((s) => s.name === name && s.conclusion === 'success')
  if (!step?.started_at || !step.completed_at) return undefined
  const seconds = (Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}
export function setupSeconds(job: Job): number | undefined {
  const setup = stepSeconds(job, 'Setup pnpm')
  const install = stepSeconds(job, 'Install Mastra dependencies')
  return setup === undefined || install === undefined ? undefined : setup + install
}
// The final cumulative progress line is the action's average over the completed archive download.
// Ignore partial transfers and progress from any other action in the job.
export function cacheDownloadSpeed(log: string): number | undefined {
  const section = log.split(/##\[group\]Run actions\/cache\/restore@/)[1]?.split('##[group]')[0]
  if (!section) return undefined
  const matches = [...section.matchAll(/Received (\d+) of (\d+) \(100(?:\.0+)?%\),\s*([\d.]+) MBs\/sec/g)]
  const last = matches.at(-1)
  if (!last || last[1] !== last[2]) return undefined
  const speed = Number(last[3])
  return Number.isFinite(speed) && speed > 0 ? speed : undefined
}
const seconds = (value: number | null) => (value === null ? 'N/A' : `${value.toFixed(value < 1 ? 2 : 1)} s`)
const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const header = (values: string[]) => values.map((data) => ({ data, header: true }))
const ratio = (github: number | null, disks: number | null) =>
  github === null || disks === null || github <= 0 || disks <= 0 ? 'N/A' : `${(github / disks).toFixed(2)}×`
// GitHub combines the caller stage with the reusable worker name, e.g. Read • github / github • 1.
const jobSuffix = (stage: string, service: string, replica: number) =>
  `${stage === 'write' ? 'Write' : 'Read'} • ${service} / ${service} • ${replica}`

export default async function summarize({ github, context, core }: Arguments) {
  const walk = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
  const results: Measurement[] = fs.existsSync('results')
    ? walk('results')
        .filter((p) => p.endsWith('.json'))
        .map((p) => JSON.parse(fs.readFileSync(p, 'utf8')))
    : []
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, {
    ...context.repo,
    run_id: context.runId,
    attempt_number: Number(process.env.GITHUB_RUN_ATTEMPT),
    per_page: 100,
  })
  const samples = (stage: string, service: string) => {
    const replicas = stage === 'write' ? [0] : [1, 2, 3, 4, 5]
    return replicas.flatMap((replica) => {
      const matches = results.filter((r) => r.stage === stage && r.service === service && r.replica === replica)
      const result = matches.length === 1 ? matches[0] : undefined
      const job = jobs.find((j) => j.name.endsWith(jobSuffix(stage, service, replica)) && j.conclusion === 'success')
      if (!result?.complete || result.source !== process.env.MASTRA_SHA || !job || setupSeconds(job) === undefined)
        return []
      if (stage === 'read' && (result.metrics.access_ms === undefined || result.metrics.access_ms < 0)) return []
      return [{ result, job }]
    })
  }
  const readers = ['github', 'starsling'].map((service) => samples('read', service))
  const writers = ['github', 'starsling'].map((service) => samples('write', service))
  const complete = readers.every((s) => s.length === 5) && writers.every((s) => s.length === 1)
  const access = readers.map((s) => median(s.map(({ result }) => (result.metrics.access_ms ?? 0) / 1000)))
  // Sum within each job before taking the median; sums of independent medians can mislead.
  const ready = readers.map((s) =>
    median(s.map(({ result, job }) => (result.metrics.access_ms ?? 0) / 1000 + (setupSeconds(job) ?? 0))),
  )
  const speeds: number[] = []
  for (const { job } of readers[0] ?? []) {
    try {
      const { data } = await github.rest.actions.downloadJobLogsForWorkflowRun({ ...context.repo, job_id: job.id })
      const log = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')
      const speed = cacheDownloadSpeed(log)
      if (speed === undefined)
        core.warning(`No completed cache download speed in job ${job.id}; excluded from speed median.`)
      else speeds.push(speed)
    } catch {
      core.warning(`Could not read cache restore logs for job ${job.id}; download speed unavailable for this sample.`)
    }
  }
  const ghReady = ready[0] ?? null
  const disksReady = ready[1] ?? null
  core.summary.addHeading('Benchmark • StarSling Disks • pnpm store (mastra)')
  if (complete && ghReady !== null && disksReady !== null && ghReady > 0 && disksReady > 0) {
    const saved = ghReady - disksReady
    core.summary.addRaw(
      saved > 0
        ? `<p><strong>Dependencies ready ${ratio(ghReady, disksReady)} faster with StarSling Disks — ${seconds(saved)} saved per warm job (${((saved / ghReady) * 100).toFixed(0)}% less time).</strong></p>\n`
        : `<p><strong>This run did not show a dependency setup speedup with StarSling Disks.</strong></p>\n`,
    )
  } else {
    core.summary.addRaw(
      '<p><strong>Incomplete benchmark — no speedup claim. See successful sample counts below.</strong></p>\n',
    )
  }
  const table: Parameters<typeof Core.summary.addTable>[0] = [
    header([
      'Service',
      'Successful warm jobs',
      'Store size',
      'Time to Access',
      'Average Download Speed',
      'Dependencies ready¹',
    ]),
  ]
  for (const [i, service] of ['GitHub actions/cache', 'StarSling Disks'].entries()) {
    const group = readers[i] ?? []
    const bytes = median(group.map(({ result }) => result.bytes))
    const speed = median(speeds)
    table.push([
      service,
      `${group.length} / 5`,
      bytes === null ? 'N/A' : `${(bytes / 1024 ** 3).toFixed(2)} GiB`,
      seconds(access[i] ?? null),
      i === 1
        ? 'N/A — mounted'
        : speed === null
          ? 'N/A — logs unavailable'
          : `${speed.toFixed(1)} MB/s (${speeds.length}/5 logs)`,
      seconds(ready[i] ?? null),
    ])
  }
  core.summary
    .addTable(table)
    .addRaw(
      '<p>¹ Time to Access plus the Setup pnpm and Install Mastra dependencies steps, summed per job. Durations are medians across successful warm jobs; checkout, Node setup, queueing and benchmark bookkeeping are excluded. Download speed is the median of the final averages reported by actions/cache for compressed archives (MiB/s, labeled MB/s by the action). Mounted disks do not download an archive.</p>\n',
    )
  const sha = process.env.MASTRA_SHA ?? ''
  core.summary.addRaw(
    `<p>Mastra revision: <code>${escapeHtml(sha)}</code>. ${process.env.STARSLING_KEY ? `StarSling store: <code>bench-${escapeHtml(process.env.STARSLING_KEY)}</code>. ` : ''}Private writable mounts; readers never publish. Offline installs consume the store directly.</p>\n`,
  )

  core.summary.addRaw('<details><summary>Every step • GitHub vs StarSling</summary>\n')
  for (const [stage, groups] of [
    ['read', readers],
    ['write', writers],
  ] as const) {
    core.summary.addHeading(
      stage === 'read' ? 'Warm jobs • five readers per service' : 'Cold jobs • one writer per service',
      3,
    )
    const names = new Set(groups.flatMap((s) => s.flatMap(({ job }) => job.steps?.map((step) => step.name) ?? [])))
    const table: Parameters<typeof Core.summary.addTable>[0] = [
      header(['Step', 'GitHub p50 (samples)', 'StarSling p50 (samples)', 'GitHub / StarSling']),
    ]
    for (const name of names) {
      const times = groups.map((s) =>
        s.map(({ job }) => stepSeconds(job, name)).filter((v): v is number => v !== undefined),
      )
      if (!times.some((t) => t.length)) continue
      const medians = times.map((t) => median(t))
      table.push([
        escapeHtml(name),
        ...times.map((t) => (t.length ? `${seconds(median(t))} (n=${t.length})` : '—')),
        ratio(medians[0] ?? null, medians[1] ?? null),
      ])
    }
    core.summary.addTable(table)
  }
  core.summary.addRaw(
    '<p>Actions step timestamps have one-second resolution. A dash means the step did not succeed or does not apply. Zero-second steps have no speed ratio. Only successful, complete jobs enter these tables. Writers on feature branches exercise cold mounts without publishing; warm StarSling readers reuse a published default-branch store at the same Mastra revision.</p>\n</details>\n',
  )
  core.summary.addDetails(
    'Method and scope',
    [
      '<p>Both services use the same frozen Mastra revision and pnpm version on 4-CPU Ubuntu runners. Lifecycle scripts and the global virtual store are disabled; copy imports are identical. This measures dependency preparation, not a complete build.</p>',
      '<p>Time to Access starts immediately before mount/restore and ends after validating the manifest and reading one payload byte. GitHub includes archive download and extraction; StarSling measures mount availability. No full-store scan or materialization runs before install.</p>',
      '<p>Warm readers install offline with a trusted frozen lockfile. Writers populate their stores online. Store integrity checks used by pnpm remain enabled. Disk publication happens after successful default-branch jobs and is not timed. Concurrent readers may contend for storage; results depend on runner hardware and this revision. Failed or incomplete jobs are excluded and fail the benchmark.</p>',
    ].join('\n'),
  )
  core.summary.addDetails(
    'Raw measurements and host metadata',
    `<pre>${escapeHtml(JSON.stringify(results, null, 2))}</pre>`,
  )
  await core.summary.write()
  core.info(`Collected ${results.length} cell artifacts`)
  if (!complete)
    core.setFailed(
      'Incomplete benchmark: expected one successful writer and five successful readers per service, with matching source and setup/install timings. See summary.',
    )
}
