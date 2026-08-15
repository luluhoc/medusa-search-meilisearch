# Getting started

From nothing to a working product search in five steps.

## 1. Install

```bash
yarn add @luluhoc/medusa-search-meilisearch
```

You need Medusa `2.19.0` or newer — that is the release the Search Module arrived in — and a Meilisearch instance on `1.12` or newer.

For local development:

```yml
# docker-compose.yml
services:
  meilisearch:
    image: getmeili/meilisearch:latest
    ports:
      - '7700:7700'
    volumes:
      - ./data.ms:/data.ms
    environment:
      - MEILI_MASTER_KEY=ms
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:7700/health']
      interval: 10s
      timeout: 5s
      retries: 5
```

```env
# .env
MEILISEARCH_HOST=http://127.0.0.1:7700
MEILISEARCH_API_KEY=ms
```

## 2. Register the module and the provider

The Search Module is not part of Medusa's defaults, so nothing indexes until you add it. The plugin entry is only needed if you want the [store endpoints](store-api.md).

```ts
// medusa-config.ts
import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

module.exports = defineConfig({
  projectConfig: {
    // ...
  },
  plugins: [
    {
      resolve: '@luluhoc/medusa-search-meilisearch',
      options: {},
    },
  ],
  modules: [
    {
      resolve: '@medusajs/medusa/search',
      options: {
        providers: [
          {
            resolve: '@luluhoc/medusa-search-meilisearch/providers/meilisearch',
            id: 'meilisearch',
            options: {
              config: {
                host: process.env.MEILISEARCH_HOST,
                apiKey: process.env.MEILISEARCH_API_KEY,
              },
            },
          },
        ],
      },
    },
  ],
})
```

See [configuration](configuration.md) for every option on both.

## 3. Declare an index

An index is a file under `src/search/`. Medusa loads that directory at boot and hands what it finds to the Search Module.

```ts
// src/search/product.ts
import { defineProductSearchIndex } from '@luluhoc/medusa-search-meilisearch/indexes'

export default defineProductSearchIndex()
```

```ts
// src/search/category.ts
import { defineCategorySearchIndex } from '@luluhoc/medusa-search-meilisearch/indexes'

export default defineCategorySearchIndex()
```

That is the whole setup. The product index covers published products with their collection, type, categories, tags and variants; the category index covers active, non-internal categories. Both know how to fill themselves and how to stay current.

Everything about them is replaceable — see [index definitions](index-definitions.md).

## 4. Create the indexes

```bash
npx medusa db:migrate
```

This creates the physical Meilisearch indexes and applies their settings. It does not fill them.

## 5. Start the app

```bash
npx medusa develop
```

On boot the Search Module seeds any index that is new, empty, or whose declaration changed. You will see:

```
[Search] Seeding 2 index(es): product (index_created), category (index_created)
```

Once that finishes, search:

```ts
import { Modules } from '@medusajs/framework/utils'

const search = container.resolve(Modules.SEARCH)

const { hits, metadata } = await search.search({
  entity: 'product',
  fields: ['id', 'title', 'thumbnail'],
  filters: { q: 'shirt' },
  pagination: { take: 20 },
})
```

Or over HTTP, if you registered the plugin:

```bash
curl 'http://localhost:9000/store/meilisearch/products-hits?query=shirt' \
  -H 'x-publishable-api-key: pk_...'
```

## What happens from here

- **A product changes.** Medusa emits an event, the Search Module routes it to every index that declared it, and the document is rewritten. Unpublish a product and it is removed, because the index' `filters` no longer match it.
- **You change a field.** The next `db:migrate` builds the new schema beside the live index; the boot after it fills the new one and swaps it in. Reads never see a half-built index.
- **The engine loses its data.** The next boot notices the index is empty and seeds it again.

## Where to go next

| I want to…                                          | Read                                      |
| --------------------------------------------------- | ----------------------------------------- |
| Add a field, or index something other than products | [Index definitions](index-definitions.md) |
| Filter, sort, facet, paginate                       | [Querying](querying.md)                   |
| Use the HTTP endpoints                              | [Store API](store-api.md)                 |
| Search by meaning rather than words                 | [Semantic search](semantic-search.md)     |
| Index prices, or run one index per language         | [Recipes](recipes.md)                     |
| Understand every provider option                    | [Configuration](configuration.md)         |
| Work out why something is not indexed               | [Troubleshooting](troubleshooting.md)     |
| Move off `@rokmohar/medusa-plugin-meilisearch`      | [Migration](migration.md)                 |
