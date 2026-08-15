/**
 * Exercises the provider against a real Meilisearch, through the exact contract
 * the Search Module calls it by. Skipped unless MEILISEARCH_TEST_HOST is set:
 *
 *   docker run --rm -p 7700:7700 -e MEILI_MASTER_KEY=ms getmeili/meilisearch:latest
 *   MEILISEARCH_TEST_HOST=http://127.0.0.1:7700 MEILISEARCH_TEST_API_KEY=ms yarn test:integration
 */
import { SearchTypes } from '@medusajs/types'
import assert from 'node:assert/strict'
import test from 'node:test'
import { MeilisearchSearchProviderService } from '../../src/providers/meilisearch/service'

const host = process.env.MEILISEARCH_TEST_HOST

// A name of its own, so a run cannot touch an index a developer cares about.
const INDEX = 'medusa_search_meilisearch_test'
const SHADOW = `${INDEX}_deadbeef`

const definition: SearchTypes.ResolvedSearchIndexDefinition = {
  name: 'product',
  entity: 'product',
  primary_key: 'id',
  provider: 'meilisearch',
  physical_name: INDEX,
  definition_hash: 'deadbeefdeadbeef',
  fields: {
    id: { type: 'keyword', filterable: true },
    title: { type: 'text', searchable: { weight: 5 }, sortable: true },
    description: { type: 'text', searchable: true },
    internal_note: { type: 'text', searchable: true, retrievable: false },
    status: { type: 'keyword', filterable: true, facetable: true },
    tags: { type: 'keyword', array: true, filterable: true, facetable: true },
    price: { type: 'float', filterable: true, sortable: true, facetable: { types: ['value', 'range', 'stats'] } },
    created_at: { type: 'date', filterable: true, sortable: true },
    variants: {
      type: 'object',
      array: true,
      fields: {
        id: { type: 'keyword', filterable: true },
        sku: { type: 'keyword', filterable: true, searchable: { weight: 3 } },
      },
    },
  },
  settings: {
    synonyms: { tee: ['t-shirt'] },
    stop_words: ['the'],
    faceting: { max_values_per_facet: 100, sort_by: 'count' },
    pagination: { max_total_hits: 10000 },
  },
  seed: async function* () {},
}

const documents: SearchTypes.SearchDocument[] = [
  {
    id: 'prod_1',
    title: 'Red t-shirt',
    description: 'A comfortable cotton shirt',
    internal_note: 'do not show this',
    status: 'published',
    tags: ['summer', 'cotton'],
    price: 25,
    created_at: new Date('2024-01-15T10:00:00Z'),
    variants: [
      { id: 'v1', sku: 'RED-S' },
      { id: 'v2', sku: 'RED-M' },
    ],
  },
  {
    id: 'prod_2',
    title: 'Blue hoodie',
    description: 'A warm hoodie',
    internal_note: 'secret',
    status: 'published',
    tags: ['winter', 'cotton'],
    price: 75,
    created_at: new Date('2024-06-20T10:00:00Z'),
    variants: [{ id: 'v3', sku: 'BLU-L' }],
  },
  {
    id: 'prod_3',
    title: 'Green cap',
    description: 'A summer cap',
    internal_note: 'secret',
    status: 'draft',
    tags: ['summer'],
    price: 15,
    created_at: new Date('2023-11-05T10:00:00Z'),
    variants: [],
  },
]

const RETRIEVED = ['id', 'title', 'description', 'status', 'tags', 'price', 'created_at', 'variants.id', 'variants.sku']

test('Meilisearch provider', { skip: host ? false : 'MEILISEARCH_TEST_HOST is not set' }, async (t) => {
  const service = new MeilisearchSearchProviderService(
    {},
    { config: { host: host!, apiKey: process.env.MEILISEARCH_TEST_API_KEY } },
  )

  const search = async (input: Partial<SearchTypes.ProviderSearchQuery> = {}) => {
    return service.search({
      index: definition,
      attributes_to_retrieve: RETRIEVED,
      pagination: { skip: 0, take: 20 },
      ...input,
    })
  }

  const ids = (result: SearchTypes.SearchResult) => {
    return result.hits.map((hit) => hit.id).sort()
  }

  t.before(async () => {
    for (const index of [INDEX, SHADOW]) {
      await service.waitForTask(await service.deleteIndex({ index })).catch(() => undefined)
    }

    await service.waitForTask(await service.upsertIndex({ index: definition }))
    await service.waitForTask(await service.upsertDocuments({ index: INDEX, documents }))
  })

  t.after(async () => {
    for (const index of [INDEX, SHADOW]) {
      await service.deleteIndex({ index }).catch(() => undefined)
    }
  })

  await t.test('applies the settings derived from the definition', async () => {
    const settings = await service['client_'].index(INDEX).getSettings()

    assert.deepEqual(settings.searchableAttributes, ['title', 'variants.sku', 'description', 'internal_note'])
    assert.ok(settings.filterableAttributes?.includes('created_at__ts'))
    assert.ok(settings.sortableAttributes?.includes('created_at__ts'))
    assert.ok(!settings.displayedAttributes?.includes('internal_note'))
    assert.deepEqual(settings.synonyms, { tee: ['t-shirt'] })
  })

  await t.test('reports index names and document counts', async () => {
    const info = (await service.listIndexes()).find((entry) => entry.name === INDEX)

    assert.equal(info?.document_count, 3)
    assert.equal(info?.provider, 'meilisearch')
  })

  await t.test('matches free text and projects only what was asked for', async () => {
    const result = await search({ q: 'shirt' })

    assert.deepEqual(ids(result), ['prod_1'])
    assert.ok(!('internal_note' in result.hits[0].document), 'a non-retrievable field must not come back')
    assert.ok(!('created_at__ts' in result.hits[0].document), 'the date shadow must stay invisible')
    assert.deepEqual(result.hits[0].document.variants, [
      { id: 'v1', sku: 'RED-S' },
      { id: 'v2', sku: 'RED-M' },
    ])
  })

  await t.test('honours synonyms declared on the index', async () => {
    assert.deepEqual(ids(await search({ q: 'tee' })), ['prod_1'])
  })

  await t.test('filters on equality, arrays, ranges and nested paths', async () => {
    assert.deepEqual(ids(await search({ filters: { status: 'published' } })), ['prod_1', 'prod_2'])
    assert.deepEqual(ids(await search({ filters: { tags: 'summer' } })), ['prod_1', 'prod_3'])
    assert.deepEqual(ids(await search({ filters: { price: { $gte: 20, $lte: 80 } } })), ['prod_1', 'prod_2'])
    assert.deepEqual(ids(await search({ filters: { 'variants.sku': 'BLU-L' } })), ['prod_2'])
  })

  await t.test('composes boolean filters', async () => {
    assert.deepEqual(ids(await search({ filters: { $not: { status: 'published' } } })), ['prod_3'])
    assert.deepEqual(ids(await search({ filters: { $or: [{ id: 'prod_1' }, { price: { $lt: 20 } }] } })), [
      'prod_1',
      'prod_3',
    ])
  })

  await t.test('filters on dates through the epoch-ms shadow', async () => {
    assert.deepEqual(ids(await search({ filters: { created_at: { $gte: '2024-01-01T00:00:00Z' } } })), [
      'prod_1',
      'prod_2',
    ])
    assert.deepEqual(ids(await search({ filters: { created_at: { $lt: new Date('2024-01-01T00:00:00Z') } } })), [
      'prod_3',
    ])
  })

  await t.test('sorts, including by date', async () => {
    const byDate = await search({ pagination: { skip: 0, take: 20, order: { created_at: 'ASC' } } })
    const byPrice = await search({ pagination: { skip: 0, take: 20, order: { price: 'DESC' } } })

    assert.deepEqual(
      byDate.hits.map((hit) => hit.id),
      ['prod_3', 'prod_1', 'prod_2'],
    )
    assert.deepEqual(
      byPrice.hits.map((hit) => hit.id),
      ['prod_2', 'prod_1', 'prod_3'],
    )
  })

  await t.test('paginates and counts', async () => {
    const page = await search({ pagination: { skip: 1, take: 1, order: { price: 'ASC' } } })

    assert.deepEqual(
      page.hits.map((hit) => hit.id),
      ['prod_1'],
    )
    assert.equal(page.metadata.skip, 1)
    assert.equal(page.metadata.count, 3)
    assert.equal(
      (await search({ search_options: { count: 'exact' }, pagination: { skip: 0, take: 1 } })).metadata.count,
      3,
    )
    assert.equal((await search({ search_options: { count: 'none' } })).metadata.count, null)
  })

  await t.test('computes value and range facets in one request', async () => {
    const result = await search({
      filters: { status: 'published' },
      search_options: {
        facets: [
          { field: 'tags', type: 'value' },
          {
            field: 'price',
            type: 'range',
            ranges: [
              { from: 0, to: 50 },
              { key: 'expensive', from: 50 },
            ],
          },
        ],
      },
    })

    assert.deepEqual(result.facets?.tags, {
      type: 'value',
      values: [
        { value: 'cotton', count: 2 },
        { value: 'summer', count: 1 },
        { value: 'winter', count: 1 },
      ],
      other_count: 0,
    })
    assert.deepEqual(result.facets?.price, {
      type: 'range',
      ranges: [
        { key: '0-50', from: 0, to: 50, count: 1 },
        { key: 'expensive', from: 50, to: undefined, count: 1 },
      ],
    })
  })

  await t.test('computes stats facets', async () => {
    const result = await search({ search_options: { facets: [{ field: 'price', type: 'stats' }] } })

    assert.deepEqual(result.facets?.price, { type: 'stats', min: 15, max: 75, count: 3 })
  })

  await t.test('batches several queries into one multi-search', async () => {
    const [text, drafts] = await service.searchMany([
      { index: definition, attributes_to_retrieve: ['id'], q: 'shirt', pagination: { skip: 0, take: 5 } },
      {
        index: definition,
        attributes_to_retrieve: ['id'],
        filters: { status: 'draft' },
        pagination: { skip: 0, take: 5 },
      },
    ])

    assert.deepEqual(ids(text), ['prod_1'])
    assert.deepEqual(ids(drafts), ['prod_3'])
  })

  await t.test('highlights and scores', async () => {
    const result = await search({
      q: 'cotton',
      search_options: {
        highlight: { fields: ['description'], pre_tag: '<em>', post_tag: '</em>' },
        include_score: true,
      },
    })

    assert.deepEqual(result.hits[0].highlights?.description, ['A comfortable <em>cotton</em> shirt'])
    assert.equal(typeof result.hits[0].score, 'number')
  })

  await t.test('narrows matching to named attributes', async () => {
    const result = await search({ q: 'RED-S', search_options: { attributes_to_search_on: ['variants.sku'] } })

    assert.deepEqual(ids(result), ['prod_1'])
  })

  await t.test('deletes by id and by filter', async () => {
    await service.waitForTask(await service.deleteDocuments({ index: INDEX, filters: { id: ['prod_3'] } }))
    assert.deepEqual(ids(await search()), ['prod_1', 'prod_2'])

    await service.waitForTask(await service.deleteDocuments({ index: INDEX, filters: { price: { $gt: 50 } } }))
    assert.deepEqual(ids(await search()), ['prod_1'])
  })

  await t.test('swaps a rebuilt index in and drops the one it replaced', async () => {
    await service.waitForTask(await service.upsertIndex({ index: { ...definition, physical_name: SHADOW } }))
    await service.waitForTask(
      await service.upsertDocuments({
        index: SHADOW,
        documents: [{ id: 'prod_9', title: 'Rebuilt', status: 'published' }],
      }),
    )

    const swapped = await service.swapIndex({ alias: INDEX, index: SHADOW })

    assert.equal(swapped.status, 'succeeded')
    assert.deepEqual(ids(await search()), ['prod_9'])
    assert.ok(!(await service.listIndexes()).some((entry) => entry.name === SHADOW))
  })

  await t.test('empties an index without deleting it', async () => {
    await service.waitForTask(await service.clearIndex({ index: INDEX }))

    assert.equal((await search()).hits.length, 0)
  })
})
