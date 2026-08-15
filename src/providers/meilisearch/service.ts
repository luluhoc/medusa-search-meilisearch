import { Logger, SearchTypes } from '@medusajs/types'
import { AbstractSearchProviderService, MedusaError } from '@medusajs/utils'
import { EnqueuedTask, Index, MeiliSearch, MeiliSearchApiError, Task, TaskStatus } from 'meilisearch'
import { MEILISEARCH_PROVIDER_KEY, MeilisearchProviderOptions } from './types'
import { assertIndexSupported, buildIndexPlan } from './utils/definition'
import { toMeilisearchDocument } from './utils/documents'
import { buildFilterExpression, extractPrimaryKeyIds } from './utils/filters'
import { planSearch } from './utils/search'

type InjectedDependencies = {
  logger?: Logger
}

const INDEX_NOT_FOUND = 'index_not_found'
// Generous on purpose: a write into an index with an embedder is only applied
// once Meilisearch has embedded the batch, which is a round trip to an embedding
// provider per document. Waiting longer than necessary costs nothing — the wait
// polls and returns the moment the task lands.
const DEFAULT_TASK_TIMEOUT_MS = 120_000

/**
 * Search provider backed by Meilisearch.
 *
 * Meilisearch acknowledges a write and applies it afterwards, so every write here
 * comes back `enqueued` with the task to wait on. `waitForTask` is implemented,
 * which is what lets the Search Module fill a shadow index and only then put it in
 * front of reads.
 */
export class MeilisearchSearchProviderService extends AbstractSearchProviderService {
  static override identifier = MEILISEARCH_PROVIDER_KEY

  protected readonly logger_?: Logger
  protected readonly options_: MeilisearchProviderOptions
  protected readonly client_: MeiliSearch
  /**
   * Primary keys by index name. An index' primary key only changes by being
   * recreated, so this is read once per index rather than on every delete.
   */
  protected readonly primaryKeys_ = new Map<string, string>()

  constructor({ logger }: InjectedDependencies, options: MeilisearchProviderOptions) {
    super()

    assertOptions(options)

    this.logger_ = logger
    this.options_ = options
    this.client_ = new MeiliSearch(options.config)
  }

  override async upsertIndex({
    index,
  }: {
    index: SearchTypes.ResolvedSearchIndexDefinition
  }): Promise<SearchTypes.SearchTask> {
    assertIndexSupported(index)

    const plan = buildIndexPlan(index, this.options_)

    await this.ensureIndex(plan.physicalName, plan.primaryKey)

    // Meilisearch applies an index' tasks in the order they were enqueued, so the
    // documents that follow this land on the updated settings without waiting.
    return this.toTask(await this.client_.index(plan.physicalName).updateSettings(plan.settings))
  }

  override async deleteIndex({ index }: { index: string }): Promise<SearchTypes.SearchTask> {
    this.primaryKeys_.delete(index)

    return this.toTask(await this.client_.deleteIndex(index))
  }

  override async listIndexes(): Promise<SearchTypes.SearchIndexInfo[]> {
    const [stats, indexes] = await Promise.all([this.client_.getStats(), this.client_.getRawIndexes({ limit: 1000 })])

    return indexes.results.map((index) => {
      return {
        name: index.uid,
        provider: MeilisearchSearchProviderService.identifier,
        document_count: Object.hasOwn(stats.indexes, index.uid) ? stats.indexes[index.uid].numberOfDocuments : 0,
        created_at: new Date(index.createdAt),
        updated_at: new Date(index.updatedAt),
      }
    })
  }

  override async upsertDocuments({
    index,
    documents,
  }: {
    index: string
    documents: SearchTypes.SearchDocument[]
  }): Promise<SearchTypes.SearchTask> {
    const payload = documents.map(toMeilisearchDocument)

    return this.toTask(await this.client_.index(index).addDocuments(payload))
  }

  override async deleteDocuments({
    index,
    filters,
  }: SearchTypes.SearchDeleteDocumentsInput): Promise<SearchTypes.SearchTask> {
    const target = this.client_.index(index)
    // Deleting by id is the common case, and Meilisearch has a route for it that
    // skips the search a filtered delete has to run first.
    const ids = extractPrimaryKeyIds(filters, await this.primaryKeyOf(target))

    if (ids) {
      return this.toTask(await target.deleteDocuments(ids))
    }

    const filter = buildFilterExpression(filters)

    if (!filter) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Deleting from Meilisearch index "${index}" requires filters that select something`,
      )
    }

    return this.toTask(await target.deleteDocuments({ filter }))
  }

  override async clearIndex({ index }: { index: string }): Promise<SearchTypes.SearchTask> {
    return this.toTask(await this.client_.index(index).deleteAllDocuments())
  }

  /**
   * Meilisearch has no aliases. What it has is an atomic swap of two indexes'
   * contents, which reaches the same place: the freshly seeded index takes the
   * live name, and the index that was serving until now is left holding the old
   * contents and dropped.
   */
  async swapIndex({ alias, index }: { alias: string; index: string }): Promise<SearchTypes.SearchTask> {
    // A swap needs both sides to exist. On a first build there is nothing under
    // the live name yet, so an empty index stands in for the one being replaced.
    await this.ensureIndex(alias, await this.primaryKeyOf(this.client_.index(index)))

    const swap = await this.client_.swapIndexes([{ indexes: [alias, index], rename: false }])
    const settled = await this.waitForTask(this.toTask(swap))

    if (settled.status === 'succeeded') {
      await this.deleteIndex({ index })
    }

    return settled
  }

  override async search(input: SearchTypes.ProviderSearchQuery): Promise<SearchTypes.SearchResult> {
    const [result] = await this.searchMany([input])

    return result
  }

  /**
   * Every query in the batch — including the extra ones a range facet or an exact
   * count expands into — goes to Meilisearch's multi-search route as a single
   * request.
   */
  async searchMany(inputs: SearchTypes.ProviderSearchQuery[]): Promise<SearchTypes.SearchResult[]> {
    const planned = inputs.map((input) => {
      return planSearch(input, buildIndexPlan(input.index, this.options_))
    })

    if (!planned.length) {
      return []
    }

    const { results } = await this.client_.multiSearch({
      queries: planned.flatMap((plan) => {
        return plan.queries
      }),
    })

    let offset = 0

    return planned.map((plan) => {
      const slice = results.slice(offset, offset + plan.queries.length)

      offset += plan.queries.length

      return plan.build(slice)
    })
  }

  async waitForTask(task: SearchTypes.SearchTask, options?: { timeout_ms?: number }): Promise<SearchTypes.SearchTask> {
    if (!task.id) {
      return task
    }

    const settled = await this.client_.tasks.waitForTask(Number(task.id), {
      timeout: options?.timeout_ms ?? this.options_.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      interval: this.options_.taskIntervalMs,
    })

    return this.fromTask(settled)
  }

  /**
   * Creates the index when it is missing, and rebuilds it when its primary key no
   * longer matches — Meilisearch cannot change one on an index that holds
   * documents. Recreating is safe here: the Search Module only points `upsertIndex`
   * at an index it is about to seed.
   */
  protected async ensureIndex(index: string, primaryKey: string): Promise<void> {
    const existing = await this.retrieveIndex(index)

    this.primaryKeys_.set(index, primaryKey)

    if (existing && existing.primaryKey !== primaryKey) {
      await this.client_.tasks.waitForTask(await this.client_.deleteIndex(index))
    } else if (existing) {
      return
    }

    // Waited on, so that everything enqueued afterwards has an index to land in
    // and a second migration does not try to create it again.
    await this.client_.tasks.waitForTask(await this.client_.createIndex(index, { primaryKey }))
  }

  protected async retrieveIndex(index: string): Promise<{ primaryKey?: string } | undefined> {
    try {
      return await this.client_.getRawIndex(index)
    } catch (error) {
      if (error instanceof MeiliSearchApiError && error.cause?.code === INDEX_NOT_FOUND) {
        return undefined
      }

      throw error
    }
  }

  protected async primaryKeyOf(index: Index): Promise<string> {
    const cached = this.primaryKeys_.get(index.uid)

    if (cached !== undefined) {
      return cached
    }

    const primaryKey = (await index.fetchPrimaryKey()) ?? 'id'

    this.primaryKeys_.set(index.uid, primaryKey)

    return primaryKey
  }

  protected toTask(task: EnqueuedTask): SearchTypes.SearchTask {
    return {
      id: String(task.taskUid),
      index: task.indexUid ?? undefined,
      status: toTaskStatus(task.status),
    }
  }

  protected fromTask(task: Task): SearchTypes.SearchTask {
    return {
      id: String(task.uid),
      index: task.indexUid ?? undefined,
      status: toTaskStatus(task.status),
      error: task.error ? { message: task.error.message, code: task.error.code } : undefined,
    }
  }
}

/**
 * The options arrive from the Search Module's `providers` entry, which passes
 * whatever the configuration file holds — so they are checked here rather than
 * trusted from the declared type.
 */
function assertOptions(options: unknown): asserts options is MeilisearchProviderOptions {
  const config = isRecord(options) ? options.config : undefined

  if (!isRecord(config) || typeof config.host !== 'string' || !config.host) {
    throw new MedusaError(
      MedusaError.Types.INVALID_ARGUMENT,
      'The Meilisearch search provider requires a "config.host" option',
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A canceled task never applied, and the Search Module only distinguishes a write
 * that landed from one that did not.
 */
function toTaskStatus(status: TaskStatus): SearchTypes.SearchTaskStatus {
  switch (status) {
    case 'succeeded':
      return 'succeeded'
    case 'failed':
    case 'canceled':
      return 'failed'
    default:
      return status
  }
}

export default MeilisearchSearchProviderService
