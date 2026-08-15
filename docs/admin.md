# Admin

The plugin ships four admin widgets and the endpoints behind them. Like the store routes, they are registered by adding the plugin to `plugins` in `medusa-config.ts` — the Search Module alone does not add them.

```ts
// medusa-config.ts
module.exports = defineConfig({
  plugins: [{ resolve: '@luluhoc/medusa-search-meilisearch', options: {} }],
})
```

| Widget                                         | Where                       | What it answers                                                    |
| ---------------------------------------------- | --------------------------- | ------------------------------------------------------------------ |
| [Search index](#search-index)                  | Product details             | Is this product indexed, in every language, and what does it hold? |
| [Search rank](#search-rank)                    | Product details, side panel | Where does it place for a query a customer would type?             |
| [Search preview](#search-preview)              | Product list, top           | What does the engine return for a query, in its own order?         |
| [Search indexes](#search-indexes-index-health) | Product list, bottom        | Do the indexes hold as much as the catalogue does?                 |

## Search index

A panel on the product details page showing what Meilisearch holds for that product rather than what the database does. That distinction is the whole point: the rest of the page is the catalogue, and this is what a storefront search would actually find.

**One row per index that holds products**, because a catalogue indexed per language ([i18n](i18n.md)) stores the same product once per index — so "is it indexed?" only has an answer per language, and a product missing from French alone is exactly what a single-index view would hide.

| Badge         | What it means                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `Indexed`     | The index holds a document under this product's id                                                        |
| `Not indexed` | It holds nothing — correct for a draft product, since the shipped indexes filter on `status: 'published'` |
| `Behind`      | The stored document predates the product's last change                                                    |
| An error      | The index could not be read at all, usually one migrations have not created yet                           |

`Behind` compares the document's `updated_at` against the product's. It is a signal, not a verdict — editing a variant changes what belongs in the document without moving the product's own `updated_at`, so a document can be behind without being flagged. A flagged document is always genuinely behind.

Selecting a row shows that index' **stored document verbatim**, including fields a custom definition adds and excluding what it never sent. The date shadows the provider maintains are stripped, as they are from every search response.

**Reindex** brings the product's documents back in line and waits for Meilisearch to apply the write, so the panel refreshes to what a search would return at that moment. It routes a `product.updated` event through the Search Module rather than writing the document directly, which means the index' own `consume` decides the outcome — a product that stopped matching the index' filters is _deleted_ from the index rather than left behind as a stale hit. Every index declaring that event is reconciled, so one press covers all the languages the panel lists.

An index whose definition replaces `events` may not declare `product.updated` at all. There is then nothing to route, and the index is rebuilt from its own `seed` over that one id instead. That path only ever writes, so it cannot remove a document that no longer belongs — declare `product.updated` if you want the button to be able to.

## Search rank

A side-panel widget that runs a query against the engine and reports **where this product placed**. The indexed document says what the engine stores; this says what the engine does with it, which is the other half of "why doesn't this come up when I search for it?" — a document can be perfectly indexed and still sit behind two hundred better matches.

It opens on the product's own title, because a product that does not place for its own name is the case worth seeing without being asked for. The top hits are listed underneath, so when the product is beaten you can see what beat it.

| Verdict                                       | What to do about it                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Rank #n`                                     | Nothing — it matches and places. Adjust `searchable({ weight })` if `n` is too high                 |
| `Unranked`, "does not match the query at all" | The words are not in a searchable field, or the document is not there. Check the Search index panel |
| `Unranked`, "not in the first N hits"         | It matches but is outranked; the scan stopped before reaching it                                    |

The two `Unranked` cases are deliberately not merged: one is an indexing fault and the other a relevance one, and they have nothing to do with each other.

## Search preview

A search box above the product list that queries the engine directly and shows the hits **in the order Meilisearch ranked them**, with each hit's relevance score and the query's processing time.

The list underneath it is the database, ordered by whatever the dashboard's filters say. This is the engine. Having both on one page is the point: it is the only place the two orders can be compared without leaving the dashboard.

No prices, no sales channels, no publishable key — unlike [the store routes](store-api.md), which layer all of that on top. Mixing them in would hide whether a ranking problem is the engine's at all.

## Search indexes (index health)

A table under the product list: every declared index, the language it holds, how many documents it holds, and the catalogue count it is supposed to have reached.

An index that silently stopped being filled looks exactly like a healthy one from a storefront. Putting a count next to it is what makes the difference visible — an index at 1,204 documents against 1,318 published products has lost something.

The comparison is a signal rather than a verdict. An index definition chooses its own `filters`, so a count that differs from the catalogue's is only wrong if the definition says it should have matched; it is the size of the gap that is worth reading, not its existence. An index declared without this package's factories reports no entity at all and is compared against nothing.

`Unavailable` is an index Meilisearch could not answer for — almost always one that is declared but has not been migrated yet, which is the one thing this panel exists to catch.

## `GET /admin/meilisearch/indexes`

Every index the Search Module has loaded, with an exact document count, the language it holds and the entity it was declared over.

```bash
curl http://localhost:9000/admin/meilisearch/indexes -H "Authorization: Bearer $TOKEN"
```

```json
{
  "indexes": [
    { "name": "product", "locale": "en-US", "entity": "product", "document_count": 128, "error": null },
    {
      "name": "product-fr-FR",
      "locale": "fr-FR",
      "entity": "product",
      "document_count": null,
      "error": "Index `product-fr-FR` not found."
    }
  ]
}
```

`locale` is `null` for an index holding the default language. `entity` is `null` for an index declared without this package's factories, which register nothing to say what they hold — and which therefore cannot be compared against a catalogue count.

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

## `GET /admin/meilisearch/products/:id/indexes`

The same product across **every** index that holds products, which is what the Search index widget lists.

```bash
curl http://localhost:9000/admin/meilisearch/products/prod_123/indexes \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "id": "prod_123",
  "entries": [
    {
      "index": "product",
      "locale": null,
      "indexed": true,
      "updated_at": "2026-08-01T10:04:00.000Z",
      "error": null
    },
    { "index": "product-fr-FR", "locale": "fr-FR", "indexed": false, "updated_at": null, "error": null }
  ]
}
```

Only what a coverage view needs comes back — whether the document is there and how old it is — rather than the documents, which are the same product repeated once per language. Read one with the single-index route above.

`updated_at` is the document's own, since the engine records nothing per document; a definition that does not index the field dates nothing and reports `null` rather than a guess. Each index reports its own `error`, for the same reason the listing does: a language whose index was never migrated must not hide the languages that were.

Which indexes hold products is settled by registration — the factories record it — and by the naming convention (`product`, `product-fr-FR`) for indexes declared by hand, which register nothing. A registration wins over the convention, so an index named `product-reviews` that declares another entity is not mistaken for a product index.

## `GET /admin/meilisearch/search`

A search against one index, answered with what the engine returned and nothing else — no prices, no sales channels, no database read. A merchant asking why a product does not come up needs the engine's own answer, not one the storefront's filters have already reshaped.

| Parameter        | Default   | Description                                                                 |
| ---------------- | --------- | --------------------------------------------------------------------------- |
| `query`          | —         | The text to search for                                                      |
| `index`          | `product` | Which index to search                                                       |
| `limit`          | `10`      | Hits per page, up to 50                                                     |
| `offset`         | `0`       | Where the page starts                                                       |
| `facets`         | —         | Facets to compute, e.g. `facets=status&facets=tags.value`                   |
| `find`           | —         | An id to report the ranking position of                                     |
| `scan`           | `200`     | How deep to look for `find` before calling it unplaced, up to 1000          |
| `semanticSearch` | `false`   | Rank by vector similarity as well as by text                                |
| `semanticRatio`  | `0.5`     | How much of the ranking is semantic ([semantic search](semantic-search.md)) |
| `embedder`       | `default` | Which declared embedder to query                                            |

```bash
curl 'http://localhost:9000/admin/meilisearch/search?query=shirt&find=prod_123' \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "index": "product",
  "query": "shirt",
  "hits": [{ "id": "prod_456", "score": 0.92, "document": { "id": "prod_456", "title": "Linen shirt" } }],
  "count": 34,
  "processing_time_ms": 3,
  "rank": { "id": "prod_123", "position": 12, "scanned": 34, "exhausted": true }
}
```

`rank` is present only when `find` was given. `position` is 1-based, or `null` when the id did not place among the `scanned` hits — and `exhausted` is what tells the two failures apart: with `exhausted: true` the scan reached the end of the result set, so the entity does not match at all; with `false` it only means it did not place in the first `scanned` hits.

The ranking scan is a second query batched with the page rather than sent after it. The provider folds a `searchMany` into a single Meilisearch `multiSearch`, so asking where a product placed costs no extra round trip.

`count` is exact, for the same reason the index listing's is.

All of these routes sit under `/admin`, so they inherit the dashboard's own authentication. There is no publishable key involved and no unauthenticated access.

## Extending it

The widgets are plain Medusa admin widgets under [src/admin/widgets/](../src/admin/widgets/), built by `medusa plugin:build` and exported as `./admin`. If you want a different panel — a category equivalent, a settings inspector — the endpoints above are the same ones your own widget would call, [src/admin/lib/api.ts](../src/admin/lib/api.ts) holds the typed queries behind them, and `src/admin/lib/sdk.ts` is the configured client to call them with.
