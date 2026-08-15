# Store API

The plugin ships four store endpoints. They are optional — `query.search` covers most needs from your own routes — but they exist because a search hit does not carry prices, tax or inventory, and joining that back up is fiddly to get right.

They are registered by adding the plugin to `plugins` in `medusa-config.ts`. The Search Module alone does not add them.

Two shapes, and the choice between them is a real trade-off:

| Route             | Reads the database | Carries prices / tax / inventory | Round trips |
| ----------------- | ------------------ | -------------------------------- | ----------- |
| `…/products`      | yes                | yes                              | 2           |
| `…/products-hits` | no                 | no                               | 1           |

Use the hits routes for type-ahead and suggestions, and the full routes for a product listing.

## `GET /store/meilisearch/products`

Native `/store/products`, with search deciding which products come back.

The full native middleware stack runs — authentication, sales-channel filtering, published-only defaults, pricing and tax contexts — so the response is byte-for-byte what `/store/products` would return, including `calculated_price` and `variants.inventory_quantity`.

```bash
curl 'http://localhost:9000/store/meilisearch/products?query=shirt&region_id=reg_1&fields=*variants.calculated_price' \
  -H 'x-publishable-api-key: pk_...'
```

| Parameter        | Description                                                                  |
| ---------------- | ---------------------------------------------------------------------------- |
| `query`          | Free text. **Without it the route behaves exactly like `/store/products`.**  |
| `index`          | The index to query. Default: the index holding `locale`, else `product`.     |
| `language`       | The analyzer to tokenize the query with, e.g. `fra`. Not a content selector. |
| `locale`         | Native Medusa. Which language is searched _and_ returned, e.g. `fr-FR`.      |
| `semanticSearch` | `true` to search through an embedder.                                        |
| `semanticRatio`  | `0` keyword … `1` semantic. Default `0.5`.                                   |
| `embedder`       | Which embedder to use. Default `default`.                                    |

Every native parameter works alongside these — `fields`, `region_id`, `currency_code`, `category_id`, `collection_id`, `order`, `limit`, `offset`.

**`locale` picks the index.** A store declaring `locales` gets one index per language, and `?locale=fr-FR` (or the `x-medusa-locale` header) searches the French one and reads the products back in French. A language nobody indexed falls back to the default index rather than to no results, and naming an `index` outright overrides the routing. See [multiple languages](i18n.md).

```json
{
  "products": [
    {
      "id": "prod_123",
      "title": "Cotton T-Shirt",
      "variants": [
        {
          "id": "variant_456",
          "calculated_price": { "calculated_amount": 2999, "currency_code": "USD" }
        }
      ]
    }
  ],
  "count": 42,
  "offset": 0,
  "limit": 20
}
```

**Ranking is preserved.** The engine returns ids in relevance order; the products are read from the database and then re-sorted back into that order.

**Paging is the engine's.** When a `query` is present the page is applied by the search, and `count` is the number of matches the engine reports — not the number of rows the database returned.

## `GET /store/meilisearch/categories`

The same, for `/store/product-categories`. The response keeps the `categories` envelope key rather than native's `product_categories`.

| Parameter | Default    |
| --------- | ---------- |
| `index`   | `category` |

Other parameters are as above.

## `GET /store/meilisearch/products-hits` and `GET /store/meilisearch/categories-hits`

The engine's own hits, with no database read at all.

```bash
curl 'http://localhost:9000/store/meilisearch/products-hits?query=shirt&facets=status&facets=tags.value&sort=created_at:desc&limit=5' \
  -H 'x-publishable-api-key: pk_...'
```

| Parameter                                                 | Description                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `query`                                                   | Free text.                                                                            |
| `index`                                                   | Default `product` / `category`.                                                       |
| `limit` / `offset`                                        | Default `10` / `0`.                                                                   |
| `fields`                                                  | Repeatable. Dotted paths to return. Defaults to everything the index can return.      |
| `facets`                                                  | Repeatable. Facets to compute.                                                        |
| `sort`                                                    | Repeatable, as `path:asc` / `path:desc`.                                              |
| `filter`                                                  | A raw Meilisearch filter expression, passed through untouched. See the warning below. |
| `language`, `semanticSearch`, `semanticRatio`, `embedder` | As above.                                                                             |

The response is the Search Module's result shape:

```json
{
  "hits": [{ "id": "prod_123", "document": { "title": "Cotton T-Shirt", "handle": "cotton-t-shirt" } }],
  "facets": {
    "status": { "type": "value", "values": [{ "value": "published", "count": 42 }], "other_count": 0 }
  },
  "metadata": { "skip": 0, "take": 10, "count": 42, "query": "shirt", "processing_time_ms": 3 }
}
```

### About the `filter` parameter

`filter` lets a caller write arbitrary Meilisearch filter expressions against a **public, unauthenticated** endpoint. It can only narrow results, and hits carry only the index' displayed attributes, so it cannot reach fields you marked `retrievable(false)` or entities outside the index' own `filters`.

Still, if you would rather not expose it, strip it in a middleware:

```ts
// src/api/middlewares.ts
export default defineMiddlewares({
  routes: [
    {
      matcher: '/store/meilisearch/*-hits',
      middlewares: [
        (req, _res, next) => {
          delete req.query.filter
          next()
        },
      ],
    },
  ],
})
```

## Searching from the browser

Two options, and they differ in where the API key lives.

**Through these endpoints.** The Meilisearch key stays on your server. One extra hop, and you get Medusa's auth and sales-channel scoping for free. This is the default choice.

**Directly against Meilisearch**, e.g. with `instant-meilisearch`. Faster and gives you the whole InstantSearch ecosystem, but the key reaches the browser — so it must be a [tenant token or a search-only key](https://www.meilisearch.com/docs/learn/security/basic_security), never the master key. You will also need the _physical_ index name, which is the declared name plus the module's `index_prefix` if you set one.

## Writing your own endpoint

These four are ordinary routes with no privileged access. When they do not fit, resolve the module yourself:

```ts
// src/api/store/search/route.ts
import { MedusaRequest, MedusaResponse } from '@medusajs/framework'
import { Modules } from '@medusajs/framework/utils'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const search = req.scope.resolve(Modules.SEARCH)

  const result = await search.search({
    entity: 'product',
    fields: ['id', 'title', 'thumbnail', 'handle'],
    filters: { q: String(req.query.q ?? '') },
    pagination: { take: 8 },
  })

  res.json({ suggestions: result.hits.map((hit) => hit.document) })
}
```
