// `defineSearchIndex` registers into the module registry as it is called, and the
// factories under test declare indexes, so the registry has to exist first.
import '@medusajs/modules-sdk'

import { SearchTypes } from '@medusajs/types'
import assert from 'node:assert/strict'
import test from 'node:test'
import { localizedSearch } from '../../src/api/utils/locale'
import {
  engineLocales,
  localeFallbacks,
  localeIndexName,
  normalizeLocaleTag,
  registerLocalizedIndex,
  resolveLocalizedIndex,
} from '../../src/indexes/locales'

/** A Search Module stub that knows nothing but which indexes were loaded. */
function moduleWith(indexes: string[]): SearchTypes.ISearchModuleService {
  return {
    listIndexes: () => {
      return indexes
    },
  } as unknown as SearchTypes.ISearchModuleService
}

test('reads a locale in the casing Medusa stores translations under', () => {
  assert.equal(normalizeLocaleTag('fr-fr'), 'fr-FR')
  assert.equal(normalizeLocaleTag(' DE '), 'de')
  assert.equal(localeIndexName('product', 'fr-fr'), 'product-fr-FR')
})

test('tokenizes by language, since a region says nothing about how words are cut', () => {
  assert.deepEqual(engineLocales('fr-CA'), ['fr'])
  assert.deepEqual(engineLocales('fr-FR'), ['fr'])
  assert.deepEqual(engineLocales('ja'), ['ja'])
})

test('names a language by the code Meilisearch knows it under', () => {
  assert.deepEqual(engineLocales('no-NO'), ['nb'])
  assert.deepEqual(engineLocales('iw'), ['he'])
})

test('leaves a language Meilisearch cannot analyze to its own detection', () => {
  assert.equal(engineLocales('cy-GB'), undefined)
  assert.equal(engineLocales('xx'), undefined)
})

test('falls back from a region to its language before giving up', () => {
  assert.deepEqual(localeFallbacks('fr-CA'), ['fr-CA', 'fr'])
  assert.deepEqual(localeFallbacks('fr'), ['fr'])
})

test('finds a language index by the name the factories give it', () => {
  const index = resolveLocalizedIndex({
    available: ['product', 'product-fr-FR'],
    base: 'product',
    locale: 'fr-FR',
  })

  assert.equal(index, 'product-fr-FR')
})

test('finds an index declared under a name of its own, because it registered its locale', () => {
  registerLocalizedIndex({ index: 'produits', base: 'product', entity: 'product', locale: 'fr-FR' })

  const index = resolveLocalizedIndex({
    available: ['product', 'produits'],
    base: 'product',
    locale: 'fr-FR',
  })

  assert.equal(index, 'produits')
})

test('ignores an index that registered but is no longer loaded', () => {
  registerLocalizedIndex({ index: 'product-removed', base: 'product', entity: 'product', locale: 'da-DK' })

  const index = resolveLocalizedIndex({ available: ['product'], base: 'product', locale: 'da-DK' })

  assert.equal(index, undefined)
})

test('passes over an index that was renamed for the one that is loaded', () => {
  // A definition renamed between two boots of the same process leaves its old
  // name registered; the language still has an index, and it must be found.
  registerLocalizedIndex({ index: 'product-old-sv', base: 'product', entity: 'product', locale: 'sv-SE' })
  registerLocalizedIndex({ index: 'produkter', base: 'product', entity: 'product', locale: 'sv-SE' })

  const index = resolveLocalizedIndex({
    available: ['product', 'produkter'],
    base: 'product',
    locale: 'sv-SE',
  })

  assert.equal(index, 'produkter')
})

test('serves a region nobody indexed from the language that was', () => {
  const index = resolveLocalizedIndex({
    available: ['product', 'product-de'],
    base: 'product',
    locale: 'de-AT',
  })

  assert.equal(index, 'product-de')
})

test('searches the index holding the language the request asked for', () => {
  const resolved = localizedSearch({
    search: moduleWith(['product', 'product-fr-FR']),
    base: 'product',
    locale: 'fr-FR',
  })

  assert.deepEqual(resolved, { index: 'product-fr-FR', locales: ['fr'] })
})

test('falls back to the default index rather than answering nothing in an unindexed language', () => {
  const resolved = localizedSearch({
    search: moduleWith(['product', 'product-fr-FR']),
    base: 'product',
    locale: 'it-IT',
  })

  assert.deepEqual(resolved, { index: 'product' })
})

test('leaves a named index the language it declared', () => {
  const resolved = localizedSearch({
    search: moduleWith(['product', 'product-de-DE']),
    base: 'product',
    requested: 'product-de-DE',
    locale: 'fr-FR',
  })

  assert.deepEqual(resolved, { index: 'product-de-DE' })
})

test('lets an explicit language override the one the locale implies', () => {
  const resolved = localizedSearch({
    search: moduleWith(['product', 'product-fr-FR']),
    base: 'product',
    locale: 'fr-FR',
    language: 'eng',
  })

  assert.deepEqual(resolved, { index: 'product-fr-FR', locales: ['eng'] })
})

test('searches the default index in its own language when no locale was asked for', () => {
  const resolved = localizedSearch({ search: moduleWith(['product', 'product-fr-FR']), base: 'product' })

  assert.deepEqual(resolved, { index: 'product' })
})
