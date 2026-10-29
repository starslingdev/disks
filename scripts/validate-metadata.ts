import { readFile, readdir } from 'node:fs/promises'
import { Ajv, type AnySchema } from 'ajv'
import { parse } from 'yaml'

// Pin upstream schemas so CI does not change when SchemaStore's default branch changes.
const schemaRoot =
  'https://raw.githubusercontent.com/SchemaStore/schemastore/5d7f3f28ac1b5eee854c577d3901a6c056ce93f7/src/schemas/json'
const workflows = (await readdir('.github/workflows'))
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => `.github/workflows/${file}`)
const ajv = new Ajv({ allErrors: true, strict: false })

for (const [schema, files] of [
  ['github-action', ['action.yml']],
  ['github-workflow', workflows],
] as const) {
  const response = await fetch(`${schemaRoot}/${schema}.json`)
  if (!response.ok) throw new Error(`Cannot load ${schema}: HTTP ${response.status}`)
  const validate = ajv.compile((await response.json()) as AnySchema)
  for (const file of files) {
    const document = parse(await readFile(file, 'utf8')) as unknown
    if (!validate(document)) throw new Error(`${file}: ${ajv.errorsText(validate.errors, { separator: '\n' })}`)
    console.log(`${file}: valid`)
  }
}
