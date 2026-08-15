# Semantic and hybrid search

Meilisearch can match on meaning as well as on words, by embedding documents and queries into vectors. This provider exposes that through the Search Module's `search_options.vector`.

There are two ways to get vectors into an index, and they differ in who does the embedding:

- **Meilisearch embeds for you.** You point an embedder at Ollama, OpenAI, Hugging Face or any REST endpoint, and give it a template describing which fields to embed. Documents need no changes at all.
- **You supply the vectors.** Your seed writes them into the document, and Meilisearch only stores and compares them. Use this when the embeddings come from somewhere else entirely.

The first is what most stores want.

> Vector search requires Meilisearch `>= 1.5`. On versions where it is still experimental, enable it once per instance:
>
> ```bash
> curl -X PATCH 'http://localhost:7700/experimental-features/' \
>   -H 'Authorization: Bearer <MASTER_KEY>' \
>   -H 'Content-Type: application/json' \
>   --data-binary '{ "vectorStore": true }'
> ```

## Letting Meilisearch embed

Declare the embedder on the provider. It is applied to every index this provider manages, which is usually what you want — one embedder, several indexes.

### Ollama (local)

```ts
{
  resolve: '@luluhoc/medusa-search-meilisearch/providers/meilisearch',
  id: 'meilisearch',
  options: {
    config: {
      host: process.env.MEILISEARCH_HOST ?? 'http://127.0.0.1:7700',
      apiKey: process.env.MEILISEARCH_API_KEY ?? 'ms',
    },
    embedders: {
      default: {
        source: 'ollama',
        url: `${process.env.OLLAMA_URL ?? 'http://localhost:11434'}/api/embed`,
        model: 'nomic-embed-text',
        dimensions: 768,
        documentTemplate: '{{doc.title}} {{doc.description}}',
      },
    },
  },
}
```

### OpenAI

```ts
embedders: {
  default: {
    source: 'openAi',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'text-embedding-3-small',
    dimensions: 1536,
    documentTemplate: '{{doc.title}} {{doc.description}}',
    documentTemplateMaxBytes: 500,
  },
}
```

The name (`default` here) is what a query asks for later. Register more than one if different indexes should embed different things.

### The document template

`documentTemplate` decides what gets embedded — it is a [Liquid](https://shopify.github.io/liquid/) template over the document. Keep it to the fields that carry meaning:

```
{{doc.title}} {{doc.description}} {{doc.categories}}
```

Every document is re-embedded when the template changes, so changing it on a large index is not free.

> Embedding happens inside Meilisearch as documents are indexed. A seed of a large catalogue against a rate-limited API can take a while, and Meilisearch retries what fails.

## Supplying your own vectors

Declare a `vector` field. It registers a `userProvided` embedder under the field's own name, and your seed writes the embedding into `_vectors`:

```ts
// src/search/product.ts
import { search } from '@medusajs/framework/utils'
import { defineProductSearchIndex, productSearchFields } from '@luluhoc/medusa-search-meilisearch/indexes'

export default defineProductSearchIndex({
  fields: search.define({
    ...productSearchFields,
    embedding: search.vector(768).retrievable(false),
  }),
  transform: (product) => ({
    ...product,
    _vectors: { embedding: yourEmbeddingFor(product) },
  }),
})
```

To configure that embedder further, put it under the field's provider options:

```ts
embedding: search.vector(768).providerOptions({
  meilisearch: { embedder: { source: 'userProvided', dimensions: 768, binaryQuantized: true } },
}),
```

## Searching

```ts
const search = container.resolve(Modules.SEARCH)

const result = await search.search({
  entity: 'product',
  fields: ['id', 'title'],
  filters: { q: 'something warm for winter' },
  search_options: {
    vector: {
      field: 'default', // the embedder's name
      semantic_ratio: 0.7, // 0 = keyword only, 1 = semantic only
    },
  },
})
```

| `semantic_ratio` | Behaviour                                                  |
| ---------------- | ---------------------------------------------------------- |
| `0`              | Keyword only — the same as not asking for a vector at all. |
| `0.5`            | Hybrid, weighted evenly. Meilisearch's default.            |
| `1`              | Semantic only. Exact terms and SKUs stop matching.         |

Hybrid is almost always the right answer for a product catalogue: a customer searching `RED-M-2024` wants that SKU, and a customer searching `something for a cold morning` wants meaning. Between `0.5` and `0.8` covers both.

To search by a vector you already have rather than by text, pass it directly:

```ts
search_options: { vector: { field: 'default', value: [0.12, -0.4, ...] } }
```

Filters, facets, sorting and pagination all work the same on a semantic search.

## Through the store routes

```
GET /store/meilisearch/products?query=something+warm&semanticSearch=true&semanticRatio=0.7
GET /store/meilisearch/products-hits?query=something+warm&semanticSearch=true&embedder=default
```

| Parameter        | Description                               |
| ---------------- | ----------------------------------------- |
| `semanticSearch` | `true` to search through an embedder.     |
| `semanticRatio`  | `0`–`1`. Default `0.5`.                   |
| `embedder`       | Which embedder to use. Default `default`. |

## Costs and caveats

- **Indexing cost.** Every document is embedded once, and again whenever the template or the model changes. With a paid API that is a real bill on a large catalogue.
- **Query cost.** A text query has to be embedded before it can be compared, which adds a round trip to your embedding provider on every search. Meilisearch caches nothing here.
- **Dimensions must match the model.** `nomic-embed-text` is 768, `text-embedding-3-small` is 1536. A mismatch is rejected by Meilisearch at index time.
- **Changing an embedder rebuilds.** Meilisearch re-embeds the index when the embedder configuration changes.
- **Semantic search is not a filter.** It reorders and widens what matches; it does not respect intent on its own. Keep hard constraints (region, availability, status) in `filters`.
