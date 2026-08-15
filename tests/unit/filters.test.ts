import assert from 'node:assert/strict'
import test from 'node:test'
import { buildIndexPlan } from '../../src/providers/meilisearch/utils/definition'
import { buildFilterExpression, extractPrimaryKeyIds } from '../../src/providers/meilisearch/utils/filters'
import { OPTIONS, productDefinition } from '../helpers'

const plan = buildIndexPlan(productDefinition(), OPTIONS)
const compile = (filters: Parameters<typeof buildFilterExpression>[0]) => buildFilterExpression(filters, plan)

test('compiles equality, membership and ranges', () => {
  assert.equal(compile({ status: 'published' }), 'status = "published"')
  assert.equal(compile({ id: ['a', 'b'] }), 'id IN ["a", "b"]')
  assert.equal(compile({ price: { $gte: 10 } }), 'price >= 10')
  assert.equal(compile({ price: { $lt: 50 } }), 'price < 50')
  assert.equal(compile({ id: { $nin: ['a'] } }), 'NOT id IN ["a"]')
})

test('compiles null and existence checks', () => {
  assert.equal(compile({ status: null }), 'status IS NULL')
  assert.equal(compile({ status: { $ne: null } }), 'status IS NOT NULL')
  assert.equal(compile({ status: { $exists: true } }), 'status EXISTS')
  assert.equal(compile({ status: { $exists: false } }), 'NOT status EXISTS')
})

test('compiles a date onto its shadow, from a string or a Date', () => {
  const expected = 'created_at__ts > 1704164645000'

  assert.equal(compile({ created_at: { $gt: '2024-01-02T03:04:05Z' } }), expected)
  assert.equal(compile({ created_at: { $gt: new Date('2024-01-02T03:04:05Z') } }), expected)
})

test('quotes values so one cannot change the shape of the expression', () => {
  assert.equal(compile({ title: 'a " OR b' }), 'title = "a \\" OR b"')
  assert.equal(compile({ title: 'x AND y' }), 'title = "x AND y"')
})

test('composes boolean groups', () => {
  assert.equal(
    compile({ $or: [{ status: 'published' }, { $and: [{ price: { $gt: 5 } }, { id: 'x' }] }] }),
    '(status = "published" OR (price > 5 AND id = "x"))',
  )
  assert.equal(compile({ $not: { status: 'draft' } }), 'NOT status = "draft"')
})

test('constrains nothing when there is nothing to constrain', () => {
  assert.equal(compile({}), undefined)
  assert.equal(compile(undefined), undefined)
})

test('refuses operators Meilisearch cannot answer, rather than answering differently', () => {
  assert.throws(() => compile({ title: { $like: '%shirt%' } }), /\$like/)
  assert.throws(() => compile({ price: { $gt: 'abc' } }), /non-numeric/)
})

test('refuses an unknown operator instead of reading it as a field', () => {
  assert.throws(() => compile({ title: { $regex: 'x' } }), /Unsupported filter operator/)
  assert.throws(() => compile({ $nope: 'x' }), /Unsupported filter operator/)
})

test('recognises a delete that is nothing but primary-key membership', () => {
  assert.deepEqual(extractPrimaryKeyIds({ id: ['a', 'b'] }, 'id'), ['a', 'b'])
  assert.deepEqual(extractPrimaryKeyIds({ id: { $in: ['a'] } }, 'id'), ['a'])
  assert.deepEqual(extractPrimaryKeyIds({ id: 'a' }, 'id'), ['a'])
})

test('declines a partial match, which would delete more than it selects', () => {
  assert.equal(extractPrimaryKeyIds({ id: ['a'], status: 'x' }, 'id'), undefined)
  assert.equal(extractPrimaryKeyIds({ id: { $in: ['a'], $ne: 'b' } }, 'id'), undefined)
  assert.equal(extractPrimaryKeyIds({ status: 'x' }, 'id'), undefined)
  assert.equal(extractPrimaryKeyIds({ id: { $gt: 'a' } }, 'id'), undefined)
})
