import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type {
  AdminIndexCoverageResponse,
  AdminSearchIndexInfo,
  AdminSearchIndexesResponse,
  AdminSearchResponse,
} from '../../api/admin/meilisearch/types'
import { sdk } from './sdk'

/**
 * Shared by every widget, so that reindexing a product in one of them refreshes
 * the counts the others are showing.
 */
export const INDEXES_KEY = ['meilisearch', 'indexes']

export const coverageKey = (productId: string): string[] => {
  return ['meilisearch', 'coverage', productId]
}

export const useSearchIndexes = (): UseQueryResult<AdminSearchIndexesResponse> => {
  return useQuery({
    queryKey: INDEXES_KEY,
    queryFn: async () => {
      return sdk.client.fetch<AdminSearchIndexesResponse>('/admin/meilisearch/indexes')
    },
  })
}

export const useIndexCoverage = (productId: string): UseQueryResult<AdminIndexCoverageResponse> => {
  return useQuery({
    queryKey: coverageKey(productId),
    queryFn: async () => {
      return sdk.client.fetch<AdminIndexCoverageResponse>(`/admin/meilisearch/products/${productId}/indexes`)
    },
  })
}

export interface AdminSearchInput {
  index?: string
  query?: string
  limit?: number

  /** An id to report the ranking position of, alongside the hits. */
  find?: string

  /** Held off until the widget has something worth asking for. */
  enabled?: boolean
}

export const useAdminSearch = ({
  index,
  query,
  limit,
  find,
  enabled = true,
}: AdminSearchInput): UseQueryResult<AdminSearchResponse> => {
  return useQuery({
    queryKey: ['meilisearch', 'search', index, query, limit, find],
    // The previous page stays on screen while the next one loads, so typing does
    // not empty the table between keystrokes.
    placeholderData: (previous) => {
      return previous
    },
    enabled,
    queryFn: async () => {
      return sdk.client.fetch<AdminSearchResponse>('/admin/meilisearch/search', {
        query: {
          ...(query === undefined ? {} : { query }),
          ...(index === undefined ? {} : { index }),
          ...(limit === undefined ? {} : { limit }),
          ...(find === undefined ? {} : { find }),
        },
      })
    },
  })
}

/**
 * The indexes holding one kind of entity. An index declared without this
 * package's factories reports no entity at all, and is kept rather than dropped:
 * not knowing what an index holds is not evidence that it holds something else.
 */
export const indexesHolding = (entity: string, indexes: AdminSearchIndexInfo[] | undefined): AdminSearchIndexInfo[] => {
  return (indexes ?? []).filter((entry) => {
    return entry.entity === entity || entry.entity === null
  })
}

/** An index as a merchant reads it: its name, and the language it holds if it has one. */
export const indexLabel = ({ name, locale }: { name: string; locale: string | null }): string => {
  return locale === null ? name : `${name} · ${locale}`
}
