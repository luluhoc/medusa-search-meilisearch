import { SearchTypes } from '@medusajs/types'
import { defineSearchIndex, ProductEvents, search } from '@medusajs/utils'
import {
  DEFAULT_BATCH_SIZE,
  eventEntityIds,
  reconcileIds,
  SearchEntity,
  SearchIndexFactoryOptions,
  streamEntities,
  toFieldDefinitions,
} from './common'

/** The default product-category index fields. Spread it to add to them. */
export const categorySearchFields = {
  id: search.keyword().filterable(),
  name: search.text().searchable({ weight: 5 }).sortable(),
  description: search.text().searchable(),
  handle: search.keyword().filterable().searchable(),
  rank: search.integer().filterable().sortable(),
  is_active: search.boolean().filterable(),
  is_internal: search.boolean().filterable(),
  parent_category_id: search.keyword().filterable(),
  parent_category: search.object({
    id: search.keyword().filterable(),
    name: search.text().searchable({ weight: 2 }).facetable(),
    handle: search.keyword().filterable(),
  }),
  created_at: search.date().filterable().sortable(),
  updated_at: search.date().filterable().sortable(),
}

/** The `query.graph` selection that fills `categorySearchFields`. */
export const categoryGraphFields = [
  'id',
  'name',
  'description',
  'handle',
  'rank',
  'is_active',
  'is_internal',
  'parent_category_id',
  'parent_category.id',
  'parent_category.name',
  'parent_category.handle',
  'created_at',
  'updated_at',
]

export const categorySearchEvents = [
  'product-category.created',
  'product-category.updated',
  'product-category.deleted',
  ProductEvents.PRODUCT_CATEGORY_CREATED,
  ProductEvents.PRODUCT_CATEGORY_UPDATED,
  ProductEvents.PRODUCT_CATEGORY_DELETED,
]

// What a storefront may show: an inactive or internal category is not browsable,
// so indexing it would surface it in search alone.
const DEFAULT_FILTERS = { is_active: true, is_internal: false }

/**
 * Declares a product-category search index. Call it from a file under `src/search/`
 * in your Medusa application:
 *
 * ```ts
 * // src/search/category.ts
 * import { defineCategorySearchIndex } from '@luluhoc/medusa-search-meilisearch/indexes'
 *
 * export default defineCategorySearchIndex()
 * ```
 */
export function defineCategorySearchIndex(options: SearchIndexFactoryOptions = {}): SearchTypes.SearchIndexDefinition {
  const fields = toFieldDefinitions(options.fields ?? search.define(categorySearchFields))
  const graphFields = options.graph_fields ?? categoryGraphFields
  const filters = options.filters ?? DEFAULT_FILTERS
  const take = options.batch_size ?? DEFAULT_BATCH_SIZE
  const transform =
    options.transform ??
    ((category: SearchEntity) => {
      return category
    })

  return defineSearchIndex({
    name: options.name ?? 'category',
    entity: 'product_category',
    provider: options.provider,
    fields,
    settings: options.settings,
    events: options.events ?? categorySearchEvents,
    async consume(event, { container }) {
      return reconcileIds({
        container,
        entity: 'product_category',
        fields: graphFields,
        filters,
        ids: eventEntityIds(event),
        transform,
        locale: options.locale,
      })
    },
    async *seed({ container, filters: seedFilters, last_key: lastKey }) {
      for await (const batch of streamEntities({
        container,
        entity: 'product_category',
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
