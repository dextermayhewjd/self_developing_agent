import test from 'node:test'
import assert from 'node:assert/strict'
import { transportSchema, decodeResult, validateEvidence } from '../../tools/codex_workflow/schema.mjs'

const contract = {
  type: 'object', required: ['items'], properties: {
    written_file: { type: 'string' },
    items: { type: 'array', minItems: 1, maxItems: 2, items: {
      type: 'object', required: ['verdict'], properties: {
        verdict: { enum: ['确认无误', '未查到'] }, source: { type: 'string' },
      },
    } },
  },
}

test('transport closes nested objects and makes optional fields nullable', () => {
  const encoded = transportSchema(contract)
  assert.equal(encoded.additionalProperties, false)
  assert.deepEqual(encoded.required, ['written_file', 'items'])
  assert.deepEqual(encoded.properties.written_file.anyOf, [{ type: 'string' }, { type: 'null' }])
  const item = encoded.properties.items.items
  assert.equal(item.additionalProperties, false)
  assert.deepEqual(item.properties.verdict, { type: 'string', enum: ['确认无误', '未查到'] })
  assert.equal(encoded.properties.items.minItems, 1)
  assert.equal(encoded.properties.items.maxItems, 2)
  assert.equal(contract.properties.written_file.anyOf, undefined)
})

test('decoding removes optional null without changing required fields', () => {
  assert.deepEqual(decodeResult(contract, { written_file: null, items: [{ verdict: '确认无误', source: null }] }),
    { items: [{ verdict: '确认无误' }] })
  assert.throws(() => decodeResult(contract, { items: [{ verdict: null }] }), /schema/i)
  assert.throws(() => decodeResult(contract, { items: [{ verdict: '大致正确' }] }), /schema/i)
  assert.throws(() => decodeResult(contract, { items: [] }), /schema/i)
  assert.throws(() => decodeResult(contract, { items: [{ verdict: '未查到' }], invented: true }), /schema/i)
})

test('unsupported schema constraints fail before sending a model request', () => {
  assert.throws(() => transportSchema({ type: 'string', pattern: '^x' }), /unsupported.*pattern/i)
})

test('remote benchmark claims require a quote and a real fetch date', () => {
  assert.throws(() => validateEvidence({ items: [{ source: 'https://example.com', strength: '外部·可回溯' }] }), /verbatim/)
  assert.throws(() => validateEvidence({ source: 'https://example.com', strength: '外部·单源未交叉', verbatim: 'quote', fetched_date: '2026-02-30' }), /fetched_date/)
  validateEvidence({ source: '/data/peers.json', strength: '外部·可回溯' })
  validateEvidence({ source: 'https://example.com', strength: '外部·单源未交叉', verbatim: 'quote', fetched_date: '2026-10-15' })
})
