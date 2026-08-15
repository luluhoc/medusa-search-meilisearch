import { SearchTypes } from '@medusajs/types'
import { MeilisearchProviderOptions } from '../src/providers/meilisearch/types'

export const OPTIONS: MeilisearchProviderOptions = {
  config: { host: 'http://127.0.0.1:7700', apiKey: 'test' },
}

/**
 * A resolved definition, as the Search Module hands one to a provider: fields
 * already flattened from the DSL, and `physical_name` / `definition_hash` filled
 * in. `overrides.fields` replaces the field set rather than merging into it, so a
 * test can declare exactly the one field it is about.
 */
export function productDefinition(
  overrides: Partial<SearchTypes.ResolvedSearchIndexDefinition> = {},
): SearchTypes.ResolvedSearchIndexDefinition {
  return {
    name: 'product',
    entity: 'product',
    primary_key: 'id',
    provider: 'meilisearch',
    physical_name: 'product',
    definition_hash: 'hash0001hash0002',
    fields: {
      id: { type: 'keyword', filterable: true },
      title: { type: 'text', searchable: { weight: 5 }, sortable: true },
      description: { type: 'text', searchable: true },
      secret: { type: 'text', searchable: true, retrievable: false },
      status: { type: 'keyword', filterable: true, facetable: true },
      price: { type: 'float', filterable: true, sortable: true, facetable: { types: ['range', 'stats'] } },
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
      typo_tolerance: { enabled: true, min_word_size_for_one_typo: 4 },
      faceting: { max_values_per_facet: 50, sort_by: 'count' },
      pagination: { max_total_hits: 5000 },
      locales: ['eng'],
      provider_options: { meilisearch: { proximityPrecision: 'byAttribute' } },
    },
    seed: async function* () {},
    ...overrides,
  }
}

/** A provider query with the fields the module always fills in. */
export function providerQuery(
  overrides: Partial<SearchTypes.ProviderSearchQuery> = {},
  definition = productDefinition(),
): SearchTypes.ProviderSearchQuery {
  return {
    index: definition,
    attributes_to_retrieve: ['title', 'price'],
    pagination: { skip: 0, take: 20 },
    ...overrides,
  }
}

/** A `query.graph` stub that answers from a queue of pages. */
export function queryStub(pages: Record<string, unknown>[][]) {
  const calls: Record<string, unknown>[] = []
  const options: (Record<string, unknown> | undefined)[] = []

  return {
    calls,
    options,
    container: {
      query: {
        graph: async (args: Record<string, unknown>, opts?: Record<string, unknown>) => {
          calls.push(args)
          options.push(opts)

          return { data: pages.shift() ?? [] }
        },
      },
    } as unknown as SearchTypes.SearchContainer,
  }
}
