import Ajv from 'ajv'

const ajv = new Ajv({ allErrors: true, strict: false })
const keys = new Set(['type', 'description', 'enum', 'properties', 'required', 'items', 'minItems', 'maxItems', 'additionalProperties'])

function typed(schema) {
  const copy = { ...schema }
  if (!copy.type && copy.enum?.every(v => typeof v === 'string')) copy.type = 'string'
  if (!['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(copy.type)) {
    throw new Error(`Unsupported schema type: ${copy.type}`)
  }
  for (const key of Object.keys(copy)) {
    if (!keys.has(key)) throw new Error(`Unsupported schema constraint: ${key}`)
  }
  return copy
}

export function transportSchema(schema) {
  const out = typed(schema)
  if (out.type === 'object') {
    const required = new Set(out.required ?? [])
    out.properties = Object.fromEntries(Object.entries(out.properties ?? {}).map(([key, value]) => {
      const child = transportSchema(value)
      return [key, required.has(key) ? child : { anyOf: [child, { type: 'null' }] }]
    }))
    out.required = Object.keys(out.properties)
    out.additionalProperties = false
  } else if (out.type === 'array') {
    out.items = transportSchema(out.items)
  }
  return out
}

function originalSchema(schema) {
  const out = typed(schema)
  if (out.type === 'object') {
    out.additionalProperties = false
    out.properties = Object.fromEntries(Object.entries(out.properties ?? {}).map(([k, v]) => [k, originalSchema(v)]))
  } else if (out.type === 'array') out.items = originalSchema(out.items)
  return out
}

function stripOptionalNull(schema, value) {
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const required = new Set(schema.required ?? [])
    return Object.fromEntries(Object.entries(value)
      .filter(([k, v]) => !(v === null && schema.properties?.[k] && !required.has(k)))
      .map(([k, v]) => [k, schema.properties?.[k] ? stripOptionalNull(schema.properties[k], v) : v]))
  }
  if (schema.type === 'array' && Array.isArray(value)) return value.map(v => stripOptionalNull(schema.items, v))
  return value
}

export function decodeResult(schema, value) {
  const out = stripOptionalNull(schema, value)
  const validate = ajv.compile(originalSchema(schema))
  if (!validate(out)) throw new Error(`Result schema mismatch: ${ajv.errorsText(validate.errors)}`)
  return out
}

export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function validateEvidence(value) {
  if (!value || typeof value !== 'object') return
  if (typeof value.source === 'string' && /https?:\/\//.test(value.source) && typeof value.strength === 'string') {
    if (!value.verbatim?.trim()) throw new Error('Remote evidence requires verbatim quotation')
    if (!validDate(value.fetched_date)) throw new Error('Remote evidence requires valid fetched_date')
  }
  for (const child of Object.values(value)) validateEvidence(child)
}
