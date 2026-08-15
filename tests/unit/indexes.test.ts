// `defineSearchIndex` registers into the module registry as it is called, the way
// `defineLink` does, so the registry has to exist before a definition is built.
import '@medusajs/modules-sdk'

import { SearchTypes } from '@medusajs/types'
import assert from 'node:assert/strict'
import test from 'node:test'
import { defineCategorySearchIndex } from '../../src/indexes/category'
import { eventEntityIds } from '../../src/indexes/common'
import { resolveLocalizedIndex } from '../../src/indexes/locales'
import { defineProductSearchIndex } from '../../src/indexes/product'
import { queryStub } from '../helpers'

test('declares the fields a storefront needs, with sensible weights', () => {
  const index = defineProductSearchIndex()

  assert.equal(index.name, 'product')
  assert.equal(index.entity, 'product')
  assert.deepEqual(index.fields.title.searchable, { weight: 5 })
  assert.equal(index.fields.variants.type, 'object')
  assert.equal(index.fields.variants.array, true)
  assert.equal(index.fields.created_at.sortable, true)
  assert.equal(index.fields.status.filterable, true)
})

test('subscribes to both event namespaces, since one change arrives under two names', () => {
  const index = defineProductSearchIndex()

  assert.ok(index.events?.includes('product.updated'))
  assert.ok(index.events?.includes('product.product.updated'))
  assert.ok(index.events?.includes('product.product-variant.updated'))
})

test('takes a name, so several indexes can cover one entity', () => {
  assert.equal(defineProductSearchIndex({ name: 'product_fr' }).name, 'product_fr')
  assert.equal(defineCategorySearchIndex({ name: 'category_fr' }).name, 'category_fr')
})

test('reads ids off an event however Medusa emitted it', () => {
  const event = (data: unknown) =>
    ({ name: 'product.updated', data }) as Parameters<NonNullable<SearchTypes.SearchIndexDefinition['consume']>>[0]

  assert.deepEqual(eventEntityIds(event({ id: 'p1' })), ['p1'])
  assert.deepEqual(eventEntityIds(event([{ id: 'p1' }, { id: 'p2' }])), ['p1', 'p2'])
  assert.deepEqual(eventEntityIds(event({ ids: ['p1', 'p2'] })), ['p1', 'p2'])
  assert.deepEqual(eventEntityIds(event('p1')), ['p1'])
  assert.deepEqual(eventEntityIds(event({})), [])
})

test('seeds by id rather than by offset, so a long run cannot skip rows', async () => {
  const { container, calls } = queryStub([
    [
      { id: 'p1', title: 'One' },
      { id: 'p2', title: 'Two' },
    ],
    [{ id: 'p3', title: 'Three' }],
  ])
  const index = defineProductSearchIndex({ batch_size: 2 })
  const seeded: SearchTypes.SearchDocument[] = []

  for await (const batch of index.seed({ container, index })) {
    seeded.push(...batch)
  }

  assert.deepEqual(
    seeded.map((document) => document.id),
    ['p1', 'p2', 'p3'],
  )
  assert.deepEqual(calls[0].filters, { status: 'published' })
  assert.deepEqual(calls[0].pagination, { take: 2, order: { id: 'ASC' } })
  assert.deepEqual(calls[1].filters, { status: 'published', id: { $gt: 'p2' } })
})

test('resumes an interrupted seed from the last key', async () => {
  const { container, calls } = queryStub([[{ id: 'p9', title: 'Nine' }]])
  const index = defineProductSearchIndex()

  for await (const _ of index.seed({ container, index, last_key: 'p8' })) {
    // drain
  }

  assert.deepEqual(calls[0].filters, { status: 'published', id: { $gt: 'p8' } })
})

test('upserts what still matches and deletes what does not', async () => {
  const { container } = queryStub([[{ id: 'p1', title: 'One' }]])
  const index = defineProductSearchIndex()

  const mutations = await index.consume!(
    { name: 'product.updated', data: [{ id: 'p1' }, { id: 'gone' }] },
    {
      container,
      index,
    },
  )

  assert.deepEqual(mutations, [
    { action: 'upsert', documents: [{ id: 'p1', title: 'One' }] },
    { action: 'delete', filters: { id: ['gone'] } },
  ])
})

test('removes a product that stopped matching the index filters', async () => {
  const { container } = queryStub([[]])
  const index = defineProductSearchIndex()

  const mutations = await index.consume!(
    { name: 'product.updated', data: { id: 'unpublished' } },
    {
      container,
      index,
    },
  )

  assert.deepEqual(mutations, [{ action: 'delete', filters: { id: ['unpublished'] } }])
})

test('resolves a variant event back to the product holding it', async () => {
  const { container, calls } = queryStub([[{ id: 'v1', product_id: 'p9' }], [{ id: 'p9', title: 'Nine' }]])
  const index = defineProductSearchIndex()

  const mutations = await index.consume!(
    { name: 'product.product-variant.updated', data: { id: 'v1' } },
    {
      container,
      index,
    },
  )

  assert.equal(calls[0].entity, 'product_variant')
  assert.equal(calls[1].entity, 'product')
  assert.deepEqual(mutations, [{ action: 'upsert', documents: [{ id: 'p9', title: 'Nine' }] }])
})

test('reads entities in the index locale, so a per-language index holds that language', async () => {
  const { container, options } = queryStub([[{ id: 'p1', title: 'Chemise' }]])
  const index = defineProductSearchIndex({ name: 'product_fr', locale: 'fr-FR' })

  for await (const _ of index.seed({ container, index })) {
    // drain
  }

  assert.deepEqual(options[0], { locale: 'fr-FR' })
})

test('reindexes an updated entity in the same locale it was seeded in', async () => {
  const { container, options } = queryStub([[{ id: 'p1', title: 'Chemise' }]])
  const index = defineProductSearchIndex({ locale: 'fr-FR' })

  await index.consume!({ name: 'product.updated', data: { id: 'p1' } }, { container, index })

  assert.deepEqual(options[0], { locale: 'fr-FR' })
})

test('asks for no locale when none was declared, leaving the default language', async () => {
  const { container, options } = queryStub([[{ id: 'p1', title: 'Shirt' }]])
  const index = defineProductSearchIndex()

  for await (const _ of index.seed({ container, index })) {
    // drain
  }

  assert.deepEqual(options[0], { locale: undefined })
})

test('declares one index per language, on top of the default one', () => {
  const indexes = defineProductSearchIndex({ default_locale: 'en-US', locales: ['fr-FR', 'de-DE'] })

  assert.deepEqual(
    indexes.map((index) => {
      return index.name
    }),
    ['product', 'product-fr-FR', 'product-de-DE'],
  )
  assert.deepEqual(indexes[1].settings?.locales, ['fr'])
  assert.deepEqual(indexes[2].settings?.locales, ['de'])
  // Same catalogue, same shape: only the language inside the documents differs.
  assert.deepEqual(indexes[0].fields, indexes[1].fields)
})

test('keeps a declared analyzer rather than deriving one from the locale', () => {
  const indexes = defineProductSearchIndex({ locales: ['fr-FR'], settings: { locales: ['fra', 'eng'] } })

  assert.deepEqual(indexes[1].settings?.locales, ['fra', 'eng'])
})

test('fans a renamed index out under its own name', () => {
  const indexes = defineCategorySearchIndex({ name: 'catalog_category', locales: ['fr-FR'] })

  assert.deepEqual(
    indexes.map((index) => {
      return index.name
    }),
    ['catalog_category', 'catalog_category-fr-FR'],
  )
})

test('answers for the language the default index already holds, rather than for a copy of it', () => {
  defineProductSearchIndex({ name: 'product_default_locale', default_locale: 'en-US', locales: ['fr-FR'] })

  const english = resolveLocalizedIndex({
    available: ['product_default_locale', 'product_default_locale-fr-FR'],
    base: 'product_default_locale',
    locale: 'en-US',
  })
  const french = resolveLocalizedIndex({
    available: ['product_default_locale', 'product_default_locale-fr-FR'],
    base: 'product_default_locale',
    locale: 'fr-FR',
  })

  assert.equal(english, 'product_default_locale')
  assert.equal(french, 'product_default_locale-fr-FR')
})

test('registers a hand-named index under its locale, so a request finds it without knowing its name', () => {
  defineProductSearchIndex({ name: 'producten', locale: 'nl-NL' })

  const index = resolveLocalizedIndex({ available: ['product', 'producten'], base: 'product', locale: 'nl-NL' })

  assert.equal(index, 'producten')
})

test('follows translations only on the indexes whose language they change', () => {
  const [base, french] = defineProductSearchIndex({ locales: ['fr-FR'] })

  assert.equal(base.events?.includes('translation.updated'), false)
  assert.ok(french.events?.includes('translation.updated'))
  assert.ok(french.events?.includes('translation.translation.updated'))
})

test('reindexes the product a translation was written for, in the language that index holds', async () => {
  const { container, calls } = queryStub([
    [{ id: 'tr_1', reference: 'product', reference_id: 'p1', locale_code: 'fr-FR' }],
    [{ id: 'p1', title: 'Chemise' }],
  ])
  const [, index] = defineProductSearchIndex({ name: 'product_i18n', locales: ['fr-FR'] })

  const mutations = await index.consume!({ name: 'translation.updated', data: { id: 'tr_1' } }, { container, index })

  assert.equal(calls[0].entity, 'translation')
  assert.deepEqual(mutations, [{ action: 'upsert', documents: [{ id: 'p1', title: 'Chemise' }] }])
})

test('leaves an index alone when the translation that changed is in another language', async () => {
  const { container, calls } = queryStub([
    [{ id: 'tr_1', reference: 'product', reference_id: 'p1', locale_code: 'de-DE' }],
  ])
  const [, index] = defineProductSearchIndex({ name: 'product_other', locales: ['fr-FR'] })

  const mutations = await index.consume!({ name: 'translation.updated', data: { id: 'tr_1' } }, { container, index })

  // Nothing to reconcile, so the entity is never read back out of the database.
  assert.equal(calls.length, 1)
  assert.deepEqual(mutations, [])
})

test('reindexes the product holding a variant whose translation changed', async () => {
  const { container, calls } = queryStub([
    [{ id: 'tr_1', reference: 'product_variant', reference_id: 'v1', locale_code: 'fr-FR' }],
    [{ id: 'v1', product_id: 'p9' }],
    [{ id: 'p9', title: 'Chemise' }],
  ])
  const [, index] = defineProductSearchIndex({ name: 'product_variants_i18n', locales: ['fr-FR'] })

  const mutations = await index.consume!({ name: 'translation.created', data: { id: 'tr_1' } }, { container, index })

  assert.equal(calls[1].entity, 'product_variant')
  assert.deepEqual(mutations, [{ action: 'upsert', documents: [{ id: 'p9', title: 'Chemise' }] }])
})

test('reindexes the category a translation was written for', async () => {
  const { container, options } = queryStub([
    [{ id: 'tr_1', reference: 'product_category', reference_id: 'c1', locale_code: 'fr-FR' }],
    [{ id: 'c1', name: 'Chemises' }],
  ])
  const [, index] = defineCategorySearchIndex({ locales: ['fr-FR'] })

  const mutations = await index.consume!({ name: 'translation.updated', data: { id: 'tr_1' } }, { container, index })

  assert.deepEqual(mutations, [{ action: 'upsert', documents: [{ id: 'c1', name: 'Chemises' }] }])
  // The entity is read back in the index' own language, not the default one.
  assert.deepEqual(options[1], { locale: 'fr-FR' })
})

test('indexes only browsable categories by default', () => {
  const index = defineCategorySearchIndex()

  assert.equal(index.entity, 'product_category')
  assert.equal(index.fields.name.type, 'text')
  assert.equal(index.fields.is_active.filterable, true)
})
