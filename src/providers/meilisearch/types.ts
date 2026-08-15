import type { Config, Embedders, Settings } from 'meilisearch'

/**
 * Options passed to the provider from the Search Module's `providers` entry:
 *
 * ```ts
 * {
 *   resolve: '@medusajs/medusa/search',
 *   options: {
 *     providers: [
 *       {
 *         resolve: '@luluhoc/medusa-search-meilisearch/providers/meilisearch',
 *         id: 'meilisearch',
 *         options: { config: { host: '...', apiKey: '...' } },
 *       },
 *     ],
 *   },
 * }
 * ```
 */
export interface MeilisearchProviderOptions {
  /**
   * Meilisearch client configuration. `host` is required; `apiKey` is required
   * for any instance that is not running with a disabled master key.
   */
  config: Config

  /**
   * Meilisearch settings merged into every index this provider manages, applied
   * before the settings derived from the index definition. An escape hatch for
   * settings the Search Module's `SearchIndexSettings` has no representation for
   * (`rankingRules`, `separatorTokens`, `proximityPrecision`, ...).
   *
   * Per-index overrides belong on the definition itself, under
   * `settings.provider_options.meilisearch`.
   */
  settings?: Settings

  /**
   * Embedders registered on every index this provider manages, for hybrid and
   * semantic search. Reference one by name from a query's
   * `search_options.vector.field`.
   *
   * A `vector` field in an index definition configures its own embedder from
   * `provider_options.meilisearch`, so this is for embedders that are shared
   * across indexes, or that Meilisearch generates itself from a
   * `documentTemplate` rather than from a stored vector.
   */
  embedders?: Embedders

  /**
   * How long to wait for a Meilisearch task to be applied, in milliseconds.
   * Writes are asynchronous, so the Search Module waits on them before it swaps
   * a freshly seeded index in front of reads.
   *
   * @default 30000
   */
  taskTimeoutMs?: number

  /**
   * Polling interval while waiting for a task, in milliseconds.
   *
   * @default 50
   */
  taskIntervalMs?: number
}

/**
 * Per-index Meilisearch settings, read off a definition's
 * `settings.provider_options.meilisearch`. Merged over both the provider-wide
 * `settings` option and everything derived from the definition's fields, so it
 * always wins.
 */
export type MeilisearchIndexOptions = Settings

/**
 * Per-field Meilisearch options, read off a field's
 * `provider_options.meilisearch`. On a `vector` field the embedder configuration
 * lives here and is registered under the field's own name.
 */
export interface MeilisearchFieldOptions {
  /**
   * Embedder definition for a `vector` field. `dimensions` defaults to the
   * field's own `dimensions`, and the source defaults to `userProvided` — the
   * one source that matches a vector the seed writes into the document itself.
   */
  embedder?: Record<string, unknown>
}

export const MEILISEARCH_PROVIDER_KEY = 'meilisearch'
