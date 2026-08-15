import { Event, SearchTypes } from '@medusajs/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is string {
  return typeof value === 'string'
}

/**
 * The rows of a `query.graph` result that can be indexed. `query.graph` is typed
 * loosely, and a document without an id is one no engine can store, so anything
 * else is dropped rather than asserted away.
 */
export function toEntities(data: unknown): SearchEntity[] {
  if (!Array.isArray(data)) {
    return []
  }

  return data.filter((entry): entry is SearchEntity => {
    return isRecord(entry) && isId(entry.id)
  })
}

/** How many entities are read from `query.graph` per round trip while seeding. */
export const DEFAULT_BATCH_SIZE = 200

export type SearchEntity = Record<string, unknown> & { id: string }

export interface SearchIndexFactoryOptions {
  /**
   * The index' name, which is also what `query.search` addresses it by. Change it
   * to run more than one index over the same entity — one per language, say.
   *
   * @default the entity's own name
   */
  name?: string

  /**
   * Which registered search provider holds this index. Defaults to the Search
   * Module's only provider, or to its `default_provider` option.
   */
  provider?: string

  /**
   * The index' fields, as plain definitions or a `search.define({ ... })` schema.
   * Spread the exported defaults to add to them rather than replace them.
   */
  fields?: SearchTypes.SearchIndexFieldsInput

  /** Synonyms, stop words, typo tolerance, faceting, locales. */
  settings?: SearchTypes.SearchIndexSettings

  /**
   * The events that change what belongs in this index. Replacing the default list
   * takes over routing entirely — the Search Module subscribes to exactly what is
   * declared here.
   */
  events?: string[]

  /**
   * The `query.graph` selection used to build documents. Extend it alongside
   * `fields` when adding a field, so there is something to put in it.
   */
  graph_fields?: string[]

  /**
   * Which entities belong in the index at all, e.g. `{ status: 'published' }`.
   * Applied to both seeding and ingestion, so an entity that stops matching is
   * removed from the index rather than left behind.
   */
  filters?: Record<string, unknown>

  /** @default 200 */
  batch_size?: number

  /**
   * The locale to read entities in while seeding and ingesting, e.g. `'fr-FR'`.
   * `query.graph` resolves it through the Translation Module, so the documents
   * hold that language's text rather than the default one — which is what makes
   * an index per language searchable in that language.
   *
   * Requires the `translation` feature flag and translations for the locale;
   * without either, `query.graph` returns the untranslated entity.
   */
  locale?: string

  /**
   * Turns an entity from `query.graph` into the document to index. Defaults to the
   * entity itself, which is why `graph_fields` and `fields` are declared to match.
   */
  transform?: (entity: SearchEntity) => SearchTypes.SearchDocument
}

/**
 * A DSL schema compiles to plain field definitions. Doing it here rather than
 * leaving it to `defineSearchIndex` keeps the documents a factory's `seed` yields
 * typed as plain search documents: inference off a DSL schema would type them
 * against fields the caller can replace wholesale.
 */
export function toFieldDefinitions(
  fields: SearchTypes.SearchIndexFieldsInput,
): Record<string, SearchTypes.SearchFieldDefinition> {
  return isFieldsSchema(fields) ? fields.toFields() : fields
}

function isFieldsSchema(fields: SearchTypes.SearchIndexFieldsInput): fields is SearchTypes.SearchFieldsSchemaLike {
  return 'toFields' in fields && typeof fields.toFields === 'function'
}

/**
 * The entity ids an event carries. Medusa emits one entity, a list of them, or a
 * bare id, depending on whether the event came from a module or from a workflow,
 * so all three are accepted.
 */
export function eventEntityIds(event: Event<unknown>): string[] {
  const entries = Array.isArray(event.data) ? event.data : [event.data]

  return entries.flatMap((entry) => {
    if (typeof entry === 'string') {
      return [entry]
    }

    if (!isRecord(entry)) {
      return []
    }

    const ids = Array.isArray(entry.ids) ? entry.ids : [entry.id]

    return ids.filter(isId)
  })
}

/**
 * Reads an entity in batches, ordered and paged by id rather than by offset: a
 * seed can take a while, and an offset would skip or repeat rows as documents are
 * created underneath it. The id of the last document of the previous run comes
 * back as `last_key`, which is what makes an interrupted seed resumable.
 */
export async function* streamEntities({
  container,
  entity,
  fields,
  filters,
  take,
  last_key: lastKey,
  locale,
}: {
  container: SearchTypes.SearchContainer
  entity: string
  fields: string[]
  filters?: Record<string, unknown>
  take: number
  last_key?: string
  locale?: string
}): AsyncIterable<SearchEntity[]> {
  let cursor = lastKey

  for (;;) {
    const { data } = await container.query.graph(
      {
        entity,
        fields,
        filters: { ...filters, ...(cursor ? { id: { $gt: cursor } } : {}) },
        pagination: { take, order: { id: 'ASC' } },
      },
      { locale },
    )

    const batch = toEntities(data)

    if (!batch.length) {
      return
    }

    yield batch

    cursor = batch[batch.length - 1].id

    if (batch.length < take) {
      return
    }
  }
}

/**
 * Turns a set of ids into the writes that bring the index back in line with the
 * database. Ids that no longer come back — deleted, or no longer matching
 * `filters` because a product was unpublished — are deleted from the index, which
 * is the same rule the seed applies.
 */
export async function reconcileIds({
  container,
  entity,
  fields,
  filters,
  ids,
  transform,
  locale,
}: {
  container: SearchTypes.SearchContainer
  entity: string
  fields: string[]
  filters?: Record<string, unknown>
  ids: string[]
  transform: (entity: SearchEntity) => SearchTypes.SearchDocument
  locale?: string
}): Promise<SearchTypes.SearchMutation[]> {
  if (!ids.length) {
    return []
  }

  const { data } = await container.query.graph(
    {
      entity,
      fields,
      filters: { ...filters, id: ids },
    },
    { locale },
  )

  const found = toEntities(data)
  const indexed = new Set(
    found.map((record) => {
      return record.id
    }),
  )
  const removed = ids.filter((id) => {
    return !indexed.has(id)
  })

  return [
    ...(found.length ? [{ action: 'upsert' as const, documents: found.map(transform) }] : []),
    ...(removed.length ? [{ action: 'delete' as const, filters: { id: removed } }] : []),
  ]
}
