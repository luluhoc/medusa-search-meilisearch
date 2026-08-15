# Admin

The plugin ships one admin widget and the two admin endpoints behind it. Like the store routes, they are registered by adding the plugin to `plugins` in `medusa-config.ts` — the Search Module alone does not add them.

```ts
// medusa-config.ts
module.exports = defineConfig({
  plugins: [{ resolve: '@luluhoc/medusa-search-meilisearch', options: {} }],
})
```

## The product widget

A **Search index** panel on the product details page, showing what Meilisearch holds for that product rather than what the database does. That distinction is the whole point: the rest of the page is the catalogue, and this is what a storefront search would actually find.

It answers the three questions a merchant asks when a product does not show up in search:

| Row              | What it tells you                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Status           | `Indexed` or `Not indexed`, plus `Behind` when the stored document predates the product's last change      |
| Index            | Which index was read, the language it holds if it has one, and how many documents it holds in total        |
| Indexed document | The stored document verbatim — including fields a custom definition adds, and excluding what it never sent |

When the product is not indexed and is not published, the widget says so: the index definitions this package ships filter on `status: 'published'`, so a draft product is _supposed_ to be absent.

`Behind` compares the document's `updated_at` against the product's. It is a signal, not a verdict — editing a variant changes what belongs in the document without moving the product's own `updated_at`, so a document can be behind without being flagged. A flagged document is always genuinely behind.

**The index picker** appears when more than one index is declared, which is how a set of per-language indexes ([i18n](i18n.md)) is inspected one at a time. Each entry carries the language its index holds, so `product-fr-FR` reads as French rather than as a name to decode. With a single index there is nothing to choose and it stays hidden.

**Reindex** brings the product's documents back in line and waits for Meilisearch to apply the write, so the panel refreshes to what a search would return at that moment. It routes a `product.updated` event through the Search Module rather than writing the document directly, which means the index' own `consume` decides the outcome — a product that stopped matching the index' filters is _deleted_ from the index rather than left behind as a stale hit. Every index declaring that event is reconciled, so one press covers all of them.

An index whose definition replaces `events` may not declare `product.updated` at all. There is then nothing to route, and the index is rebuilt from its own `seed` over that one id instead. That path only ever writes, so it cannot remove a document that no longer belongs — declare `product.updated` if you want the button to be able to.

## `GET /admin/meilisearch/indexes`

Every index the Search Module has loaded, with an exact document count and the language it holds.

```bash
curl http://localhost:9000/admin/meilisearch/indexes -H "Authorization: Bearer $TOKEN"
```

```json
{
  "indexes": [
    { "name": "product", "locale": "en-US", "document_count": 128, "error": null },
    { "name": "product-fr-FR", "locale": "fr-FR", "document_count": null, "error": "Index `product-fr-FR` not found." }
  ]
}
```

`locale` is `null` for an index holding the default language, and for one declared without this package's factories, which have nothing to record it from.

Counts are exact rather than estimated, because an admin comparing them against a product count is the one caller for whom "about 1000" is not an answer. Each index is counted separately, so a declared index that migrations have not created yet reports its own `error` instead of taking the listing down with it.

## `GET /admin/meilisearch/products/:id`

The document one index holds for a product.

| Parameter | Description                                                      |
| --------- | ---------------------------------------------------------------- |
| `index`   | Which index to read from. Default `product`, then the first one. |

```bash
curl 'http://localhost:9000/admin/meilisearch/products/prod_123?index=product_fr' \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "index": "product_fr",
  "id": "prod_123",
  "indexed": true,
  "document": { "id": "prod_123", "title": "T-shirt en coton", "status": "published" }
}
```

`document` is `null` when the index holds nothing under that id. The date shadows the provider maintains (`created_at__ts` and friends — see [index definitions](index-definitions.md)) are stripped, as they are from every search response.

The lookup filters on the primary key, which is the only per-id read the Search Module's interface has. A custom index definition therefore has to leave `id` filterable, as every definition this package ships does.

## `POST /admin/meilisearch/products/:id`

Reindexes the product and answers with the document as it now stands — same body as the `GET`, same `index` parameter. The response means the write has landed, not that it was accepted.

```bash
curl -X POST 'http://localhost:9000/admin/meilisearch/products/prod_123' \
  -H "Authorization: Bearer $TOKEN"
```

Both routes sit under `/admin`, so they inherit the dashboard's own authentication. There is no publishable key involved and no unauthenticated access.

## Extending it

The widget is a plain Medusa admin widget under [src/admin/widgets/](../src/admin/widgets/), built by `medusa plugin:build` and exported as `./admin`. If you want a different panel — a category equivalent, a search playground, an index listing page — the two endpoints above are the same ones your own widget would call, and `src/admin/lib/sdk.ts` is the configured client to call them with.
