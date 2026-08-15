import assert from 'node:assert/strict'
import test from 'node:test'
import { fromMeilisearchHit, toMeilisearchDocument } from '../../src/providers/meilisearch/utils/documents'

test('shadows a date value with epoch milliseconds', () => {
  const document = toMeilisearchDocument({
    id: 'prod_1',
    created_at: new Date('2024-01-02T03:04:05Z'),
    updated_at: '2024-02-03T04:05:06.000Z',
  })

  assert.equal(document.created_at__ts, 1704164645000)
  assert.equal(document.updated_at__ts, 1706933106000)
})

test('leaves the original value untouched, so a read is lossless', () => {
  const created = new Date('2024-01-02T03:04:05Z')
  const document = toMeilisearchDocument({ id: 'prod_1', created_at: created })

  assert.equal(document.created_at, created)
})

test('does not treat a date without a time as a date', () => {
  const document = toMeilisearchDocument({ id: 'prod_1', sku: '2024-01-01' })

  assert.ok(!('sku__ts' in document))
})

test('shadows dates nested inside arrays of objects', () => {
  const document = toMeilisearchDocument({
    id: 'prod_1',
    variants: [{ id: 'v1', released_at: '2024-03-04T05:06:07Z' }],
  })

  const variants = document.variants as { released_at__ts: number }[]

  assert.equal(variants[0].released_at__ts, 1709528767000)
})

test('shadows an array of dates, but not a partly-dated one', () => {
  const dated = toMeilisearchDocument({ id: 'p', dates: ['2024-01-02T03:04:05Z', '2024-01-03T03:04:05Z'] })
  const mixed = toMeilisearchDocument({ id: 'p', dates: ['2024-01-02T03:04:05Z', 'not a date'] })

  assert.deepEqual(dated.dates__ts, [1704164645000, 1704251045000])
  assert.ok(!('dates__ts' in mixed), 'a half-shadowed array would filter as though entries were absent')
})

test('strips shadows and engine metadata from a hit', () => {
  const document = fromMeilisearchHit(
    {
      id: 'prod_1',
      title: 'Shirt',
      created_at: '2024-01-02T03:04:05Z',
      created_at__ts: 1704164645000,
      variants: [{ id: 'v1', released_at__ts: 1 }],
      _formatted: { title: '<em>Shirt</em>' },
      _rankingScore: 0.9,
      _vectors: { default: [0.1] },
    },
    { retrieved: ['title', 'created_at', 'variants.id'], primaryKey: 'id' },
  )

  assert.deepEqual(document, {
    title: 'Shirt',
    created_at: '2024-01-02T03:04:05Z',
    variants: [{ id: 'v1' }],
  })
})

test('keeps the primary key only when it was asked for', () => {
  const hit = { id: 'prod_1', title: 'Shirt' }

  assert.ok(!('id' in fromMeilisearchHit(hit, { retrieved: ['title'], primaryKey: 'id' })))
  assert.ok('id' in fromMeilisearchHit(hit, { retrieved: ['id', 'title'], primaryKey: 'id' }))
})
