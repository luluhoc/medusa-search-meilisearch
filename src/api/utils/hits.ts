import { MedusaRequest, MedusaResponse } from '@medusajs/framework'
import { SearchTypes } from '@medusajs/types'
import z from 'zod'
import { MEILISEARCH_PROVIDER_KEY } from '../../providers/meilisearch/types'
import { localizedSearch, requestLocale } from './locale'
import { searchModule } from './search'

const list = z.union([z.string(), z.array(z.string())]).optional()

/**
 * The query a raw-hits route accepts. These routes hand back what the engine
 * returned — hits, facets and metadata — rather than reading the entities back out
 * of the database, so a storefront that renders straight from the index can do so
 * in one round trip.
 */
export const SearchHitsSchema = z.object({
  query: z.string().optional(),
  /** The index to query. Defaults to the route's own entity. */
  index: z.string().optional(),
  limit: z.coerce.number().default(10),
  offset: z.coerce.number().default(0),
  language: z.string().optional(),
  semanticSearch: z.coerce.boolean().default(false),
  semanticRatio: z.coerce.number().min(0).max(1).default(0.5),
  embedder: z.string().default('default'),
  /** Dotted field paths to return. Defaults to everything the index can return. */
  fields: list,
  /** Facets to compute, e.g. `facets=status&facets=tags.value`. */
  facets: list,
  /** Sort keys as `path:asc` / `path:desc`. */
  sort: list,
  /**
   * A raw Meilisearch filter expression, passed to the provider untouched. An
   * escape hatch for filters the Search Module's tree cannot express; it replaces
   * the compiled filter rather than adding to it.
   */
  filter: z.string().optional(),
})

export type SearchHitsParams = z.infer<typeof SearchHitsSchema>

export type SearchHitsResponse = SearchTypes.SearchResult

function toArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined
  }

  return Array.isArray(value) ? value : [value]
}

function toOrder(sort: string | string[] | undefined): Record<string, SearchTypes.SearchOrderBy> | undefined {
  const keys = toArray(sort)

  if (!keys?.length) {
    return undefined
  }

  return Object.fromEntries(
    keys.map((key) => {
      const [path, direction = 'asc'] = key.split(':')

      return [path, direction.toLowerCase() === 'desc' ? 'DESC' : 'ASC']
    }),
  )
}

/**
 * Shared handler for the raw-hits routes. `entity` is the index queried unless the
 * request names another one — or asks for a language that has an index of its own,
 * in which case `?locale=` routes to it.
 */
export async function searchHits(
  req: MedusaRequest<unknown, SearchHitsParams>,
  res: MedusaResponse<SearchHitsResponse>,
  entity: string,
) {
  const params = req.validatedQuery
  const facets = toArray(params.facets)
  const search = searchModule(req)
  const { index, locales } = localizedSearch({
    search,
    base: entity,
    requested: params.index,
    locale: requestLocale(req),
    language: params.language,
  })

  const result = await search.search({
    entity: index,
    fields: toArray(params.fields),
    filters: { q: params.query },
    pagination: {
      skip: params.offset,
      take: params.limit,
      order: toOrder(params.sort),
    },
    search_options: {
      ...(locales ? { locales } : {}),
      ...(facets?.length ? { facets } : {}),
      ...(params.semanticSearch
        ? {
            vector: {
              field: params.embedder,
              query: params.query,
              semantic_ratio: params.semanticRatio,
            },
          }
        : {}),
      ...(params.filter ? { provider_options: { [MEILISEARCH_PROVIDER_KEY]: { filter: params.filter } } } : {}),
    },
  })

  res.json(result)
}
