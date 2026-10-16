import { createHash } from 'node:crypto'

const string = { type: 'string' }
const strings = { type: 'array', items: string }
const enumeration = values => ({ type: 'string', enum: values })
const object = (properties, optional = []) => ({
  type: 'object', additionalProperties: false,
  required: Object.keys(properties).filter(key => !optional.includes(key)), properties,
})
const array = (items, bounds = {}) => ({ type: 'array', items, ...bounds })
const digest = { type: 'string', description: 'Lowercase SHA-256 of raw bytes, or canonicalJson for structured objects.' }
const section = { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }
const kind = enumeration(['blocking', 'disclosure', 'watch'])
export const REVIEW_LENSES = Object.freeze(['财务排雷', '尽调', '产业', '竞争', '战略驱动'])

export const EVIDENCE_REF_SCHEMA = object({
  source: string, source_sha256: digest, evidence_sha256: digest, quote: string,
  transcript_path: string, transcript_sha256: digest,
}, ['transcript_path', 'transcript_sha256'])

export const VISUAL_ATTESTATION_SCHEMA = object({
  source: string, source_sha256: digest, transcript_path: string, transcript_sha256: digest,
  method: enumeration(['visual']), status: enumeration(['verified', 'mismatch']), reason: string,
})

export const TRANSCRIPT_SCHEMA = object({
  version: { type: 'integer', enum: [2] }, source: string, source_sha256: digest,
  text: string, method: enumeration(['ocr', 'model', 'manual']),
})

const links = { issue_keys: strings, task_ids: strings }
const issue = object({
  issue_key: string, kind, blocks_delivery: { type: 'boolean' }, description: string,
  locations: array(object({ section, quote: string }, ['quote']), { minItems: 1 }),
  evidence_refs: array(EVIDENCE_REF_SCHEMA),
  acceptance_criteria: array(string, { minItems: 1 }),
  judgment_constraints: array(object({ section, quote: string })),
  route: enumeration(['local_patch', 'full_revision', 'needs_evidence']),
}, ['judgment_constraints'])

export const REVIEW_SCHEMA = object({
  version: { type: 'integer', enum: [2] }, review_id: string,
  report_sha256: digest, evidence_sha256: digest, input_ledger_sha256: digest,
  written_file: string, verdict: enumeration(['pass', 'revise']),
  reviewed_sources: { ...strings, minItems: 1 },
  sections: array(object({ section, status: enumeration(['pass', 'revise']), evidence: string, ...links }, ['issue_keys', 'task_ids']), { minItems: 12, maxItems: 12 }),
  coverage: array(object({
    lens: enumeration(REVIEW_LENSES),
    findings: array(object({
      finding: string, source: string, source_quote: string,
      disposition: enumeration(['covered', 'excluded', 'omitted', 'contradicted']),
      report_quote: string, exclusion_reason: string, ...links,
    }, ['issue_keys', 'task_ids']), { minItems: 1 }),
  }), { minItems: 5, maxItems: 5 }),
  new_issues: array(issue),
  task_dispositions: array(object({ task_id: string, status: enumeration(['open', 'resolved']), reason: string, kind, blocks_delivery: { type: 'boolean' } })),
  visual_attestations: array(VISUAL_ATTESTATION_SCHEMA),
}, ['written_file'])

export const PROPOSAL_SCHEMA = object({
  task_ids: { ...strings, minItems: 1 }, base_report_sha256: digest,
  status: enumeration(['proposed', 'needs_evidence', 'escalate']),
  edits: array(object({ section, before: string, after: string, rationale: string, task_ids: { ...strings, minItems: 1 } })),
  evidence_refs: array(EVIDENCE_REF_SCHEMA),
  acceptance_checks: array(object({ task_id: string, criterion_index: { type: 'integer' }, response: string })),
  escalation_reason: string,
})

/** Deterministic JSON for JSON-only values; rejects lossy or ambiguous serialization. */
export function canonicalJson(value) {
  const ancestors = new Set()
  function encode(current) {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current)
    if (typeof current === 'number' && Number.isFinite(current)) return JSON.stringify(current)
    if (typeof current !== 'object' || ancestors.has(current)) throw new TypeError('Expected acyclic JSON value')
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) throw new TypeError('Expected plain JSON object')
    if (Object.getOwnPropertySymbols(current).length) throw new TypeError('JSON cannot contain symbol keys')
    ancestors.add(current)
    let result
    if (Array.isArray(current)) {
      const values = []
      for (let i = 0; i < current.length; i++) {
        if (!Object.hasOwn(current, i)) throw new TypeError('JSON cannot contain sparse arrays')
        values.push(encode(current[i]))
      }
      result = `[${values.join(',')}]`
    } else result = `{${Object.keys(current).sort().map(key => `${JSON.stringify(key)}:${encode(current[key])}`).join(',')}}`
    ancestors.delete(current)
    return result
  }
  return encode(value)
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
