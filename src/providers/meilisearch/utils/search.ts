import { SearchTypes } from '@medusajs/types'
import { MedusaError } from '@medusajs/utils'
import type { Locale, MultiSearchQuery, SearchParams, SearchResponse } from 'meilisearch'
import { MEILISEARCH_PROVIDER_KEY } from '../types'
import { MeilisearchIndexPlan } from './definition'
import { fromMeilisearchHit } from './documents'
import { buildFilterExpression } from './filters'
import { shadowPath, toTimestamp } from './values'

const SCORE_KEY = '_score'
const DEFAULT_TAKE = 20

/**
 * One provider query, expanded into the Meilisearch queries that answer it, plus
 * how to fold their responses back into a single result.
 *
 * Most queries expand to one. A range facet costs a query per range and an exact
 * count costs one more, because Meilisearch has neither — batching them through
 * `multiSearch` keeps that a single round trip instead of a burst of them.
 */
export interface PlannedSearch {
  queries: MultiSearchQuery[]
  build(responses: SearchResponse[]): SearchTypes.SearchResult
}

type FacetRequest = Exclude<SearchTypes.SearchFacetRequest, string>

function fail(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message)
}

function notSupported(message: string): never {
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, message)
}

/**
 * The attribute a facet, sort or range is addressed by. A date is held twice —
 * verbatim, and as epoch milliseconds — and only the number can be ordered.
 */
function attribute(path: string, plan: MeilisearchIndexPlan): string {
  return plan.fields.get(path)?.isDate ? shadowPath(path) : path
}

function toNumber(value: number | string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }

  const timestamp = toTimestamp(value)

  if (timestamp !== undefined) {
    return timestamp
  }

  if (typeof value !== 'number') {
    fail(`Range bound "${value}" is neither a number nor a date, so Meilisearch cannot count it`)
  }

  return value
}

function sort(input: SearchTypes.ProviderSearchQuery, plan: MeilisearchIndexPlan): string[] | undefined {
  const order = Object.entries(input.pagination?.order ?? {})

  if (!order.length) {
    return undefined
  }

  const rules = order
    // Relevance is Meilisearch's default ordering, and it has no name in a
    // `sort` expression — asking for it explicitly means asking for the default.
    .filter(([path]) => {
      return path !== SCORE_KEY
    })
    .map(([path, direction]) => {
      return `${attribute(path, plan)}:${direction === 'ASC' ? 'asc' : 'desc'}`
    })

  return rules.length ? rules : undefined
}

function highlight(options: SearchTypes.SearchOptions): Partial<SearchParams> {
  const requested = options.highlight

  if (!requested) {
    return {}
  }

  const snippet = requested.snippet

  return {
    attributesToHighlight: requested.fields,
    highlightPreTag: requested.pre_tag,
    highlightPostTag: requested.post_tag,
    ...(snippet
      ? {
          attributesToCrop: requested.fields,
          cropLength: typeof snippet === 'object' ? snippet.length : undefined,
        }
      : {}),
  }
}

function matchingStrategy(options: SearchTypes.SearchOptions): SearchParams['matchingStrategy'] {
  switch (options.match_strategy) {
    case undefined:
      return undefined
    case 'all':
      return 'all'
    case 'last':
      return 'last'
    default:
      // Meilisearch drops terms from the end ("last") or by frequency, but never
      // matches on any single one, and answering a stricter query than was asked
      // for is indistinguishable from a correct answer.
      notSupported(
        `Meilisearch has no "any" matching strategy — use "last", which drops terms one by one until the query matches`,
      )
  }
}

function vector(options: SearchTypes.SearchOptions): Partial<SearchParams> {
  if (!options.vector) {
    return {}
  }

  const { field, value, semantic_ratio: semanticRatio } = options.vector

  return {
    hybrid: { embedder: field, semanticRatio },
    ...(value ? { vector: value } : {}),
  }
}

/**
 * Refuses a query Meilisearch would answer differently rather than not at all.
 */
function assertSupported(input: SearchTypes.ProviderSearchQuery, plan: MeilisearchIndexPlan): void {
  const options = input.search_options ?? {}

  if (input.pagination?.cursor) {
    notSupported(
      `Meilisearch paginates by offset, so the cursor on search index "${plan.name}" cannot be honoured — use pagination.skip`,
    )
  }

  if (options.typo_tolerance === false) {
    notSupported(
      `Meilisearch sets typo tolerance per index rather than per query, so it cannot be turned off for one search on "${plan.name}" — declare settings.typo_tolerance.enabled on the index instead`,
    )
  }

  if (input.q && !plan.settings.searchableAttributes?.length) {
    fail(`Search index "${plan.name}" has no searchable fields, so it cannot be queried by text`)
  }

  // A result carries one facet per field, so a field asked for twice could only
  // come back as one of the two. Which one is not something to leave to the order
  // the requests happened to be in.
  const fields = facetRequests(options).map((facet) => {
    return facet.field
  })
  const duplicated = fields.filter((field, position) => {
    return fields.indexOf(field) !== position
  })

  if (duplicated.length) {
    fail(
      `Field "${duplicated[0]}" is requested as more than one facet on search index "${plan.name}", and a result holds one facet per field — ask for them in separate queries`,
    )
  }
}

function facetRequests(options: SearchTypes.SearchOptions): FacetRequest[] {
  return (options.facets ?? []).map((facet) => {
    return typeof facet === 'string' ? ({ field: facet, type: 'value' } as FacetRequest) : facet
  })
}

function rangeKey(range: { key?: string; from?: number | string; to?: number | string }): string {
  return range.key ?? `${range.from ?? '*'}-${range.to ?? '*'}`
}

/**
 * A count Meilisearch computes exhaustively rather than estimating. It only does
 * that for page-based pagination, so the exact count is asked for by a query of
 * its own — cheap, since it retrieves nothing, and it keeps the hits on the
 * offset-based pagination the caller asked for.
 */
function exactCountQuery(base: MultiSearchQuery): MultiSearchQuery {
  return {
    ...base,
    facets: undefined,
    attributesToRetrieve: [],
    attributesToHighlight: undefined,
    attributesToCrop: undefined,
    offset: undefined,
    limit: undefined,
    page: 1,
    hitsPerPage: 1,
  }
}

export function planSearch(input: SearchTypes.ProviderSearchQuery, plan: MeilisearchIndexPlan): PlannedSearch {
  assertSupported(input, plan)

  const options = input.search_options ?? {}
  const skip = input.pagination?.skip ?? 0
  const take = input.pagination?.take ?? DEFAULT_TAKE
  const countStrategy = options.count ?? 'estimated'
  const facets = facetRequests(options)
  const retrieved = input.attributes_to_retrieve
  const filter = buildFilterExpression(input.filters, plan)

  // Value and stats facets are computed by Meilisearch alongside the hits; a
  // range facet is not something it has, so each range becomes a count of its own.
  const distributionFacets = facets
    .filter((facet) => {
      return (facet.type ?? 'value') !== 'range'
    })
    .map((facet) => {
      return attribute(facet.field, plan)
    })

  const base: MultiSearchQuery = {
    indexUid: plan.physicalName,
    q: input.q ?? options.vector?.query ?? '',
    filter,
    offset: skip,
    limit: take,
    // The primary key identifies the hit, so it is fetched whether or not it was
    // asked for, and dropped again on the way out.
    attributesToRetrieve: retrieved.includes(plan.primaryKey) ? retrieved : [plan.primaryKey, ...retrieved],
    facets: distributionFacets.length ? distributionFacets : undefined,
    sort: sort(input, plan),
    attributesToSearchOn: options.attributes_to_search_on,
    matchingStrategy: matchingStrategy(options),
    distinct: options.distinct,
    showRankingScore: options.include_score,
    rankingScoreThreshold: options.min_score,
    locales: (options.locales ?? plan.settings.localizedAttributes?.[0]?.locales) as Locale[] | undefined,
    ...highlight(options),
    ...vector(options),
    // The escape hatch goes last, so a caller reaching for a Meilisearch feature
    // this interface does not model can override anything derived above.
    ...((options.provider_options?.[MEILISEARCH_PROVIDER_KEY] ?? {}) as Partial<SearchParams>),
  }

  const queries: MultiSearchQuery[] = [base]
  const ranges: { field: string; request: Extract<FacetRequest, { type: 'range' }>; offset: number }[] = []
  const stats: { field: string; offset: number }[] = []

  for (const facet of facets) {
    if (facet.type === 'range') {
      ranges.push({ field: facet.field, request: facet, offset: queries.length })
      queries.push(
        ...facet.ranges.map((range) => {
          return {
            ...exactCountQuery(base),
            filter: [filter, rangeFilter(attribute(facet.field, plan), range)].filter(Boolean).join(' AND '),
          }
        }),
      )
      continue
    }

    if (facet.type === 'stats') {
      // Meilisearch reports a numeric facet's min and max, but never how many
      // documents carry it, so that count is asked for separately.
      stats.push({ field: facet.field, offset: queries.length })
      queries.push({
        ...exactCountQuery(base),
        filter: [filter, `${attribute(facet.field, plan)} EXISTS`].filter(Boolean).join(' AND '),
      })
    }
  }

  const countOffset = countStrategy === 'exact' ? queries.push(exactCountQuery(base)) - 1 : -1

  return {
    queries,
    build(responses) {
      const [first] = responses

      return {
        hits: first.hits.map((hit) => {
          return {
            id: String((hit as Record<string, unknown>)[plan.primaryKey]),
            score: options.include_score ? (hit as { _rankingScore?: number })._rankingScore : undefined,
            document: fromMeilisearchHit(hit as Record<string, unknown>, {
              retrieved,
              primaryKey: plan.primaryKey,
            }),
            highlights: buildHighlights(hit as Record<string, unknown>, options),
          }
        }),
        facets: buildFacets({ facets, responses, plan, ranges, stats }),
        metadata: {
          skip,
          take,
          count: resolveCount({ strategy: countStrategy, first, responses, countOffset }),
          query: input.q,
          processing_time_ms: first.processingTimeMs,
        },
      }
    },
  }
}

function rangeFilter(field: string, range: { from?: number | string; to?: number | string }): string {
  const from = toNumber(range.from)
  const to = toNumber(range.to)
  // Half-open, so adjacent buckets of a histogram neither overlap nor leave a gap.
  const bounds = [
    from !== undefined ? `${field} >= ${from}` : undefined,
    to !== undefined ? `${field} < ${to}` : undefined,
  ]
  const predicates = bounds.filter((bound): bound is string => {
    return !!bound
  })

  return predicates.length ? predicates.join(' AND ') : `${field} EXISTS`
}

function resolveCount({
  strategy,
  first,
  responses,
  countOffset,
}: {
  strategy: SearchTypes.SearchCountStrategy
  first: SearchResponse
  responses: SearchResponse[]
  countOffset: number
}): number | null {
  if (strategy === 'none') {
    return null
  }

  if (strategy === 'exact') {
    return (responses[countOffset] as { totalHits?: number }).totalHits ?? 0
  }

  return (first as { estimatedTotalHits?: number }).estimatedTotalHits ?? first.hits.length
}

function buildHighlights(
  hit: Record<string, unknown>,
  options: SearchTypes.SearchOptions,
): Record<string, string[]> | undefined {
  const fields = options.highlight?.fields

  if (!fields?.length) {
    return undefined
  }

  const formatted = hit._formatted

  if (!isRecord(formatted)) {
    return undefined
  }

  const highlights: Record<string, string[]> = {}

  for (const field of fields) {
    const value = readPath(formatted, field)
    const entries = (Array.isArray(value) ? value : [value]).filter((entry): entry is string => {
      return typeof entry === 'string'
    })

    if (entries.length) {
      highlights[field] = entries
    }
  }

  return Object.keys(highlights).length ? highlights : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads a dotted path out of a formatted hit. An array on the way through is
 * mapped rather than indexed, because Meilisearch highlights every element of an
 * array of objects and each one may have matched.
 */
function readPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (Array.isArray(value)) {
      return value.map((entry) => {
        return isRecord(entry) ? entry[key] : undefined
      })
    }

    return isRecord(value) ? value[key] : undefined
  }, source)
}

function totalHits(response: SearchResponse | undefined): number {
  return (response as { totalHits?: number } | undefined)?.totalHits ?? 0
}

/**
 * `responses` is the whole batch, indexed exactly as it was planned: the hits at 0,
 * then each range's and each stats field's own count query at the offset recorded
 * while planning.
 */
function buildFacets({
  facets,
  responses,
  plan,
  ranges,
  stats,
}: {
  facets: FacetRequest[]
  responses: SearchResponse[]
  plan: MeilisearchIndexPlan
  ranges: { field: string; request: Extract<FacetRequest, { type: 'range' }>; offset: number }[]
  stats: { field: string; offset: number }[]
}): Record<string, SearchTypes.SearchFacetResult> | undefined {
  if (!facets.length) {
    return undefined
  }

  const [hits] = responses
  const results: Record<string, SearchTypes.SearchFacetResult> = {}

  for (const facet of facets) {
    const key = attribute(facet.field, plan)

    if (facet.type === 'stats') {
      const facetStats = hits.facetStats?.[key]
      const counted = stats.find((entry) => {
        return entry.field === facet.field
      })

      results[facet.field] = {
        type: 'stats',
        min: facetStats?.min ?? 0,
        max: facetStats?.max ?? 0,
        count: counted ? totalHits(responses[counted.offset]) : 0,
      }
      continue
    }

    if (facet.type === 'range') {
      const planned = ranges.find((entry) => {
        return entry.field === facet.field
      })

      results[facet.field] = {
        type: 'range',
        ranges: facet.ranges.map((range, position) => {
          return {
            key: rangeKey(range),
            from: range.from,
            to: range.to,
            count: planned ? totalHits(responses[planned.offset + position]) : 0,
          }
        }),
      }
      continue
    }

    // Meilisearch returns a facet's values unordered and capped by the index'
    // `maxValuesPerFacet`, so ordering and limiting happen here. Ties break on the
    // value itself rather than on whatever order they arrived in, so that `limit`
    // keeps the same values from one request to the next.
    const distribution = hits.facetDistribution?.[key] ?? {}
    const values = Object.entries(distribution)
      .map(([value, count]) => {
        return { value, count }
      })
      .sort((a, b) => {
        return facet.sort === 'alpha'
          ? a.value.localeCompare(b.value)
          : b.count - a.count || a.value.localeCompare(b.value)
      })
    const kept = facet.limit === undefined ? values : values.slice(0, facet.limit)

    results[facet.field] = {
      type: 'value',
      values: kept,
      other_count: values.slice(kept.length).reduce((total, entry) => {
        return total + entry.count
      }, 0),
    }
  }

  return results
}
