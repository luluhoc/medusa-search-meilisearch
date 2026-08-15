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
