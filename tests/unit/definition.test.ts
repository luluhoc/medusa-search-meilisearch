import assert from 'node:assert/strict'
import test from 'node:test'
import { assertIndexSupported, buildIndexPlan } from '../../src/providers/meilisearch/utils/definition'
import { OPTIONS, productDefinition } from '../helpers'

test('orders searchable attributes by weight, since Meilisearch ranks by position', () => {
  const plan = buildIndexPlan(productDefinition(), OPTIONS)

  assert.deepEqual(plan.settings.searchableAttributes, ['title', 'variants.sku', 'description', 'secret'])
})

test('registers facetable fields as filterable, because a facet is a filter', () => {
  const plan = buildIndexPlan(productDefinition(), OPTIONS)

  assert.ok(plan.settings.filterableAttributes?.includes('status'))
  assert.ok(plan.settings.filterableAttributes?.includes('price'))
})

test('registers a date twice: verbatim, and as its epoch-ms shadow', () => {
  const plan = buildIndexPlan(productDefinition(), OPTIONS)

  assert.ok(plan.settings.filterableAttributes?.includes('created_at'))
  assert.ok(plan.settings.filterableAttributes?.includes('created_at__ts'))
  assert.ok(plan.settings.sortableAttributes?.includes('created_at__ts'))
})

test('displays only retrievable leaves, never object containers or shadows', () => {
  const plan = buildIndexPlan(productDefinition(), OPTIONS)

  assert.deepEqual(plan.settings.displayedAttributes, [
    'id',
    'title',
    'description',
    'status',
    'price',
    'created_at',
    'variants.id',
    'variants.sku',
  ])
})

test('translates index settings to their Meilisearch equivalents', () => {
  const plan = buildIndexPlan(productDefinition(), OPTIONS)

  assert.deepEqual(plan.settings.typoTolerance, {
    enabled: true,
    disableOnAttributes: undefined,
    minWordSizeForTypos: { oneTypo: 4, twoTypos: undefined },
  })
  assert.deepEqual(plan.settings.faceting, { maxValuesPerFacet: 50, sortFacetValuesBy: { '*': 'count' } })
  assert.deepEqual(plan.settings.pagination, { maxTotalHits: 5000 })
  assert.deepEqual(plan.settings.localizedAttributes, [{ attributePatterns: ['*'], locales: ['eng'] }])
  assert.deepEqual(plan.settings.synonyms, { tee: ['t-shirt'] })
})

test('lets a per-index escape hatch win over everything derived', () => {
  const plan = buildIndexPlan(productDefinition(), { ...OPTIONS, settings: { proximityPrecision: 'byWord' } })

  assert.equal(plan.settings.proximityPrecision, 'byAttribute')
})

test('registers an embedder for each vector field', () => {
  const plan = buildIndexPlan(
    productDefinition({
      fields: { embedding: { type: 'vector', dimensions: 768 } },
    }),
    OPTIONS,
  )

  assert.deepEqual(plan.settings.embedders?.embedding, { source: 'userProvided', dimensions: 768 })
})

test('refuses a correlated field, which Meilisearch flattens away', () => {
  assert.throws(
    () =>
      assertIndexSupported(
        productDefinition({ fields: { variants: { type: 'object', array: true, correlated: true, fields: {} } } }),
      ),
    /correlated/,
  )
})

test('refuses a geo field under a name Meilisearch does not recognise', () => {
  assert.throws(() => assertIndexSupported(productDefinition({ fields: { where: { type: 'geo' } } })), /_geo/)
})

test('refuses a vector field with no dimensions to store', () => {
  assert.throws(() => assertIndexSupported(productDefinition({ fields: { vec: { type: 'vector' } } })), /dimensions/)
})
