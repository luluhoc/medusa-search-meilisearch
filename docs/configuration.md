# Configuration

There are three layers of configuration, and it is worth knowing which is which:

| Layer                | Where                         | Covers                                                   |
| -------------------- | ----------------------------- | -------------------------------------------------------- |
| **Module options**   | The Search Module's `options` | Index naming, which provider is the default, batch sizes |
| **Provider options** | This provider's `options`     | Connecting to Meilisearch, instance-wide defaults        |
| **Index settings**   | Each `defineSearchIndex` call | Fields, synonyms, stop words, typo tolerance, locales    |

## Provider options

```ts
{
  resolve: '@luluhoc/medusa-search-meilisearch/providers/meilisearch',
  id: 'meilisearch',
  options: {
    config: {
      host: process.env.MEILISEARCH_HOST,
      apiKey: process.env.MEILISEARCH_API_KEY,
    },
    settings: { /* applied to every index */ },
    embedders: { /* see semantic-search.md */ },
    taskTimeoutMs: 120_000,
    taskIntervalMs: 50,
  },
}
```

### `config`

The Meilisearch client configuration, passed straight through. `host` is required and the provider refuses to start without it. `apiKey` is required for any instance running with a master key.

Use a key with write access — the provider creates indexes, changes settings and writes documents. Never give this key to a browser; see [store API](store-api.md) for the read-only path.

### `settings`

Meilisearch settings applied to every index this provider manages, _underneath_ whatever the index definition derives. An escape hatch for settings the Search Module's `SearchIndexSettings` has no representation for:

```ts
settings: {
  rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
  separatorTokens: ['|'],
  proximityPrecision: 'byAttribute',
}
```

Precedence, lowest to highest: this option → what the definition derives → the definition's own `settings.provider_options.meilisearch`.

### `embedders`

Embedders registered on every index, for hybrid and semantic search. See [semantic search](semantic-search.md).

### `taskTimeoutMs`

How long to wait for a Meilisearch write to be applied. Default `120000`.

Meilisearch acknowledges a write and applies it afterwards. The Search Module waits for that before it swaps a freshly seeded index in front of reads, which is what makes a rebuild atomic. The default is generous because an index with an embedder only applies a write once it has embedded the batch — a round trip to your embedding provider per document. Waiting longer than necessary costs nothing: the wait polls and returns the moment the task lands.

### `taskIntervalMs`

Polling interval while waiting. Default `50`.

## Module options

These belong to the Search Module, not to this provider.

```ts
{
  resolve: '@medusajs/medusa/search',
  options: {
    index_prefix: process.env.NODE_ENV,
    default_provider: 'meilisearch',
    reindex: { batch_size: 500 },
    providers: [ /* ... */ ],
  },
}
```

### `index_prefix`

Prepended to every physical index name. `index_prefix: 'staging'` puts the `product` index in Meilisearch under `staging_product`.

Set this whenever more than one environment shares a Meilisearch instance. Without it, staging seeds over production's documents.

### `default_provider`

Which provider an index binds to when its definition names none. Only needed with more than one provider registered — for example, products on Meilisearch and a quieter entity on `@medusajs/search-local`:

```ts
providers: [
  { resolve: '@luluhoc/medusa-search-meilisearch/providers/meilisearch', id: 'meilisearch', options: { /* ... */ } },
  { resolve: '@medusajs/medusa/search-local', id: 'local' },
],
default_provider: 'meilisearch',
```

```ts
// src/search/support-article.ts
export default defineSearchIndex({
  name: 'support_article',
  provider: 'local', // this one stays in-process
  // ...
})
```

### `reindex.batch_size`

How many documents are written per batch while seeding. Default `100`.

Raise it for throughput on a large catalogue; lower it if Meilisearch is memory-constrained, or if an embedder makes each batch slow enough to hit `taskTimeoutMs`.

## Index settings

Declared per index, and translated to Meilisearch settings by this provider.

```ts
defineProductSearchIndex({
  settings: {
    synonyms: { tshirt: ['t-shirt', 'tee'] },
    stop_words: ['the', 'a'],
    typo_tolerance: {
      enabled: true,
      min_word_size_for_one_typo: 5,
      min_word_size_for_two_typos: 9,
      disabled_on_attributes: ['sku'],
    },
    faceting: { max_values_per_facet: 200, sort_by: 'count' },
    pagination: { max_total_hits: 5000 },
    distinct_attribute: 'handle',
    locales: ['eng', 'fra'],
    provider_options: {
      meilisearch: { prefixSearch: 'indexingTime' },
    },
  },
})
```

| Setting                        | Becomes                                                                    |
| ------------------------------ | -------------------------------------------------------------------------- |
| `synonyms`                     | `synonyms`                                                                 |
| `stop_words`                   | `stopWords`                                                                |
| `typo_tolerance`               | `typoTolerance`, including `minWordSizeForTypos` and `disableOnAttributes` |
| `faceting`                     | `faceting.maxValuesPerFacet` and `sortFacetValuesBy`                       |
| `pagination`                   | `pagination.maxTotalHits`                                                  |
| `distinct_attribute`           | `distinctAttribute`                                                        |
| `locales`                      | `localizedAttributes`, applied to every attribute                          |
| `provider_options.meilisearch` | Merged last, over everything above                                         |

`searchableAttributes`, `filterableAttributes`, `sortableAttributes` and `displayedAttributes` are not settings you write — they are derived from the fields you declare. See [index definitions](index-definitions.md).

### A note on `pagination.max_total_hits`

Meilisearch will not return or count past this number, which defaults to `1000`. It caps `count: 'exact'` too, so a catalogue larger than that reports `1000` until you raise it. Raising it costs query time on deep pages.

## Worker mode

Seeding only runs in processes with `workerMode` of `worker` or `shared`. A `server`-only process will not spend its boot indexing, which is what you want in a split deployment — but it does mean that if you run _only_ server processes, nothing ever seeds.

Ingestion follows the event bus, so it happens wherever your subscribers run.

## Environment checklist

```env
MEILISEARCH_HOST=http://127.0.0.1:7700
MEILISEARCH_API_KEY=ms
```

In production, additionally:

- A Meilisearch key scoped to write, not the master key
- `index_prefix` if the instance is shared
- `pagination.max_total_hits` raised past your catalogue size if you rely on exact counts
