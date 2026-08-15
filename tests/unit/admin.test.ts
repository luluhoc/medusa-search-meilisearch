import { SearchTypes } from '@medusajs/types'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  describeCoverage,
  describeIndex,
  PRODUCT_UPDATED_EVENT,
  reindexEntity,
  resolveIndexName,
  searchIndexed,
} from '../../src/api/utils/admin'
import { registerLocalizedIndex } from '../../src/indexes/locales'

test('falls back to the product index, which is what the product widget asks for', () => {
  assert.equal(resolveIndexName(['category', 'product']), 'product')
})

test('falls back to the first declared index when no index is named "product"', () => {
  assert.equal(resolveIndexName(['product_fr', 'category']), 'product_fr')
})

test('takes a named index as given, once it is one the module actually loaded', () => {
  assert.equal(resolveIndexName(['product', 'product_fr'], 'product_fr'), 'product_fr')
})

test('names the declared indexes when asked for one that does not exist', () => {
  assert.throws(() => {
    return resolveIndexName(['product', 'category'], 'products')
  }, /Unknown search index "products".*product, category/s)
})

test('says so when nothing is declared, rather than reporting an empty index', () => {
  assert.throws(() => {
    return resolveIndexName([], 'product')
  }, /No search index is declared/)
})

test('reports an index Meilisearch cannot answer for instead of failing the listing', async () => {
  const search = {
    search: async () => {
      throw new Error('Index `product` not found.')
    },
  } as unknown as SearchTypes.ISearchModuleService

  assert.deepEqual(await describeIndex(search, 'product'), {
    name: 'product',
    locale: null,
    entity: null,
    document_count: null,
    error: 'Index `product` not found.',
  })
})

test('counts an index exhaustively, since an estimate is not an answer for an admin', async () => {
  const queries: SearchTypes.SearchQuery[] = []
  const search = {
    search: async (query: SearchTypes.SearchQuery) => {
      queries.push(query)

      return { hits: [], metadata: { skip: 0, take: 0, count: 128 } }
    },
  } as unknown as SearchTypes.ISearchModuleService
  const info = await describeIndex(search, 'product')

  assert.deepEqual(info, { name: 'product', locale: null, entity: null, document_count: 128, error: null })
  assert.equal(queries[0].search_options?.count, 'exact')
  assert.equal(queries[0].pagination?.take, 0)
})

test('reindexes one product by routing its update event, so a stale document is removed and not just rewritten', async () => {
  const ingested: string[] = []
  const search = {
    ingest: async (event: { name: string }) => {
      ingested.push(event.name)

      return [{ id: '1', status: 'succeeded' }]
    },
    reindex: async () => {
      throw new Error('should not seed when the event was routed')
    },
  } as unknown as SearchTypes.ISearchModuleService

  await reindexEntity(search, { index: 'product', id: 'prod_1', event: PRODUCT_UPDATED_EVENT })

  assert.deepEqual(ingested, ['product.updated'])
})

test('seeds just this id when no index consumes the event, which a custom event list can cause', async () => {
  const seeded: SearchTypes.SearchReindexInput[] = []
  const search = {
    ingest: async () => {
      return []
    },
    reindex: async (input: SearchTypes.SearchReindexInput) => {
      seeded.push(input)

      return { job_id: 'job_1', indexes: ['product'] }
    },
  } as unknown as SearchTypes.ISearchModuleService

  await reindexEntity(search, { index: 'product', id: 'prod_1', event: PRODUCT_UPDATED_EVENT })

  assert.deepEqual(seeded, [{ index: 'product', strategy: 'in_place', filters: { id: 'prod_1' } }])
})

test('answers for every index holding products, so a language that is missing one is visible', async () => {
  registerLocalizedIndex({ index: 'produits', base: 'product', entity: 'product', locale: 'fr-FR' })

  const search = {
    listIndexes: () => {
      return ['product', 'produits', 'category']
    },
    search: async (query: SearchTypes.SearchQuery) => {
      return {
        hits:
          query.entity === 'product'
            ? [{ id: 'prod_1', document: { id: 'prod_1', updated_at: '2024-01-01T00:00:00.000Z' } }]
            : [],
        metadata: { skip: 0, take: 1, count: null },
      }
    },
  } as unknown as SearchTypes.ISearchModuleService

  assert.deepEqual(await describeCoverage(search, { entity: 'product', base: 'product', id: 'prod_1' }), {
    id: 'prod_1',
    entries: [
      { index: 'product', locale: null, indexed: true, updated_at: '2024-01-01T00:00:00.000Z', error: null },
      { index: 'produits', locale: 'fr-FR', indexed: false, updated_at: null, error: null },
    ],
  })
})

test('reports an index that cannot be read without hiding the languages that can', async () => {
  const search = {
    listIndexes: () => {
      return ['product', 'product-de-DE']
    },
    search: async (query: SearchTypes.SearchQuery) => {
      if (query.entity === 'product-de-DE') {
        throw new Error('Index `product-de-DE` not found.')
      }

      return { hits: [{ id: 'prod_1', document: { id: 'prod_1' } }], metadata: { skip: 0, take: 1, count: null } }
    },
  } as unknown as SearchTypes.ISearchModuleService
  const { entries } = await describeCoverage(search, { entity: 'product', base: 'product', id: 'prod_1' })

  assert.equal(entries[0].indexed, true)
  assert.deepEqual(entries[1], {
    index: 'product-de-DE',
    locale: null,
    indexed: false,
    updated_at: null,
    error: 'Index `product-de-DE` not found.',
  })
})

test('dates an indexed copy from the document, and says nothing when the definition does not index the field', async () => {
  const search = {
    listIndexes: () => {
      return ['product']
    },
    search: async () => {
      return { hits: [{ id: 'prod_1', document: { id: 'prod_1' } }], metadata: { skip: 0, take: 1, count: null } }
    },
  } as unknown as SearchTypes.ISearchModuleService
  const { entries } = await describeCoverage(search, { entity: 'product', base: 'product', id: 'prod_1' })

  assert.equal(entries[0].indexed, true)
  assert.equal(entries[0].updated_at, null)
})

test('asks where a product placed in the same round trip as the page of hits', async () => {
  const calls: SearchTypes.SearchQuery[][] = []
  const search = {
    searchMany: async (queries: SearchTypes.SearchQuery[]) => {
      calls.push(queries)

      return [
        {
          hits: [{ id: 'prod_2', score: 0.9, document: { id: 'prod_2', title: 'Shirt' } }],
          metadata: { skip: 0, take: 1, count: 3, processing_time_ms: 4 },
        },
        {
          hits: [
            { id: 'prod_2', document: {} },
            { id: 'prod_1', document: {} },
          ],
          metadata: { skip: 0, take: 50, count: null },
        },
      ]
    },
  } as unknown as SearchTypes.ISearchModuleService

  const result = await searchIndexed(search, {
    index: 'product',
    query: 'shirt',
    limit: 1,
    offset: 0,
    find: 'prod_1',
    scan: 50,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 2)
  assert.deepEqual(result.hits, [{ id: 'prod_2', score: 0.9, document: { id: 'prod_2', title: 'Shirt' } }])
  assert.equal(result.count, 3)
  assert.equal(result.processing_time_ms, 4)
  assert.deepEqual(result.rank, { id: 'prod_1', position: 2, scanned: 2, exhausted: true })
})

test('scans nothing when no id was asked about, so a plain search stays one query', async () => {
  const calls: SearchTypes.SearchQuery[][] = []
  const search = {
    searchMany: async (queries: SearchTypes.SearchQuery[]) => {
      calls.push(queries)

      return [{ hits: [], metadata: { skip: 0, take: 10, count: 0 } }]
    },
  } as unknown as SearchTypes.ISearchModuleService

  const result = await searchIndexed(search, { index: 'product', query: 'shirt', limit: 10, offset: 0, scan: 200 })

  assert.equal(calls[0].length, 1)
  assert.equal(result.rank, null)
})

test('separates a product that does not match from one that is only buried', async () => {
  const search = {
    searchMany: async () => {
      return [
        { hits: [], metadata: { skip: 0, take: 10, count: 2 } },
        {
          hits: [
            { id: 'prod_2', document: {} },
            { id: 'prod_3', document: {} },
          ],
          metadata: { skip: 0, take: 2, count: null },
        },
      ]
    },
  } as unknown as SearchTypes.ISearchModuleService

  const result = await searchIndexed(search, {
    index: 'product',
    query: 'shirt',
    limit: 10,
    offset: 0,
    find: 'prod_1',
    scan: 2,
  })

  // The scan came back full, so the result set was not seen to its end: the
  // product may still match, further down than anyone was asked to look.
  assert.deepEqual(result.rank, { id: 'prod_1', position: null, scanned: 2, exhausted: false })
})
