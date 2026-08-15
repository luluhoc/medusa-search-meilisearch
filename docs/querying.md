# Querying

```ts
import { Modules } from '@medusajs/framework/utils'

const search = container.resolve(Modules.SEARCH)

const { hits, facets, metadata } = await search.search({
  entity: 'product',
  fields: ['id', 'title', 'thumbnail'],
  filters: {
    q: 'cotton shirt',
    status: 'published',
    'tags.value': { $in: ['summer', 'cotton'] },
    created_at: { $gte: '2024-01-01T00:00:00Z' },
  },
  pagination: { skip: 0, take: 20, order: { created_at: 'DESC' } },
  search_options: {
    facets: ['status', { field: 'categories.name', type: 'value', limit: 10 }],
    highlight: { fields: ['title'], pre_tag: '<em>', post_tag: '</em>' },
    include_score: true,
  },
})
```

| Key              | Meaning                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `entity`         | The index' **name**, as declared. Not the Medusa entity.          |
| `fields`         | Dotted paths to return. Omit for everything the index can return. |
| `filters`        | Field predicates, plus `q` for the free-text query.               |
| `pagination`     | `skip`, `take`, `order`.                                          |
| `search_options` | Facets, highlighting, scoring, vectors, counting.                 |

The free-text query lives in `filters.q` rather than beside it, so a `query.graph` call converts to a `query.search` call unchanged. It is not a field — the module lifts it out before the rest is compiled.

## The result

```ts
{
  hits: [
    {
      id: 'prod_1',
      score: 0.87,                      // only with include_score
      document: { title: 'Red shirt' }, // only the fields asked for
      highlights: { title: ['Red <em>shirt</em>'] },
    },
  ],
  facets: { status: { type: 'value', values: [{ value: 'published', count: 42 }], other_count: 0 } },
  metadata: { skip: 0, take: 20, count: 42, query: 'cotton shirt', processing_time_ms: 3 },
}
```

## Filters

Filters are a tree, not a string — every engine has its own filter syntax, and a tree compiles to all of them.

```ts
filters: {
  status: 'published',                          // equality
  id: ['prod_1', 'prod_2'],                     // membership
  price: { $gte: 1000, $lt: 5000 },             // a range
  'variants.sku': 'RED-M',                      // a nested path
  discountable: { $ne: false },
  thumbnail: { $exists: true },
  $or: [{ status: 'published' }, { id: 'prod_9' }],
  $not: { is_giftcard: true },
}
```

| Operator                            | Supported | Notes                                                                             |
| ----------------------------------- | --------- | --------------------------------------------------------------------------------- |
| `$eq` `$ne`                         | ✅        | `null` compiles to `IS NULL` / `IS NOT NULL`.                                     |
| `$in` `$nin`                        | ✅        |                                                                                   |
| `$lt` `$lte` `$gt` `$gte`           | ✅        | Numbers and dates. A non-numeric operand is refused.                              |
| `$exists`                           | ✅        |                                                                                   |
| `$contains` `$overlaps` on an array | ✅        | Array membership — which is what containment means in Meilisearch.                |
| `$contains` `$prefix` on text       | ⚠️        | `CONTAINS` / `STARTS WITH`, which need the `containsFilter` experimental feature. |
| `$like`                             | ❌        | Meilisearch has no pattern filter. Use `q`, `$prefix` or `$contains`.             |
| `$and` `$or` `$not`                 | ✅        | Nest freely.                                                                      |

A field has to be declared `filterable` to appear in a filter, and an undeclared field is refused by name rather than quietly matching nothing.

### Enabling substring filters

`$contains` and `$prefix` on text need an experimental feature turned on, once per instance:

```bash
curl -X PATCH 'http://localhost:7700/experimental-features/' \
  -H 'Authorization: Bearer <MASTER_KEY>' \
  -H 'Content-Type: application/json' \
  --data-binary '{ "containsFilter": true }'
```

Without it, Meilisearch rejects the query with a clear error rather than returning something different.

## Sorting

```ts
pagination: { order: { price: 'ASC', created_at: 'DESC' } }
```

Any number of keys, applied in order. `_score` means relevance, which is Meilisearch's default ordering — naming it explicitly is the same as not sorting at all.

A field has to be declared `sortable`. Sorting by a date works through the epoch-ms shadow automatically.

## Pagination and counts

```ts
pagination: { skip: 40, take: 20 }
```

Offset-based. Cursors are refused — Meilisearch paginates by offset and returning a different page than asked for would be worse than saying so.

```ts
search_options: {
  count: 'estimated'
} // default
search_options: {
  count: 'exact'
}
search_options: {
  count: 'none'
}
```

| Strategy    | What `metadata.count` holds                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| `estimated` | Meilisearch's estimate. Cheap, and what a "showing 1–20 of about 400" needs.                               |
| `exact`     | An exhaustive count, from an extra query. Capped by the index' `pagination.max_total_hits` (default 1000). |
| `none`      | `null`. Cheapest — use it when you only render "next".                                                     |

## Facets

```ts
search_options: {
  facets: [
    'status',                                                          // shorthand for a value facet
    { field: 'categories.name', type: 'value', limit: 10, sort: 'count' },
    { field: 'price', type: 'range', ranges: [{ to: 2000 }, { from: 2000, to: 5000 }, { key: 'premium', from: 5000 }] },
  ],
}
```

| Type    | Result                                                                                        |
| ------- | --------------------------------------------------------------------------------------------- |
| `value` | `{ values: [{ value, count }], other_count }` — ordered by count (or `alpha`), then by value. |
| `range` | `{ ranges: [{ key, from, to, count }] }` — half-open buckets, `from <= x < to`.               |
| `stats` | `{ min, max, count }`.                                                                        |

Meilisearch has value facets natively; range and stats are synthesised by this provider with one extra query each, all batched into the same request as the hits. So a three-bucket range facet costs one round trip, not four.

A field must be declared `facetable` for the kind you ask for. Numeric and date fields default to `range`; everything else defaults to `value`. `stats` is always opt-in.

**One facet per field.** A result carries one facet per field, so asking for two on the same field is refused rather than answered with whichever was planned last. Ask in separate queries.

### Disjunctive facets

```ts
search_options: { facets: ['tags.value'], disjunctive_facets: true }
```

Computes each facet as though its own filter were not applied, so a storefront keeps showing sibling values of an active filter — pick "summer" and the other tags stay visible with their counts. The Search Module fans this out into one query per faceted field; this provider batches the fan-out into a single request.

## Free text

```ts
filters: {
  q: 'red cotton shirt'
}
```

| Option                    | Effect                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `attributes_to_search_on` | Restrict matching to named fields. Each must be declared `searchable`.                     |
| `match_strategy: 'all'`   | Every term must match.                                                                     |
| `match_strategy: 'last'`  | Drop terms from the end until something matches.                                           |
| `match_strategy: 'any'`   | **Refused** — Meilisearch has no equivalent, and `last` is not the same thing.             |
| `typo_tolerance`          | **Refused per query** — it is an index setting. Declare `settings.typo_tolerance` instead. |
| `locales`                 | Language hint for the analyzer. Defaults to the index' `settings.locales`.                 |
| `distinct`                | Collapse hits sharing a value, e.g. one row per `handle`.                                  |

## Highlighting

```ts
search_options: {
  highlight: {
    fields: ['title', 'description'],
    pre_tag: '<em>',
    post_tag: '</em>',
    snippet: { length: 40 },
  },
}
```

`snippet` crops the field around the match instead of returning it whole. Highlights come back per hit, keyed by field, as an array — an array field highlights every element that matched.

## Scoring

```ts
search_options: { include_score: true, min_score: 0.4 }
```

`include_score` puts Meilisearch's ranking score on each hit; `min_score` drops anything below a threshold, which is how you keep a "no good matches" state from rendering as a page of weak ones.

## Several queries at once

```ts
const [products, categories] = await search.searchMany([
  { entity: 'product', filters: { q: 'shirt' }, pagination: { take: 5 } },
  { entity: 'category', filters: { q: 'shirt' }, pagination: { take: 3 } },
])
```

Every query in the batch — including the extra ones facets and exact counts expand into — goes to Meilisearch's multi-search route as a single HTTP request. This is what a type-ahead across products and categories should use.

## Escape hatches

Meilisearch features this interface does not model are reachable at three levels:

```ts
// Per query — merged last, overrides anything derived
search_options: { provider_options: { meilisearch: { rankingScoreThreshold: 0.4, showMatchesPosition: true } } }

// Per index
settings: { provider_options: { meilisearch: { proximityPrecision: 'byAttribute' } } }

// Per field
search.vector(768).providerOptions({ meilisearch: { embedder: { source: 'userProvided', binaryQuantized: true } } })
```

The per-query hatch replaces what it names, including `filter` — pass a raw Meilisearch filter expression there and it is used instead of the compiled one.

## Capability summary

| Capability                                       | Status                                         |
| ------------------------------------------------ | ---------------------------------------------- |
| Full-text, typo tolerance, synonyms, stop words  | ✅                                             |
| Filters, nested paths, boolean composition       | ✅                                             |
| Multi-key sorting, dates                         | ✅                                             |
| Value / range / stats facets, disjunctive facets | ✅ (range and stats synthesised)               |
| Highlighting and snippets                        | ✅                                             |
| Hybrid and semantic search                       | ✅ — see [semantic search](semantic-search.md) |
| Scores, thresholds, distinct                     | ✅                                             |
| Exact counts                                     | ✅ capped by `pagination.max_total_hits`       |
| `$like`                                          | ❌ refused                                     |
| `match_strategy: 'any'`                          | ❌ refused                                     |
| Per-query typo toggle                            | ❌ refused — index-level setting               |
| Pagination cursors                               | ❌ refused — offset only                       |
| `correlated` object arrays                       | ❌ refused at migration time                   |

Anything refused throws a `MedusaError` naming the field or option to change. Nothing is silently ignored: returning a slightly different result is the one outcome a search provider cannot let you discover in production.
