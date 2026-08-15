# Migrating from `@rokmohar/medusa-plugin-meilisearch`

Medusa `2.19.0` removed the search interface that plugin was built on (`SearchUtils.AbstractSearchService`, `SearchUtils.indexTypes`, `SearchTypes.IndexSettings`) and replaced it with the Search Module. This package is the rewrite onto that module.

That makes the move a hard one — v1 does not run on Medusa `2.19.0`, and this package does not run below it. Plan to do both upgrades together.

## What moved where

| Before                                                 | Now                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `plugins[].options.settings`, keyed by index name      | One index declaration per file under `src/search/`                                 |
| `type: 'products' \| 'categories'`                     | `defineProductSearchIndex()` / `defineCategorySearchIndex()`                       |
| `fields: ['id', 'title', 'variants.*']`                | `graph_fields`                                                                     |
| `indexSettings.searchableAttributes` etc.              | Derived from the field declarations — you declare intent, not Meilisearch settings |
| `indexSettings.synonyms`, `stopWords`, `typoTolerance` | `settings.synonyms`, `settings.stop_words`, `settings.typo_tolerance`              |
| `transformer(doc, defaultTransformer, options)`        | `transform(entity)`                                                                |
| `primaryKey`                                           | `primary_key`                                                                      |
| `enabled: false`                                       | Delete the file                                                                    |
| The plugin's 24 subscribers and 26 workflows           | The module's ingestion, from each index' `events` and `consume`                    |
| The plugin's cron jobs                                 | Seeding at boot, plus `searchModule.reindex()`                                     |
| `container.resolve(MEILISEARCH_MODULE)`                | `container.resolve(Modules.SEARCH)`                                                |
| `meilisearchService.search(index, query, opts)`        | `searchModule.search({ entity, filters: { q } })`                                  |
| `/admin/meilisearch/*` and the admin settings page     | Removed — Medusa `2.19` has its own admin search endpoint                          |
| `i18n.strategy: 'separate-index' \| 'field-suffix'`    | `locales` on the factory, or `settings.locales`                                    |
| Raw Meilisearch hits from `*-hits` routes              | The module's `{ hits, facets, metadata }` shape                                    |

## Step by step

### 1. Upgrade

```bash
yarn remove @rokmohar/medusa-plugin-meilisearch
yarn add @medusajs/medusa@^2.19.0 @medusajs/framework@^2.19.0 @luluhoc/medusa-search-meilisearch
```

### 2. Rewrite the config

Before:

```ts
plugins: [
  {
    resolve: '@rokmohar/medusa-plugin-meilisearch',
    options: {
      config: { host: process.env.MEILISEARCH_HOST, apiKey: process.env.MEILISEARCH_API_KEY },
      settings: {
        products: {
          type: 'products',
          enabled: true,
          fields: ['id', 'title', 'description', 'handle', 'thumbnail', 'variants.sku'],
          indexSettings: {
            searchableAttributes: ['title', 'description', 'variants.sku'],
            displayedAttributes: ['id', 'handle', 'title', 'thumbnail'],
            filterableAttributes: ['id', 'handle'],
          },
          primaryKey: 'id',
        },
      },
    },
  },
]
```

After — the plugin entry keeps only what the store routes need, and the Search Module gets the provider:

```ts
plugins: [{ resolve: '@luluhoc/medusa-search-meilisearch', options: {} }],
modules: [
  {
    resolve: '@medusajs/medusa/search',
    options: {
      providers: [
        {
          resolve: '@luluhoc/medusa-search-meilisearch/providers/meilisearch',
          id: 'meilisearch',
          options: {
            config: { host: process.env.MEILISEARCH_HOST, apiKey: process.env.MEILISEARCH_API_KEY },
          },
        },
      ],
    },
  },
]
```

### 3. Turn each `settings` entry into a definition

```ts
// src/search/product.ts
import { search } from '@medusajs/framework/utils'
import { defineProductSearchIndex } from '@luluhoc/medusa-search-meilisearch/indexes'

export default defineProductSearchIndex({
  fields: search.define({
    id: search.keyword().filterable(),
    handle: search.keyword().filterable(),
    title: search.text().searchable({ weight: 5 }),
    description: search.text().searchable(),
    thumbnail: search.keyword(),
    variants: search.object({ sku: search.keyword().searchable({ weight: 3 }) }).array(),
  }),
  graph_fields: ['id', 'title', 'description', 'handle', 'thumbnail', 'variants.sku'],
})
```

Note what disappeared: `searchableAttributes`, `displayedAttributes` and `filterableAttributes` are no longer written by hand. `.searchable()` puts a field in the first, any field not marked `.retrievable(false)` is in the second, and `.filterable()` in the third. One place to change instead of two that can disagree.

If your old field list matches the defaults, most of this collapses to:

```ts
export default defineProductSearchIndex()
```

### 4. Port your transformer

```ts
// before
transformer: async (product, defaultTransformer) => ({
  ...defaultTransformer(product),
  brand: product.brand?.name,
})

// after
transform: (product) => ({ ...product, brand: product.brand?.name })
```

There is no `defaultTransformer` — the default is the entity itself. Anything the transformer produced has to be declared in `fields` to be searchable, filterable or returned.

The old transformer received the container for resolving services; `transform` is synchronous and receives only the entity. If you need to enrich from elsewhere, fetch it in `graph_fields`, or do the work in a custom `seed`.

### 5. Delete the old machinery

Anything that called `MEILISEARCH_MODULE` or the old service can go: custom subscribers, workflows, the sync jobs, admin widgets. Ingestion, seeding and rebuilds are the module's now.

### 6. Migrate and boot

```bash
npx medusa db:migrate
npx medusa develop
```

The indexes are created empty and filled on boot. Watch for:

```
[Search] Seeding 1 index(es): product (index_created)
```

### 7. Update the callers

```ts
// before
const meili = container.resolve(MEILISEARCH_MODULE)
const results = await meili.search('products', 'shirt', { paginationOptions: { limit: 20 } })
results.hits

// after
const search = container.resolve(Modules.SEARCH)
const { hits } = await search.search({
  entity: 'product',
  filters: { q: 'shirt' },
  pagination: { take: 20 },
})
```

### 8. Clean up

The old physical indexes are untouched by any of this. Once the new ones are serving, delete them:

```bash
curl -X DELETE 'http://localhost:7700/indexes/products' -H 'Authorization: Bearer <KEY>'
```

## Store endpoint changes

The four `/store/meilisearch/*` routes are still there and still behave the same way, with three differences:

- **`*-hits` responses changed shape.** Meilisearch's raw `{ hits, estimatedTotalHits, processingTimeMs }` became the module's `{ hits, facets, metadata }`, where each hit is `{ id, score?, document, highlights? }` — the document is nested rather than spread across the hit.
- **New parameters:** `index`, `embedder`, `facets`, `fields`, `sort`.
- **A pagination bug is fixed.** In v1, `/store/meilisearch/products` re-paginated the already-paginated id set, so any page past the first came back empty. It no longer does.

`query`, `limit`, `offset`, `language`, `semanticSearch`, `semanticRatio` and `filter` all still work.

## i18n

The old `separate-index` and `field-suffix` strategies are gone, because index naming belongs to the module now.

`separate-index` becomes [one index per language](i18n.md) — the same idea, declared rather than configured, and fed by the Translation Module instead of by whatever populated the suffixed fields. `locales: ['fr-FR', 'de-DE']` on the factory declares the whole set, and the store routes pick between them by the request's `locale`:

```ts
export default defineProductSearchIndex({ default_locale: 'en-US', locales: ['fr-FR', 'de-DE'] })
```

The index names differ from the old plugin's — `product-fr-FR` rather than `products_fr` — so a storefront that hardcoded them should move to sending `?locale=fr-FR` instead, which no longer names an index at all.

`field-suffix` has no direct equivalent. Either move to per-language indexes, or keep one index and declare `settings.locales` with a `locales` hint per query — the latter only changes tokenization, so a single index still holds a single language.

## Semantic search

The old `vectorSearch: { enabled, embedding: { provider, model } }` block becomes an `embedders` entry on the provider, which is Meilisearch's own configuration rather than a wrapper over it. Ollama and OpenAI are both still supported, plus Hugging Face, any REST endpoint, and user-provided vectors. See [semantic search](semantic-search.md).

At query time, `semanticSearch: true` / `semanticRatio` on the store routes are unchanged; from code it is now `search_options.vector`.

## If you cannot upgrade yet

Stay on `@rokmohar/medusa-plugin-meilisearch` and Medusa `2.18.x` or earlier. The two packages cannot be mixed — they target different Medusa versions, not different feature sets.
