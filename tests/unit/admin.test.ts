import { SearchTypes } from '@medusajs/types'
import assert from 'node:assert/strict'
import test from 'node:test'
import { describeIndex, PRODUCT_UPDATED_EVENT, reindexEntity, resolveIndexName } from '../../src/api/utils/admin'

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

  assert.deepEqual(info, { name: 'product', document_count: 128, error: null })
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
