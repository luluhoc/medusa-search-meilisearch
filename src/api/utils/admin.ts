import { SearchTypes } from '@medusajs/types'
import { MedusaError } from '@medusajs/utils'
import { EntityIndex, indexEntity, indexesForEntity, indexLocale } from '../../indexes/locales'
import {
  AdminIndexCoverageEntry,
  AdminIndexCoverageResponse,
  AdminIndexedDocumentResponse,
  AdminSearchIndexInfo,
  AdminSearchRank,
  AdminSearchResponse,
} from '../admin/meilisearch/types'

/** The index an admin route reads from when the request names none. */
export const DEFAULT_INDEX = 'product'

/**
 * The event name a product update travels under. Routing one through the Search
 * Module is what reindexes a single product: the index' own `consume` turns it
 * into the writes that bring the document back in line with the database, which
 * includes deleting a product that no longer belongs in the index at all.
 */
export const PRODUCT_UPDATED_EVENT = 'product.updated'

/**
 * Which index a request addresses. Named indexes are checked against what the
 * Search Module actually loaded, because a typo would otherwise come back as an
 * empty result that reads like "this product is not indexed".
 */
export function resolveIndexName(available: string[], requested?: string): string {
  if (!available.length) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'No search index is declared. Add one under "src/search" in your Medusa application.',
    )
  }

  if (requested === undefined) {
    return available.includes(DEFAULT_INDEX) ? DEFAULT_INDEX : available[0]
  }

  if (!available.includes(requested)) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Unknown search index "${requested}". Declared indexes: ${available.join(', ')}`,
    )
  }

  return requested
}

/**
 * One index and how many documents it holds. The count is asked for exhaustively
 * rather than estimated — an admin comparing it against a product count is the
 * one caller for whom "about 1000" is not an answer.
 *
 * Exhaustive only up to the index' `maxTotalHits`, which Meilisearch also caps
 * `totalHits` at. The provider derives that ceiling well above a catalogue for
 * exactly this reason, but an index whose settings predate that — or that pins a
 * lower ceiling — reports the ceiling instead of its size.
 */
export async function describeIndex(
  search: SearchTypes.ISearchModuleService,
  name: string,
): Promise<AdminSearchIndexInfo> {
  const locale = indexLocale(name) ?? null
  const entity = indexEntity(name) ?? null

  try {
    const result = await search.search({
      entity: name,
      pagination: { take: 0 },
      search_options: { count: 'exact' },
    })

    return { name, locale, entity, document_count: result.metadata.count, error: null }
  } catch (error) {
    // A declared index that migrations have not created yet does not exist in
    // Meilisearch, and neither does one whose engine lost its data. Reporting
    // that per index keeps one missing index from taking the listing down.
    return { name, locale, entity, document_count: null, error: toMessage(error) }
  }
}

/**
 * The document an index holds for one entity. Read by filtering on the primary
 * key rather than by a dedicated route, because that is the only lookup the
 * Search Module's interface has — which also means the index' id field has to be
 * filterable, as it is in every definition this package ships.
 */
export async function retrieveIndexedDocument(
  search: SearchTypes.ISearchModuleService,
  index: string,
  id: string,
): Promise<AdminIndexedDocumentResponse> {
  const result = await search.search({
    entity: index,
    filters: { id },
    pagination: { take: 1 },
  })
  const hit = result.hits.at(0)

  return { index, id, indexed: hit !== undefined, document: hit?.document ?? null }
}

/**
 * One entity as every index holding its kind has it. Each index is read on its
 * own and reports its own failure, for the same reason the listing does: a
 * language whose index was never migrated must not hide the languages that were.
 *
 * Only what the coverage view needs comes back — whether the document is there
 * and how old it is — rather than the documents themselves, which are the same
 * product repeated once per language.
 */
export async function describeCoverage(
  search: SearchTypes.ISearchModuleService,
  { entity, base, id }: { entity: string; base: string; id: string },
): Promise<AdminIndexCoverageResponse> {
  const indexes = indexesForEntity({ available: search.listIndexes(), entity, base })
  const entries = await Promise.all(
    indexes.map(async (entry) => {
      return coverageEntry(search, entry, id)
    }),
  )

  return { id, entries }
}

async function coverageEntry(
  search: SearchTypes.ISearchModuleService,
  { index, locale }: EntityIndex,
  id: string,
): Promise<AdminIndexCoverageEntry> {
  try {
    const { indexed, document } = await retrieveIndexedDocument(search, index, id)

    return { index, locale: locale ?? null, indexed, updated_at: documentUpdatedAt(document), error: null }
  } catch (error) {
    return { index, locale: locale ?? null, indexed: false, updated_at: null, error: toMessage(error) }
  }
}

/**
 * When the indexed copy was built, read off the document rather than off the
 * engine, which records nothing per document. A definition that does not index
 * `updated_at` therefore dates nothing, and the caller is told so with `null`
 * instead of being given a guess.
 */
function documentUpdatedAt(document: Record<string, unknown> | null): string | null {
  const value = document?.updated_at

  return typeof value === 'string' ? value : null
}

/**
 * A search run from the dashboard, against the engine and nothing else. No
 * database read and no pricing: the point is to see the ranking Meilisearch
 * itself produced, which is the only thing that explains why a product is or is
 * not where a merchant expected it.
 */
export async function searchIndexed(
  search: SearchTypes.ISearchModuleService,
  { index, query, limit, offset, facets, vector, find, scan }: AdminSearchInput,
): Promise<AdminSearchResponse> {
  const page: SearchTypes.SearchQuery = {
    entity: index,
    filters: { q: query },
    pagination: { skip: offset, take: limit },
    search_options: {
      include_score: true,
      count: 'exact',
      ...(facets?.length ? { facets } : {}),
      ...(vector ? { vector } : {}),
    },
  }

  // The ranking scan is batched with the page rather than sent after it: the
  // provider folds a `searchMany` into a single Meilisearch `multiSearch`, so
  // asking where one product placed costs no extra round trip.
  const results = await search.searchMany(
    find === undefined
      ? [page]
      : [
          page,
          {
            entity: index,
            fields: ['id'],
            filters: { q: query },
            pagination: { skip: 0, take: scan },
            ...(vector ? { search_options: { vector } } : {}),
          },
        ],
  )
  const result = results[0]

  return {
    index,
    query: query ?? null,
    hits: result.hits.map((hit) => {
      return { id: hit.id, score: hit.score ?? null, document: hit.document }
    }),
    count: result.metadata.count,
    processing_time_ms: result.metadata.processing_time_ms ?? null,
    rank: find === undefined ? null : rankOf(find, results[1], scan),
  }
}

export interface AdminSearchInput {
  index: string
  query?: string
  limit: number
  offset: number
  facets?: string[]
  vector?: SearchTypes.SearchVectorOptions

  /** The id to report the ranking position of, when the caller asks for one. */
  find?: string

  /** How deep to look for `find` before reporting it unplaced. */
  scan: number
}

/**
 * Where an id placed among the hits that were scanned. Reported as a position
 * rather than as a yes-or-no, because "it matches, at rank 340" and "it does not
 * match at all" are different problems with different fixes.
 */
function rankOf(id: string, scanned: SearchTypes.SearchResult, scan: number): AdminSearchRank {
  const position = scanned.hits.findIndex((hit) => {
    return hit.id === id
  })

  return {
    id,
    position: position === -1 ? null : position + 1,
    scanned: scanned.hits.length,
    // Fewer hits than were asked for means the result set ended inside the scan,
    // which is what separates "does not match" from "did not place in the first N".
    exhausted: scanned.hits.length < scan,
  }
}

/**
 * Brings one entity's documents back in line with the database.
 *
 * The event is routed through the module rather than the entity being upserted
 * directly, so that the index' own `consume` decides what happens: an entity
 * that stopped matching the index' filters — a product moved back to draft, say
 * — is deleted from the index rather than left behind as a stale hit. Every
 * index declaring that event is reconciled, which is what makes one press of the
 * button cover a set of per-language indexes.
 *
 * An index with a custom `events` list may not declare the event at all, and
 * then there is nothing to route. Such an index is rebuilt from its own `seed`
 * over this id alone. That path only ever writes, which is why it is the
 * fallback rather than the rule.
 */
export async function reindexEntity(
  search: SearchTypes.ISearchModuleService,
  { index, id, event }: { index: string; id: string; event: string },
): Promise<void> {
  const tasks = await search.ingest({ name: event, data: { id } })

  if (tasks.length) {
    return
  }

  await search.reindex({ index, strategy: 'in_place', filters: { id } })
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
