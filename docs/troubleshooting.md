# Troubleshooting

## Nothing is indexed

Work down this list; it is ordered by how often each one is the answer.

**1. Is the Search Module registered?** It is not one of Medusa's defaults. Without a `@medusajs/medusa/search` entry in `modules`, nothing happens at all — no error, no index.

**2. Did migrations run?** `npx medusa db:migrate` creates the physical indexes. Seeding deliberately refuses to create anything: an index with no record is one a migration has not made yet, and a booting worker should not invent it.

```bash
npx medusa db:migrate
```

**3. Is this process in worker mode?** Seeding runs only where `workerMode` is `worker` or `shared`. A `server`-only deployment never seeds. If you run split processes, the worker is where indexing happens.

**4. Is the definition being loaded?** It has to be a file under `src/search/`, and it has to be imported for `defineSearchIndex` to register it. Files starting with `_` and a bare `index.ts` are skipped by the loader.

**5. Check the boot log.** A seed announces itself:

```
[Search] Seeding 2 index(es): product (index_created), category (index_created)
```

No line means nothing was considered stale. `listIndexes()` tells you what the module knows about:

```ts
container.resolve(Modules.SEARCH).listIndexes()
```

## A product is missing from results

**It does not match the index' `filters`.** The default product index holds `status: 'published'` only. A draft is not indexed, and unpublishing an indexed product removes it.

**Its event was not declared.** The module subscribes to exactly the events an index declares. If you replaced `events` rather than extending it, you may have dropped the one that fires.

**The write is still in flight.** Meilisearch applies writes asynchronously. Ingestion waits for them, so this is rare — but a very large batch can lag.

**Something it derives from changed, not the product itself.** A category rename does not emit a product event. See [keeping derived data current](recipes.md#keeping-derived-data-current).

To check what the engine actually holds:

```bash
curl 'http://localhost:7700/indexes/product/documents/prod_123' -H 'Authorization: Bearer <KEY>'
```

## Errors you might see

### `Field "x" is not filterable on search index "product"`

Raised by the Search Module before the query is sent. Declare it:

```ts
x: search.keyword().filterable()
```

Then `npx medusa db:migrate` — the field's declaration is part of the index' schema, so it needs a migration to take effect.

### `Unknown field "x" used in filters on search index "product"`

The field is not in the definition at all. Adding it to `graph_fields` alone is not enough; it has to be in `fields` too.

### `Attribute 'x' is not filterable` (from Meilisearch)

The definition and the physical index disagree — the field was declared after the index was built. Run migrations.

### `Cannot compare "title" with > against a non-numeric value`

`$gt`/`$lt` work on numbers and dates. Meilisearch does not order strings. For a date, pass a `Date` or an ISO-8601 string with a time — `2024-01-01` alone is treated as a plain string, deliberately, so that ids and SKUs shaped like dates are left alone.

### `Meilisearch has no pattern filter, so $like … cannot be answered`

Use `q` for matching, or `$prefix` / `$contains` with the `containsFilter` experimental feature enabled:

```bash
curl -X PATCH 'http://localhost:7700/experimental-features/' \
  -H 'Authorization: Bearer <MASTER_KEY>' \
  -H 'Content-Type: application/json' \
  --data-binary '{ "containsFilter": true }'
```

### `Field "price" is requested as more than one facet`

A result carries one facet per field. Ask for the range facet and the stats facet in separate queries.

### `… is declared correlated, which Meilisearch cannot express`

Meilisearch flattens arrays of objects. See [the caveat](index-definitions.md#nested-objects-and-what-meilisearch-cannot-do) for the workaround.

### `MeiliSearchTaskTimeOutError`

A write took longer than `taskTimeoutMs` (default 120s). Almost always an embedder: Meilisearch only applies the write once it has embedded the batch. Either raise the timeout, or lower `reindex.batch_size` so each batch is smaller.

### `Meilisearch search provider requires a "config.host" option`

The provider's options did not arrive. Check that `options.config.host` sits under the _provider_ entry, not the module's, and that the environment variable is actually set — an unset `process.env.MEILISEARCH_HOST` is `undefined`, not an error.

## Counts look wrong

`metadata.count` is an _estimate_ by default. For a real count:

```ts
search_options: {
  count: 'exact'
}
```

If an exact count plateaus at exactly 1000, that is Meilisearch's `maxTotalHits`, which caps counting as well as paging:

```ts
settings: {
  pagination: {
    max_total_hits: 100_000
  }
}
```

## Results are ranked oddly

**Attribute order is the ranking.** Meilisearch ranks by the order of `searchableAttributes`, and this provider derives that order from your declared weights. If `sku` outranks `title`, its weight is higher.

**Check what the index actually has:**

```bash
curl 'http://localhost:7700/indexes/product/settings' -H 'Authorization: Bearer <KEY>' | jq
```

**Semantic search widens matching.** A high `semantic_ratio` will surface loosely related products. Keep hard constraints in `filters`, and use `min_score` to cut the tail.

## A schema change did not take

Changing `fields` or `settings` changes the definition's hash, which is what makes the module rebuild. The sequence is two steps, on purpose:

1. `npx medusa db:migrate` — builds the new schema **beside** the live index
2. Restart the app — fills the new index and swaps it in

If you only did the first, the live index is still serving the old schema. That is deliberate: the swap happens when there is something to swap to.

To force it:

```ts
await container.resolve(Modules.SEARCH).reindex({ index: 'product' })
```

## Staging overwrote production

Both environments pointed at one Meilisearch instance with no prefix. Set one per environment:

```ts
{
  resolve: '@medusajs/medusa/search',
  options: { index_prefix: process.env.NODE_ENV },
}
```

`index_prefix` changes the physical index name, so expect a rebuild after adding it.

## Reindexing is slow

- Raise `reindex.batch_size` (default 100) — fewer, larger writes.
- Trim `graph_fields`. Every field is a join, and the database is usually the bottleneck, not Meilisearch.
- If an embedder is configured, that is almost certainly the cost. Consider a smaller model or a narrower `documentTemplate`.
- A full `reindex()` builds a shadow index and swaps at the end, so it is safe to run against a live store — it costs disk, not availability.

## Inspecting the engine directly

```bash
# What indexes exist, and how full
curl 'http://localhost:7700/stats' -H 'Authorization: Bearer <KEY>' | jq

# What the last writes did
curl 'http://localhost:7700/tasks?limit=5' -H 'Authorization: Bearer <KEY>' | jq

# What a query actually returns
curl -X POST 'http://localhost:7700/indexes/product/search' \
  -H 'Authorization: Bearer <KEY>' -H 'Content-Type: application/json' \
  --data '{ "q": "shirt", "limit": 3 }' | jq
```

A failed task carries the reason in `error.message`, which is usually more specific than what surfaced in your logs.
