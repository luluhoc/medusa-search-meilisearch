/**
 * The admin routes' response shapes. Deliberately free of imports: the admin
 * widget shares these types with the routes rather than restating them, and
 * everything reachable from `src/admin` is typechecked against a browser
 * configuration that the server-side imports were never written for.
 */

/** One index as the Search Module has it loaded, with what Meilisearch holds for it. */
export interface AdminSearchIndexInfo {
  name: string

  /**
   * The language this index holds, as a BCP 47 tag, for an index declared with
   * `locales`. `null` for an index holding the default language, and for one
   * declared without this package's factories, which have nothing to record it.
   */
  locale: string | null

  /** Exact document count, or `null` when Meilisearch could not answer for it. */
  document_count: number | null

  /**
   * The entity the index was declared over, e.g. `product`. `null` for an index
   * declared without this package's factories, which register nothing to say what
   * it holds — and which therefore cannot be compared against a catalogue count.
   */
  entity: string | null

  /**
   * Why the count is missing. Usually an index that is declared but has not been
   * migrated yet, which is precisely what an admin looking at this list needs to
   * be told. `null` when the index answered.
   */
  error: string | null
}

export interface AdminSearchIndexesResponse {
  indexes: AdminSearchIndexInfo[]
}

/** One entity as it currently stands in one index. */
export interface AdminIndexedDocumentResponse {
  index: string
  id: string
  indexed: boolean

  /**
   * The stored document, with the date shadows the provider maintains already
   * stripped. `null` when the index holds no document under this id.
   */
  document: Record<string, unknown> | null
}

/** Whether one index holds one entity, and how old its copy is. */
export interface AdminIndexCoverageEntry {
  index: string

  /** The language this index holds, or `null` for the default-language one. */
  locale: string | null

  indexed: boolean

  /**
   * The document's own `updated_at`, which is what dates the indexed copy against
   * the entity. `null` when the index holds no document, or when the definition
   * does not index the field.
   */
  updated_at: string | null

  /** Why this index could not be read — an unmigrated index, most often. */
  error: string | null
}

/**
 * One entity across every index that holds its kind. A catalogue indexed per
 * language stores the same product once per index, so "is it indexed?" only has
 * an answer per language.
 */
export interface AdminIndexCoverageResponse {
  id: string
  entries: AdminIndexCoverageEntry[]
}

/** One hit as the engine ranked it. The document is the index' own, shadows stripped. */
export interface AdminSearchHit {
  id: string

  /** Relevance as Meilisearch scored it, between 0 and 1. */
  score: number | null

  document: Record<string, unknown>
}

/** Where one known entity placed in a result set. */
export interface AdminSearchRank {
  id: string

  /** 1-based position among the ranked hits, or `null` when it did not place within `scanned`. */
  position: number | null

  /** How many hits were looked at. */
  scanned: number

  /**
   * Whether the scan reached the end of the result set. With `position: null`,
   * `true` means the entity does not match the query at all, and `false` only
   * means it did not place in the first `scanned` hits.
   */
  exhausted: boolean
}

/** A search run against one index from the dashboard, in the engine's own terms. */
export interface AdminSearchResponse {
  index: string
  query: string | null
  hits: AdminSearchHit[]

  /** Exact total, since an admin comparing it against a catalogue count needs one. */
  count: number | null

  processing_time_ms: number | null

  /** Present only when the request asked where a given id placed. */
  rank: AdminSearchRank | null
}
