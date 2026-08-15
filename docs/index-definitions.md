# Index definitions

An index definition says four things: what the documents look like, where they come from, what changes them, and what the engine should do with each field. The Search Module handles everything after that.

Definitions live in `src/search/` in your application. Medusa loads that directory at boot; `defineSearchIndex` registers each one as it is imported.

## The shape of a definition

```ts
import { defineSearchIndex, search } from '@medusajs/framework/utils'

export default defineSearchIndex({
  name: 'product', // what query.search addresses it by
  entity: 'product', // the Medusa entity it mirrors
  primary_key: 'id', // optional, defaults to 'id'
  provider: 'meilisearch', // optional with a single provider registered

  fields: search.define({
    /* ... */
  }),
  settings: {
    /* synonyms, locales, ... */
  },

  events: ['product.updated'],
  async consume(event, { container }) {
    /* → writes */
  },
  async *seed({ container, filters, last_key }) {
    /* → documents */
  },
})
```

This package's factories are ordinary callers of it — start from them, and drop to `defineSearchIndex` when you are indexing something Medusa's product catalogue does not cover.

## Using the factories

```ts
// src/search/product.ts
import { defineProductSearchIndex } from '@luluhoc/medusa-search-meilisearch/indexes'

export default defineProductSearchIndex()
```

| Option           | Default                      | Description                                                                    |
| ---------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| `name`           | `product` / `category`       | The index' name, and what queries address it by.                               |
| `provider`       | the only registered provider | Which provider holds this index.                                               |
| `fields`         | `productSearchFields`        | Field declarations, as a `search.define({ ... })` schema or plain definitions. |
| `graph_fields`   | `productGraphFields`         | The `query.graph` selection used to build documents.                           |
| `filters`        | `{ status: 'published' }`    | What belongs in the index. Applied to seeding _and_ ingestion.                 |
| `transform`      | identity                     | Turns an entity into a document.                                               |
| `events`         | `productSearchEvents`        | Events to reindex on.                                                          |
| `settings`       | —                            | Synonyms, stop words, typo tolerance, faceting, locales.                       |
| `locale`         | —                            | The locale to read entities in, so the index holds that language's text.       |
| `locales`        | —                            | Declares one index per language on top of this one. See [i18n](i18n.md).       |
| `default_locale` | —                            | The language this index already holds, so requests for it are served here.     |
| `batch_size`     | `200`                        | Rows read per round trip while seeding.                                        |

### What the defaults index

```ts
// productSearchFields
id, handle, title, subtitle, description, status, thumbnail,
is_giftcard, discountable, collection_id, type_id,
collection { id, title, handle },
type       { id, value },
categories [{ id, name, handle }],
tags       [{ id, value }],
variants   [{ id, title, sku, barcode }],
created_at, updated_at
```

```ts
// categorySearchFields
id, name, description, handle, rank, is_active, is_internal,
parent_category_id, parent_category { id, name, handle },
created_at, updated_at
```

Prices are deliberately absent — a price depends on region, currency and price list, and choosing one belongs to your store. See [recipes](recipes.md#indexing-prices).

## The field DSL

`search.define({ ... })` describes what the engine does with each field. Every modifier is a deliberate cost: a searchable field grows the text index, a filterable one grows the filter index.

```ts
import { search } from '@medusajs/framework/utils'

search.define({
  id: search.keyword().filterable(),
  title: search.text().searchable({ weight: 5 }).sortable(),
  status: search.keyword().filterable().facetable(),
  price: search
    .float()
    .filterable()
    .sortable()
    .facetable({ types: ['range', 'stats'] }),
  created_at: search.date().filterable().sortable(),
  in_stock: search.boolean().filterable(),
  internal: search.text().searchable().retrievable(false),
  variants: search
    .object({
      id: search.keyword().filterable(),
      sku: search.keyword().searchable({ weight: 3 }).filterable(),
    })
    .array(),
})
```

| Builder                        | Use for                                                  |
| ------------------------------ | -------------------------------------------------------- |
| `search.text()`                | Prose to match on — titles, descriptions.                |
| `search.keyword()`             | Exact tokens — ids, handles, SKUs, statuses.             |
| `search.integer()` / `float()` | Numbers you filter, sort or bucket by.                   |
| `search.boolean()`             | Flags.                                                   |
| `search.date()`                | Timestamps. See [dates](#dates), which are special here. |
| `search.object({ ... })`       | Nested structures. `.array()` for a list of them.        |
| `search.geo()`                 | Coordinates. Must be named `_geo`.                       |
| `search.vector(dimensions)`    | Embeddings. See [semantic search](semantic-search.md).   |

| Modifier                    | Effect on Meilisearch                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `.searchable()`             | Adds the field to `searchableAttributes`.                                                    |
| `.searchable({ weight })`   | Same, but ordered by weight — Meilisearch ranks by attribute _order_, so weights become one. |
| `.filterable()`             | Adds it to `filterableAttributes`.                                                           |
| `.sortable()`               | Adds it to `sortableAttributes`.                                                             |
| `.facetable()`              | Adds it to `filterableAttributes` too — a facet is a filter to Meilisearch.                  |
| `.retrievable(false)`       | Leaves it out of `displayedAttributes`, so it matches but never comes back.                  |
| `.array()`                  | Marks a repeated field.                                                                      |
| `.providerOptions({ ... })` | Per-field escape hatch, keyed by provider.                                                   |

### Weights are an ordering

Meilisearch has no per-attribute weight. It ranks by the order of `searchableAttributes`, earlier winning. This provider sorts your declared weights, highest first, and hands Meilisearch the resulting order. So weights are meaningful _relative to each other_, and the exact numbers are not.

### Dates

Meilisearch compares numbers, never strings — `created_at > "2024-01-01"` is a type error to it, and an ISO string only sorts chronologically while every document agrees on a timezone.

So every date value is indexed twice: verbatim under its own key, and as epoch milliseconds under a `__ts` sibling. Filters and sorts are rewritten onto the shadow automatically. You never see it: it is left out of the index' displayed attributes, and stripped from hits.

This means dates just work:

```ts
filters: {
  created_at: {
    $gte: '2024-01-01T00:00:00Z'
  }
}
filters: {
  created_at: {
    $lt: new Date()
  }
}
pagination: {
  order: {
    created_at: 'DESC'
  }
}
```

### Nested objects, and what Meilisearch cannot do

An `object().array()` field is stored nested and addressed by dotted path — `variants.sku` is filterable, searchable and retrievable like any other field.

The catch is that Meilisearch _flattens_ arrays of objects for filtering. `variants.color = "red" AND variants.size = "XL"` matches a product with a red S and a blue XL, because both predicates find _some_ element that satisfies them. The Search Module models this with a `correlated` flag; this provider refuses it at migration time rather than pretending, because Meilisearch cannot express it.

If you need it, index a single field that carries the combination — `variant_keys: ['red/XL', 'blue/S']` — and filter on that.

## Building documents

### `graph_fields`

The `query.graph` selection used to build documents. Extend it whenever you add a field, or there is nothing to put in it:

```ts
fields: search.define({ ...productSearchFields, brand: search.keyword().filterable() }),
graph_fields: [...productGraphFields, 'brand.name'],
transform: (product) => ({ ...product, brand: product.brand?.name }),
```

### `transform`

Turns one entity into one document. The default is the entity itself, which is why the field declarations and the graph selection are written to match.

A document must carry the primary key, and may carry keys the index does not declare — engines ignore what they do not know, though Meilisearch does store them.

### `filters`

What belongs in the index at all. Applied to _both_ seeding and ingestion, which is what makes removal work: unpublish a product and the next event finds it no longer matches, so it is deleted from the index rather than left behind as a stale hit.

```ts
filters: { status: 'published' }                       // the default for products
filters: { status: 'published', is_giftcard: false }   // narrower
filters: {}                                            // everything, e.g. for an admin index
```

### `seed`

An async generator that yields batches. The factories page by id — ordered and resumable — rather than by offset, because a seed of a large catalogue takes time and an offset would skip or repeat rows as documents are written underneath it.

`last_key` is the id of the last document of an interrupted run, which is what lets a failed seed resume rather than restart.

Writing one by hand:

```ts
async *seed({ container, filters, last_key }) {
  let cursor = last_key

  for (;;) {
    const { data } = await container.query.graph({
      entity: 'product',
      fields: ['id', 'title'],
      filters: { ...(cursor ? { id: { $gt: cursor } } : {}) },
      pagination: { take: 200, order: { id: 'ASC' } },
    })

    if (!data.length) return

    yield data
    cursor = data[data.length - 1].id

    if (data.length < 200) return
  }
}
```

Only `container.query` is available — the Search Module deliberately hands the definition a narrow container rather than the full one.

## Staying current

### `events`

The events that change what belongs in the index. The Search Module subscribes to exactly what is declared, and routes each delivered event to every index that asked for it.

The defaults list both namespaces, because the same change reaches the bus under two names — the module emits `product.product.updated`, and the workflow wrapping it emits `product.updated`. Ingesting twice is idempotent; missing one leaves a stale document.

```ts
export const productSearchEvents = [
  'product.created',
  'product.updated',
  'product.deleted',
  ProductEvents.PRODUCT_CREATED,
  ProductEvents.PRODUCT_UPDATED,
  ProductEvents.PRODUCT_DELETED,
  ProductEvents.PRODUCT_VARIANT_CREATED,
  ProductEvents.PRODUCT_VARIANT_UPDATED,
]
```

Replacing the list takes over routing entirely — add to it rather than replacing if you only mean to extend.

### `consume`

Turns one event into writes. The factories reconcile: fetch the affected ids under the index' `filters`, upsert what comes back, delete what does not. One code path covers creation, update, deletion, and "no longer matches the filters".

```ts
async consume(event, { container }) {
  const ids = eventEntityIds(event)

  return reconcileIds({ container, entity: 'product', fields, filters, ids, transform })
}
```

A variant event names a variant, not a product, so the product factory resolves it back to the products holding those variants. A _deleted_ variant cannot be looked up any more, so that case resolves to nothing and waits for the product's own event.

## Rebuilding

Filling an index is not something migrations do — they only create and alter. Seeding happens at application start for anything new, empty, or drifted, and on demand:

```ts
const search = container.resolve(Modules.SEARCH)

await search.reindex() // everything
await search.reindex({ index: 'product' }) // one index
await search.reindex({ index: 'product', filters: { collection_id: 'pcol_1' } })
```

Without `filters`, a reindex builds a shadow index and swaps it in when it is full, so reads keep being served throughout. With `filters` it writes in place — a partial rebuild must never swap, because the replacement would only hold the filtered slice.

## Several indexes over one entity

Give them different names:

```ts
// src/search/product-admin.ts — every status, for the admin
export default defineProductSearchIndex({
  name: 'product_admin',
  filters: {},
})
```

```ts
// src/search/product-fr.ts — French copy
export default defineProductSearchIndex({
  name: 'product_fr',
  locale: 'fr-FR',
  settings: { locales: ['fra'] },
})
```

Each is a separate physical index, seeded and kept current independently, and addressed by its own `entity` in a query.

For a copy per language, `locales` declares the whole set from one call and lets the store routes pick between them by the request's locale — see [multiple languages](i18n.md).
