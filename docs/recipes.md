# Recipes

Patterns that come up repeatedly, each one a complete `src/search/*.ts` file.

- [Indexing prices](#indexing-prices)
- [Categories and tags](#categories-and-tags)
- [Several languages](#several-languages)
- [An admin index alongside the storefront one](#an-admin-index-alongside-the-storefront-one)
- [Indexing a custom entity](#indexing-a-custom-entity)
- [Keeping derived data current](#keeping-derived-data-current)
- [A type-ahead endpoint](#a-type-ahead-endpoint)

## Indexing prices

Prices are not in the default index because a price is not one number — it depends on region, currency and price list, and choosing one belongs to your store.

If you need to **display** prices, do not index them: use [`/store/meilisearch/products`](store-api.md), which reads them live through Medusa's pricing system. Index them only when you need to **filter or sort by** them.

```ts
// src/search/product.ts
import { search } from '@medusajs/framework/utils'
import {
  defineProductSearchIndex,
  productSearchFields,
  productGraphFields,
} from '@luluhoc/medusa-search-meilisearch/indexes'

const CURRENCY = 'eur'

export default defineProductSearchIndex({
  fields: search.define({
    ...productSearchFields,
    min_price: search
      .float()
      .filterable()
      .sortable()
      .facetable({ types: ['range', 'stats'] }),
    max_price: search.float().filterable().sortable(),
    currency_code: search.keyword().filterable().facetable(),
  }),
  graph_fields: [...productGraphFields, 'variants.prices.amount', 'variants.prices.currency_code'],
  transform: (product) => {
    const amounts = (product.variants ?? [])
      .flatMap((variant) => variant.prices ?? [])
      .filter((price) => price.currency_code === CURRENCY && !price.price_list_id)
      .map((price) => price.amount)

    return {
      ...product,
      currency_code: CURRENCY,
      min_price: amounts.length ? Math.min(...amounts) : null,
      max_price: amounts.length ? Math.max(...amounts) : null,
    }
  },
})
```

Then a price slider and a histogram come from one query:

```ts
await search.search({
  entity: 'product',
  filters: { q: 'shirt', min_price: { $lte: 5000 } },
  pagination: { order: { min_price: 'ASC' } },
  search_options: {
    facets: [{ field: 'min_price', type: 'range', ranges: [{ to: 2000 }, { from: 2000, to: 5000 }, { from: 5000 }] }],
  },
})
```

**Several currencies.** Either one field per currency (`min_price_eur`, `min_price_usd`) on one index, or [one index per currency](#several-languages) — same shape as the language recipe. The first keeps one index and grows its fields; the second keeps documents small.

**Staying current** is the catch: a price change may not emit a product event. See [keeping derived data current](#keeping-derived-data-current).

## Categories and tags

Already indexed by default, as `categories [{ id, name, handle }]` and `tags [{ id, value }]`, both filterable and facetable:

```ts
await search.search({
  entity: 'product',
  filters: {
    q: 'shirt',
    'tags.value': { $in: ['summer', 'cotton'] },
    'categories.handle': 'shirts',
  },
  search_options: {
    facets: [
      { field: 'categories.name', type: 'value', limit: 10 },
      { field: 'tags.value', type: 'value' },
    ],
    disjunctive_facets: true,
  },
})
```

`disjunctive_facets` is what keeps the other tags visible after one is picked.

To add a field to them, extend the schema and the graph selection together:

```ts
fields: search.define({
  ...productSearchFields,
  categories: search
    .object({
      id: search.keyword().filterable(),
      name: search.text().searchable({ weight: 2 }).facetable(),
      handle: search.keyword().filterable(),
      description: search.text().searchable(),
    })
    .array(),
}),
graph_fields: [...productGraphFields, 'categories.description'],
```

**The flattening caveat:** filtering on two sub-fields of an object array matches across _different_ elements. See [index definitions](index-definitions.md#nested-objects-and-what-meilisearch-cannot-do).

## Several languages

An index holds the text it was seeded with, so searching in French means indexing in French. Declare the languages and the factory declares one index per language, each read in that locale and tokenized by its own analyzer:

```ts
// src/search/product.ts
import { defineProductSearchIndex } from '@luluhoc/medusa-search-meilisearch/indexes'

export default defineProductSearchIndex({
  default_locale: 'en-US',
  locales: ['fr-FR', 'de-DE'],
})
```

The store routes then route a request to the index holding the language it asked for, so a storefront names a language rather than an index:

```bash
curl '/store/meilisearch/products?query=chemise&locale=fr-FR'
```

Translations, tokenization, what happens to a language nobody indexed, and how translation edits reach the index are all in [multiple languages](i18n.md).

## An admin index alongside the storefront one

The storefront index holds published products only. An admin search wants drafts too:

```ts
// src/search/product-admin.ts
import { defineProductSearchIndex } from '@luluhoc/medusa-search-meilisearch/indexes'

export default defineProductSearchIndex({
  name: 'product_admin',
  filters: {}, // every status
  settings: { typo_tolerance: { disabled_on_attributes: ['sku'] } },
})
```

Two physical indexes, seeded and kept current independently. Query `entity: 'product_admin'` from an authenticated admin route only — nothing about an index name makes it private, so keep it out of your store endpoints.

## Indexing a custom entity

Drop to `defineSearchIndex` when it is not products or categories:

```ts
// src/search/support-article.ts
import { defineSearchIndex, search } from '@medusajs/framework/utils'

export default defineSearchIndex({
  name: 'support_article',
  entity: 'support_article',

  fields: search.define({
    id: search.keyword().filterable(),
    title: search.text().searchable({ weight: 5 }),
    body: search.text().searchable(),
    topic: search.keyword().filterable().facetable(),
    published_at: search.date().filterable().sortable(),
  }),

  events: ['support_article.created', 'support_article.updated', 'support_article.deleted'],

  async consume(event, { container }) {
    const ids = (Array.isArray(event.data) ? event.data : [event.data]).map((entry) => entry.id)

    const { data } = await container.query.graph({
      entity: 'support_article',
      fields: ['id', 'title', 'body', 'topic', 'published_at'],
      filters: { id: ids },
    })

    const found = new Set(data.map((article) => article.id))
    const removed = ids.filter((id) => !found.has(id))

    return [
      ...(data.length ? [{ action: 'upsert' as const, documents: data }] : []),
      ...(removed.length ? [{ action: 'delete' as const, filters: { id: removed } }] : []),
    ]
  },

  async *seed({ container, last_key }) {
    let cursor = last_key

    for (;;) {
      const { data } = await container.query.graph({
        entity: 'support_article',
        fields: ['id', 'title', 'body', 'topic', 'published_at'],
        filters: cursor ? { id: { $gt: cursor } } : {},
        pagination: { take: 200, order: { id: 'ASC' } },
      })

      if (!data.length) return

      yield data
      cursor = data[data.length - 1].id

      if (data.length < 200) return
    }
  },
})
```

The `reconcileIds` and `streamEntities` helpers this package exports do exactly the reconcile-and-page work above, if you would rather not write it:

```ts
import { reconcileIds, streamEntities, eventEntityIds } from '@luluhoc/medusa-search-meilisearch/indexes'
```

## Keeping derived data current

Anything you derive from something other than the indexed entity goes stale silently: a price change, a category rename, a brand's name. Three options, in order of preference.

**1. Subscribe to the events that actually change it.** Add them to `events` and resolve them back to the indexed entity in `consume` — the product factory does this for variant events.

```ts
events: [...productSearchEvents, 'price.updated'],
async consume(event, context) {
  const ids = event.name === 'price.updated'
    ? await productIdsForPrices(context.container, eventEntityIds(event))
    : eventEntityIds(event)

  return reconcileIds({ ...context, ids })
}
```

**2. Rebuild the affected slice.** A partial reindex writes in place and is cheap:

```ts
await search.reindex({ index: 'product', filters: { collection_id: 'pcol_1' } })
```

**3. Rebuild on a schedule.** A full reindex builds a shadow index and swaps it in, so reads keep being served throughout:

```ts
// src/jobs/reindex-search.ts
import { MedusaContainer } from '@medusajs/framework/types'
import { Modules } from '@medusajs/framework/utils'

export default async function reindexSearch(container: MedusaContainer) {
  await container.resolve(Modules.SEARCH).reindex()
}

export const config = { name: 'reindex-search', schedule: '0 3 * * *' }
```

Nightly is a reasonable backstop even with good event coverage — it repairs whatever was missed while a worker was down.

## A type-ahead endpoint

One request, no database read, products and categories together:

```ts
// src/api/store/search/suggestions/route.ts
import { MedusaRequest, MedusaResponse } from '@medusajs/framework'
import { Modules } from '@medusajs/framework/utils'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const q = String(req.query.q ?? '')

  if (q.length < 2) {
    res.json({ products: [], categories: [] })

    return
  }

  const search = req.scope.resolve(Modules.SEARCH)

  const [products, categories] = await search.searchMany([
    {
      entity: 'product',
      fields: ['id', 'title', 'handle', 'thumbnail'],
      filters: { q },
      pagination: { take: 6 },
      search_options: { highlight: { fields: ['title'] }, min_score: 0.3 },
    },
    {
      entity: 'category',
      fields: ['id', 'name', 'handle'],
      filters: { q },
      pagination: { take: 3 },
    },
  ])

  res.json({
    products: products.hits.map((hit) => ({ ...hit.document, highlight: hit.highlights?.title?.[0] })),
    categories: categories.hits.map((hit) => hit.document),
  })
}
```

`searchMany` sends both queries as a single request to Meilisearch. `min_score` is what stops a two-letter query from rendering six unrelated products.
