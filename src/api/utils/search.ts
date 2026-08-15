import { MedusaRequest } from '@medusajs/framework'
import { SearchTypes } from '@medusajs/types'
import { Modules } from '@medusajs/utils'
import { MeiliParams } from '../types'

export const DEFAULT_MEILI_PARAMS: MeiliParams = {
  semanticSearch: false,
  semanticRatio: 0.5,
  embedder: 'default',
}

export function meiliParams(req: MedusaRequest): MeiliParams {
  return req.meiliParams ?? DEFAULT_MEILI_PARAMS
}

/**
 * Whether the request asks for a search at all. Without it these routes are their
 * native counterparts, down to the middleware stack.
 */
export function isSearchRequest(params: MeiliParams): boolean {
  return !!params.query || params.semanticSearch
}

export function searchModule(req: MedusaRequest): SearchTypes.ISearchModuleService {
  return req.scope.resolve<SearchTypes.ISearchModuleService>(Modules.SEARCH)
}

/**
 * The search options every route shares. Semantic search is expressed as a vector
 * query against a named embedder; whether that embedder exists is the index'
 * business, and the provider says so if it does not.
 */
export function searchOptions(params: MeiliParams, extra?: SearchTypes.SearchOptions): SearchTypes.SearchOptions {
  return {
    ...(params.language ? { locales: [params.language] } : {}),
    ...(params.semanticSearch
      ? {
          vector: {
            field: params.embedder,
            query: params.query,
            semantic_ratio: params.semanticRatio,
          },
        }
      : {}),
    ...extra,
  }
}

/**
 * Reorders entities read from the database back into the order the engine ranked
 * their ids in. `query.graph` orders by its own rules, and relevance is the whole
 * point of having searched.
 */
export function orderByRelevance<T extends { id: string }>(entities: T[], ids: string[]): T[] {
  const rank = new Map(
    ids.map((id, position) => {
      return [id, position]
    }),
  )

  return [...entities].sort((left, right) => {
    return (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0)
  })
}
