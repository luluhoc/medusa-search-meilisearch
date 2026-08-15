import { SearchTypes } from '@medusajs/types'
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildIndexPlan } from '../../src/providers/meilisearch/utils/definition'
import { planSearch } from '../../src/providers/meilisearch/utils/search'
import { OPTIONS, productDefinition, providerQuery } from '../helpers'

const plan = buildIndexPlan(productDefinition(), OPTIONS)

test('builds a single query for a plain search', () => {
  const planned = planSearch(providerQuery({ q: 'shirt' }), plan)

  assert.equal(planned.queries.length, 1)
  assert.equal(planned.queries[0].indexUid, 'product')
  assert.equal(planned.queries[0].q, 'shirt')
  assert.equal(planned.queries[0].offset, 0)
  assert.equal(planned.queries[0].limit, 20)
})

test('always fetches the primary key, so a hit can be identified', () => {
  const planned = planSearch(providerQuery({ attributes_to_retrieve: ['title'] }), plan)

  assert.deepEqual(planned.queries[0].attributesToRetrieve, ['id', 'title'])
})

test('sorts on the shadow of a date, and treats _score as the default order', () => {
  const planned = planSearch(
    providerQuery({ pagination: { skip: 0, take: 20, order: { created_at: 'DESC', title: 'ASC' } } }),
    plan,
  )

  assert.deepEqual(planned.queries[0].sort, ['created_at__ts:desc', 'title:asc'])

  const relevance = planSearch(providerQuery({ pagination: { skip: 0, take: 20, order: { _score: 'DESC' } } }), plan)

  assert.equal(relevance.queries[0].sort, undefined)
})

test('asks for a query per range bucket, batched with the hits', () => {
  const planned = planSearch(
    providerQuery({
      filters: { status: 'published' },
      search_options: {
        facets: [
          {
            field: 'price',
            type: 'range',
            ranges: [
              { from: 0, to: 50 },
              { key: 'high', from: 50 },
            ],
          },
        ],
      },
    }),
    plan,
  )

  assert.equal(planned.queries.length, 3)
  assert.equal(planned.queries[1].filter, 'status = "published" AND price >= 0 AND price < 50')
  assert.equal(planned.queries[2].filter, 'status = "published" AND price >= 50')
})

test('asks for an extra query when an exact count is wanted', () => {
  const planned = planSearch(providerQuery({ search_options: { count: 'exact' } }), plan)

  assert.equal(planned.queries.length, 2)
  assert.equal(planned.queries[1].hitsPerPage, 1, 'Meilisearch only counts exhaustively when paging by page')
})

test('assembles hits, scores and highlights', () => {
  const planned = planSearch(
    providerQuery({
      q: 'shirt',
      search_options: { include_score: true, highlight: { fields: ['title'] } },
    }),
    plan,
  )

  const result = planned.build([
    {
      hits: [{ id: 'prod_1', title: 'Shirt', price: 10, _rankingScore: 0.8, _formatted: { title: '<em>Shirt</em>' } }],
      estimatedTotalHits: 42,
      processingTimeMs: 3,
    },
  ] as unknown as Parameters<typeof planned.build>[0])

  assert.deepEqual(result.hits, [
    {
      id: 'prod_1',
      score: 0.8,
      document: { title: 'Shirt', price: 10 },
      highlights: { title: ['<em>Shirt</em>'] },
    },
  ])
  assert.equal(result.metadata.count, 42)
  assert.equal(result.metadata.query, 'shirt')
})

test('orders value facets by count, breaking ties on the value so a limit is stable', () => {
  const planned = planSearch(
    providerQuery({ search_options: { facets: [{ field: 'status', type: 'value', limit: 2 }] } }),
    plan,
  )

  const result = planned.build([
    {
      hits: [],
      estimatedTotalHits: 0,
      processingTimeMs: 1,
      facetDistribution: { status: { draft: 3, published: 7, proposed: 3 } },
    },
  ] as unknown as Parameters<typeof planned.build>[0])

  assert.deepEqual(result.facets?.status, {
    type: 'value',
    values: [
      { value: 'published', count: 7 },
      { value: 'draft', count: 3 },
    ],
    other_count: 3,
  })
})

test('reads each range bucket from its own count query', () => {
  const planned = planSearch(
    providerQuery({
      search_options: {
        facets: [
          {
            field: 'price',
            type: 'range',
            ranges: [
              { from: 0, to: 50 },
              { key: 'high', from: 50 },
            ],
          },
        ],
      },
    }),
    plan,
  )

  const result = planned.build([
    { hits: [], estimatedTotalHits: 0, processingTimeMs: 1 },
    { totalHits: 4 },
    { totalHits: 6 },
  ] as unknown as Parameters<typeof planned.build>[0])

  assert.deepEqual(result.facets?.price, {
    type: 'range',
    ranges: [
      { key: '0-50', from: 0, to: 50, count: 4 },
      { key: 'high', from: 50, to: undefined, count: 6 },
    ],
  })
})

test('reports a stats facet from facetStats plus a count of its own', () => {
  const planned = planSearch(providerQuery({ search_options: { facets: [{ field: 'price', type: 'stats' }] } }), plan)

  const result = planned.build([
    { hits: [], estimatedTotalHits: 0, processingTimeMs: 1, facetStats: { price: { min: 5, max: 99 } } },
    { totalHits: 9 },
  ] as unknown as Parameters<typeof planned.build>[0])

  assert.deepEqual(result.facets?.price, { type: 'stats', min: 5, max: 99, count: 9 })
})

test('refuses what Meilisearch would answer differently', () => {
  const refusals: [string, SearchTypes.ProviderSearchQuery, RegExp][] = [
    ['a cursor', providerQuery({ pagination: { cursor: 'x' } }), /cursor/],
    ['a per-query typo toggle', providerQuery({ search_options: { typo_tolerance: false } }), /typo tolerance/],
    ['match_strategy any', providerQuery({ search_options: { match_strategy: 'any' } }), /"any" matching strategy/],
    [
      'two facets on one field',
      providerQuery({
        search_options: {
          facets: [
            { field: 'price', type: 'stats' },
            { field: 'price', type: 'value' },
          ],
        },
      }),
      /more than one facet/,
    ],
  ]

  for (const [name, query, message] of refusals) {
    assert.throws(() => planSearch(query, plan), message, name)
  }
})

test('refuses free text against an index with nothing searchable', () => {
  const bare = buildIndexPlan(productDefinition({ fields: { id: { type: 'keyword', filterable: true } } }), OPTIONS)

  assert.throws(() => planSearch(providerQuery({ q: 'shirt' }, productDefinition()), bare), /no searchable fields/)
})
