import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs'
import { cpus, release } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'

export interface Measurement {
  stage: string
  service: string
  replica: number
  source: string
  key?: string
  cpu: string
  logical_cpus: number
  kernel: string
  runner: string
  generation?: string
  metrics: Record<string, number>
  complete: boolean
  files?: number
  bytes?: number
}
interface Manifest {
  source: string
  files: { path: string; bytes: number; link?: string }[]
}
const env = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}
const check = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}
const now = () => process.hrtime.bigint()
const elapsed = (start: bigint) => Number(now() - start) / 1e6
const store = env('BENCH_STORE')
const result = env('BENCH_RESULT')
const clock = env('BENCH_CLOCK')
const save = (data: Measurement) => writeFileSync(result, JSON.stringify(data, null, 2))
// Writer inventory runs after install and reads metadata without hashing or copying payloads.
function inventory(dir: string): Manifest['files'] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (/^pnpm\/v\d+\/projects$/.test(relative(store, path))) return []
    if (entry.isSymbolicLink()) return []
    if (entry.isDirectory()) return inventory(path)
    check(entry.isFile(), `Unexpected store entry: ${path}`)
    return [{ path: relative(store, path), bytes: lstatSync(path).size }]
  })
}
function manifest(): Manifest {
  const value: Manifest = JSON.parse(readFileSync(join(store, 'manifest.json'), 'utf8'))
  check(value.source === env('BENCH_SOURCE'), 'Source revision mismatch')
  return value
}
const command = process.argv[2]
if (command === 'start') {
  const service = env('BENCH_SERVICE')
  const key = process.env.BENCH_KEY
  writeFileSync(clock, String(now()))
  save({
    stage: env('BENCH_STAGE'),
    service,
    replica: Number(env('BENCH_REPLICA')),
    source: env('BENCH_SOURCE'),
    ...(key ? { key: service === 'starsling' ? `bench-${key}` : `storage-bench-${key}` } : {}),
    cpu: cpus()[0]?.model ?? 'unknown',
    logical_cpus: cpus().length,
    kernel: release(),
    runner: process.env.RUNNER_NAME ?? 'local',
    metrics: {},
    complete: false,
  })
} else {
  const data: Measurement = JSON.parse(readFileSync(result, 'utf8'))
  if (command === 'access') {
    if (data.service === 'starsling') {
      check(env('DISK_MOUNT') === (data.stage === 'write' ? 'cold' : 'warm'), 'Unexpected disk generation state')
      check(env('DISK_ACCESS') === 'read-write', 'Expected a private writable mount')
      check(env('DISK_PUBLISH') === env('DISK_EXPECT_PUBLISH'), 'Unexpected publication status')
      data.generation = process.env.DISK_GENERATION ?? ''
    }
    if (data.stage === 'read') {
      const value = manifest()
      const first = value.files.find((entry) => entry.link === undefined && entry.bytes > 0)
      if (!first) throw new Error('Empty manifest')
      check(!isAbsolute(first.path) && !first.path.split(sep).includes('..'), 'Unsafe manifest path')
      const fd = openSync(join(store, first.path), 'r')
      try {
        check(readSync(fd, Buffer.alloc(1)) === 1, 'First content file is empty')
      } finally {
        closeSync(fd)
      }
      data.metrics.access_ms = elapsed(BigInt(readFileSync(clock, 'utf8')))
      data.files = value.files.length
      data.bytes = value.files.reduce((sum, file) => sum + file.bytes, 0)
    } else {
      mkdirSync(store, { recursive: true })
      check(readdirSync(store).length === 0, 'Writer must begin with an empty store')
      data.metrics.empty_store_ready_ms = elapsed(BigInt(readFileSync(clock, 'utf8')))
    }
  } else if (command === 'inventory') {
    const start = now()
    const files = inventory(join(store, 'pnpm')).sort((a, b) => b.bytes - a.bytes)
    const bytes = files.reduce((sum, file) => sum + file.bytes, 0)
    check(bytes > 0, 'Empty pnpm store')
    writeFileSync(join(store, 'manifest.json'), JSON.stringify({ source: data.source, files }))
    data.metrics.inventory_ms = elapsed(start)
    Object.assign(data, { files: files.length, bytes, complete: true })
  } else if (command === 'finish') {
    check(data.stage === 'read' && data.metrics.access_ms !== undefined, 'Missing reader access measurement')
    // Invoked only after pnpm's offline install succeeds; pnpm validates the packages it consumes.
    data.complete = true
  } else {
    throw new Error(`Unknown command: ${command}`)
  }
  save(data)
}
