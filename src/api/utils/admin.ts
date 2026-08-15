import { SearchTypes } from '@medusajs/types'
import { MedusaError } from '@medusajs/utils'
import { indexLocale } from '../../indexes/locales'
import { AdminIndexedDocumentResponse, AdminSearchIndexInfo } from '../admin/meilisearch/types'

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
 */
export async function describeIndex(
  search: SearchTypes.ISearchModuleService,
  name: string,
): Promise<AdminSearchIndexInfo> {
  const locale = indexLocale(name) ?? null

  try {
    const result = await search.search({
      entity: name,
      pagination: { take: 0 },
      search_options: { count: 'exact' },
    })

    return { name, locale, document_count: result.metadata.count, error: null }
  } catch (error) {
    // A declared index that migrations have not created yet does not exist in
    // Meilisearch, and neither does one whose engine lost its data. Reporting
    // that per index keeps one missing index from taking the listing down.
    return { name, locale, document_count: null, error: toMessage(error) }
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
