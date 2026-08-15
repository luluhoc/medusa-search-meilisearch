<div align="center">

# Meilisearch for Medusa v2

**A [Meilisearch](https://www.meilisearch.com/) provider for the Medusa Search Module.**

[![npm](https://img.shields.io/npm/v/@luluhoc/medusa-search-meilisearch.svg)](https://www.npmjs.com/package/@luluhoc/medusa-search-meilisearch)
[![CI](https://github.com/luluhoc/medusa-search-meilisearch/actions/workflows/ci.yml/badge.svg)](https://github.com/luluhoc/medusa-search-meilisearch/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@luluhoc/medusa-search-meilisearch.svg)](LICENSE)

</div>

Medusa `2.19` introduced the **Search Module**: you declare an index, and Medusa creates it, fills it, keeps it current from events, and rebuilds it when the declaration changes. This package is the piece that makes Meilisearch the engine underneath — plus ready-made product and category indexes, and store endpoints that combine search hits with live prices, tax and inventory.

```ts
// src/search/product.ts
import { defineProductSearchIndex } from '@luluhoc/medusa-search-meilisearch/indexes'

export default defineProductSearchIndex()
```

```ts
const { hits, facets } = await search.search({
  entity: 'product',
  filters: { q: 'cotton shirt', 'tags.value': { $in: ['summer'] } },
  search_options: { facets: ['categories.name'], disjunctive_facets: true },
})
```

That is the whole setup: declare it, run migrations, and the catalogue indexes itself.

## Features

- **Full-text search** — typo tolerance, synonyms, stop words, per-field weighting, highlighting and snippets
- **Filtering and sorting** on any declared field, including nested paths like `variants.sku`
- **Faceting** — value, range and stats facets, plus disjunctive faceting for filter sidebars that keep their siblings visible
- **Semantic and hybrid search** through Meilisearch embedders — Ollama, OpenAI, Hugging Face, any REST endpoint, or your own vectors
- **Zero-downtime rebuilds** — a changed schema is built beside the live index and swapped in once it is full
- **One request per search** — facet counts and exact counts are batched into a single multi-search call
- **Dates that actually work** — indexed as timestamps behind the scenes, because Meilisearch orders numbers and not strings
- **Store endpoints** keeping native `/store/products` behaviour: pricing, tax, inventory and sales channels
- **Honest failures** — anything Meilisearch cannot answer faithfully throws with the field or option to change, rather than returning something subtly different

## Compatibility

| Package                               | Version  | Medusa    | Meilisearch |
| ------------------------------------- | -------- | --------- | ----------- |
| `@luluhoc/medusa-search-meilisearch`  | `^1.0.0` | `^2.19.0` | `>= 1.12`   |
| `@rokmohar/medusa-plugin-meilisearch` | `^1.4.1` | `^2.15.2` | `>= 1.5`    |

Medusa `2.19.0` removed the search interface the older plugin was built on and replaced it with the Search Module. This package targets that module, so it needs `2.19.0` or newer — see [migration](docs/migration.md).

## Quick start

```bash
yarn add @luluhoc/medusa-search-meilisearch
```

```ts
// medusa-config.ts
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
            config: {
              host: process.env.MEILISEARCH_HOST,
              apiKey: process.env.MEILISEARCH_API_KEY,
            },
          },
        },
      ],
    },
  },
]
```

```ts
// src/search/product.ts
import { defineProductSearchIndex } from '@luluhoc/medusa-search-meilisearch/indexes'

export default defineProductSearchIndex()
```

```bash
npx medusa db:migrate   # creates the indexes
npx medusa develop      # fills them on boot
```

```bash
curl 'http://localhost:9000/store/meilisearch/products-hits?query=shirt' \
  -H 'x-publishable-api-key: pk_...'
```

The full walkthrough, including Docker and environment variables, is in [getting started](docs/getting-started.md).

## Documentation

| Guide                                          | What it covers                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| [Getting started](docs/getting-started.md)     | Install, configure, declare, migrate, search                        |
| [Configuration](docs/configuration.md)         | Every provider, module and index option                             |
| [Index definitions](docs/index-definitions.md) | The field DSL, seeding, events, custom entities                     |
| [Querying](docs/querying.md)                   | Filters, sorting, facets, counts, highlighting, and what is refused |
| [Store API](docs/store-api.md)                 | The four HTTP endpoints and when to use which                       |
| [Semantic search](docs/semantic-search.md)     | Embedders, hybrid search, costs and caveats                         |
| [Recipes](docs/recipes.md)                     | Prices, multilingual indexes, admin indexes, type-ahead             |
| [Troubleshooting](docs/troubleshooting.md)     | Why something is not indexed, and what each error means             |
| [Migration](docs/migration.md)                 | Moving from `@rokmohar/medusa-plugin-meilisearch`                   |

## How it fits together

```text
   your app                    Medusa Search Module              Meilisearch
┌──────────────┐            ┌────────────────────────┐        ┌──────────────┐
│ src/search/  │ declares → │ creates & migrates     │ ─────► │ index        │
│  product.ts  │            │ seeds & rebuilds       │        │ settings     │
└──────────────┘            │ routes events          │        │ documents    │
                            │ compiles queries       │ ◄───── │ hits, facets │
   events ─────────────────►└────────────────────────┘        └──────────────┘
                                       ▲
                                       │ this package
                                       │ translates both directions
```

You write the definition. The module owns the lifecycle. This package translates the module's contract — field declarations, filter trees, facet requests — into Meilisearch settings, filter expressions and search parameters, and translates the results back.

## Searching from a storefront

Three options, in rough order of how much you want to build:

1. **`/store/meilisearch/products-hits`** — one request, no database read, no prices. Right for type-ahead.
2. **`/store/meilisearch/products`** — native `/store/products` behaviour with search driving the results. Right for a product listing that needs prices.
3. **Directly against Meilisearch** with `instant-meilisearch` and InstantSearch. Fastest and the richest UI ecosystem, but the key reaches the browser — use a tenant token or a search-only key.

See [store API](docs/store-api.md). Instructions for the Medusa Next.js starter are in [nextjs](nextjs).

## Development

```bash
yarn install
yarn typecheck && yarn lint && yarn test
yarn build
```

Integration tests need a Meilisearch instance and are skipped without one:

```bash
docker run --rm -p 7700:7700 -e MEILI_MASTER_KEY=ms getmeili/meilisearch:latest
MEILISEARCH_TEST_HOST=http://127.0.0.1:7700 MEILISEARCH_TEST_API_KEY=ms yarn test:integration
```

## Credits

Built on [rokmohar/medusa-plugin-meilisearch](https://github.com/rokmohar/medusa-plugin-meilisearch) by Rok Mohar and its contributors, which is where the store endpoints, their native `/store/products` parity and the Next.js starter patch come from. The Search Module provider, the index definitions and the 2.19 rewrite are by Lucjan Grzesik. MIT, as the original is.

## Contributing

Issues and pull requests welcome.
