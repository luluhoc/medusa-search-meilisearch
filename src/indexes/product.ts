import { SearchTypes } from '@medusajs/types'
import { defineSearchIndex, ProductEvents, search } from '@medusajs/utils'
import {
  DEFAULT_BATCH_SIZE,
  defineIndexPerLocale,
  eventEntityIds,
  isTranslationEvent,
  reconcileIds,
  registerIndexDefinition,
  SearchEntity,
  SearchIndexFactoryOptions,
  streamEntities,
  toEntities,
  toFieldDefinitions,
  translatedEntityIds,
  translationSearchEvents,
} from './common'

/**
 * The default product index fields. Spread it to add to them:
 *
 * ```ts
 * defineProductSearchIndex({
 *   fields: search.define({
 *     ...productSearchFields,
 *     brand: search.keyword().filterable().facetable(),
 *   }),
 *   graph_fields: [...productGraphFields, 'brand.*'],
 * })
 * ```
 */
export const productSearchFields = {
  id: search.keyword().filterable(),
  handle: search.keyword().filterable().searchable(),
  title: search.text().searchable({ weight: 5 }).sortable(),
  subtitle: search.text().searchable({ weight: 2 }),
  description: search.text().searchable(),
  status: search.keyword().filterable().facetable(),
  thumbnail: search.keyword(),
  is_giftcard: search.boolean().filterable(),
  discountable: search.boolean().filterable(),
  collection_id: search.keyword().filterable(),
  type_id: search.keyword().filterable(),
  collection: search.object({
    id: search.keyword().filterable(),
    title: search.text().searchable({ weight: 2 }).facetable(),
    handle: search.keyword().filterable(),
  }),
  type: search.object({
    id: search.keyword().filterable(),
    value: search.keyword().filterable().facetable(),
  }),
  categories: search
    .object({
      id: search.keyword().filterable(),
      name: search.text().searchable({ weight: 2 }).facetable(),
      handle: search.keyword().filterable(),
    })
    .array(),
  tags: search
    .object({
      id: search.keyword().filterable(),
      value: search.keyword().filterable().facetable(),
    })
    .array(),
  variants: search
    .object({
      id: search.keyword().filterable(),
      title: search.text().searchable({ weight: 2 }),
      sku: search.keyword().filterable().searchable({ weight: 4 }),
      barcode: search.keyword().filterable(),
    })
    .array(),
  created_at: search.date().filterable().sortable(),
  updated_at: search.date().filterable().sortable(),
}

/** The `query.graph` selection that fills `productSearchFields`. */
export const productGraphFields = [
  'id',
  'handle',
  'title',
  'subtitle',
  'description',
  'status',
  'thumbnail',
  'is_giftcard',
  'discountable',
  'collection_id',
  'type_id',
  'collection.id',
  'collection.title',
  'collection.handle',
  'type.id',
  'type.value',
  'categories.id',
  'categories.name',
  'categories.handle',
  'tags.id',
  'tags.value',
  'variants.id',
  'variants.title',
  'variants.sku',
  'variants.barcode',
  'created_at',
  'updated_at',
]

/**
 * Product events worth reindexing on. Both namespaces are listed because the same
 * change reaches the event bus under two names — the module emits
 * `product.product.updated`, and the workflow that wraps it emits `product.updated`.
 * Ingesting an event twice is idempotent; missing one leaves a stale document.
 */
export const productSearchEvents = [
  'product.created',
  'product.updated',
  'product.deleted',
  ProductEvents.PRODUCT_CREATED,
  ProductEvents.PRODUCT_UPDATED,
  ProductEvents.PRODUCT_DELETED,
  ProductEvents.PRODUCT_VARIANT_CREATED,
  ProductEvents.PRODUCT_VARIANT_UPDATED,
]

const DEFAULT_FILTERS = { status: 'published' }

/**
 * Declares a product search index. Call it from a file under `src/search/` in your
 * Medusa application — that directory is what the Search Module loads its
 * definitions from:
 *
 * ```ts
 * // src/search/product.ts
 * import { defineProductSearchIndex } from '@luluhoc/medusa-search-meilisearch/indexes'
 *
 * export default defineProductSearchIndex()
 * ```
 *
 * With `locales`, it declares one index per language on top of the default one —
 * `product`, `product-fr-FR`, `product-de-DE` — and returns all of them:
 *
 * ```ts
 * export default defineProductSearchIndex({ default_locale: 'en-US', locales: ['fr-FR', 'de-DE'] })
 * ```
 */
export function defineProductSearchIndex(
  options?: SearchIndexFactoryOptions & { locales?: undefined },
): SearchTypes.SearchIndexDefinition
export function defineProductSearchIndex(
  options: SearchIndexFactoryOptions & { locales: string[] },
): SearchTypes.SearchIndexDefinition[]
export function defineProductSearchIndex(
  options: SearchIndexFactoryOptions = {},
): SearchTypes.SearchIndexDefinition | SearchTypes.SearchIndexDefinition[] {
  if (options.locales?.length) {
    return defineIndexPerLocale({ options, index: 'product', build: buildProductSearchIndex })
  }

  return buildProductSearchIndex(options)
}

function buildProductSearchIndex(
  options: SearchIndexFactoryOptions,
  base = 'product',
): SearchTypes.SearchIndexDefinition {
  registerIndexDefinition({ options, base, entity: 'product' })

  const fields = toFieldDefinitions(options.fields ?? search.define(productSearchFields))
  const graphFields = options.graph_fields ?? productGraphFields
  const filters = options.filters ?? DEFAULT_FILTERS
  const take = options.batch_size ?? DEFAULT_BATCH_SIZE
  const transform =
    options.transform ??
    ((product: SearchEntity) => {
      return product
    })

  return defineSearchIndex({
    name: options.name ?? base,
    entity: 'product',
    provider: options.provider,
    fields,
    settings: options.settings,
    // A localized index also has to follow the translations it holds; the
    // default-language one has nothing to gain from them.
    events:
      options.events ?? (options.locale ? [...productSearchEvents, ...translationSearchEvents] : productSearchEvents),
    async consume(event, { container }) {
      const ids = eventEntityIds(event)
      // A variant event names the variant, and what has to be reindexed is the
      // product holding it. A deleted variant cannot be looked up any more, so
      // that case resolves to nothing and waits for the product's own event.
      const productIds = isTranslationEvent(event.name)
        ? await translatedProductIds(container, ids, options.locale)
        : event.name.includes('variant')
          ? await resolveProductIds(container, ids)
          : ids

      return reconcileIds({
        container,
        entity: 'product',
        fields: graphFields,
        filters,
        ids: productIds,
        transform,
        locale: options.locale,
      })
    },
    async *seed({ container, filters: seedFilters, last_key: lastKey }) {
      for await (const batch of streamEntities({
        container,
        entity: 'product',
        fields: graphFields,
        filters: { ...filters, ...seedFilters },
        take,
        last_key: lastKey,
        locale: options.locale,
      })) {
        yield batch.map(transform)
      }
    },
  })
}

/**
 * The products a set of translation events is about. A product's document carries
 * its variants' titles, so a variant translation reindexes the product holding
 * it; anything translated in another language belongs to another index and is
 * dropped here.
 */
async function translatedProductIds(
  container: SearchTypes.SearchContainer,
  translationIds: string[],
  locale?: string,
): Promise<string[]> {
  if (!locale) {
    return []
  }

  const references = await translatedEntityIds({
    container,
    ids: translationIds,
    references: ['product', 'product_variant'],
    locale,
  })
  const fromVariants = await resolveProductIds(container, references.product_variant ?? [])

  return [...new Set([...(references.product ?? []), ...fromVariants])]
}

async function resolveProductIds(container: SearchTypes.SearchContainer, variantIds: string[]): Promise<string[]> {
  if (!variantIds.length) {
    return []
  }

  const { data } = await container.query.graph({
    entity: 'product_variant',
    fields: ['product_id'],
    filters: { id: variantIds },
  })

  const productIds = toEntities(data).map((variant) => {
    return variant.product_id
  })

  return [
    ...new Set(
      productIds.filter((id): id is string => {
        return typeof id === 'string'
      }),
    ),
  ]
}
