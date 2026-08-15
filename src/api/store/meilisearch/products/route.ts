import { MedusaRequest, MedusaResponse } from '@medusajs/framework'
import { ProductDTO } from '@medusajs/types'
import {
  ContainerRegistrationKeys,
  QueryContext,
  isPresent,
  wrapVariantsWithInventoryQuantityForSalesChannel,
  wrapProductsWithTaxPrices,
} from '../../../utils/medusa'
import { localizedSearch, requestLocale } from '../../../utils/locale'
import { isSearchRequest, meiliParams, orderByRelevance, searchModule, searchOptions } from '../../../utils/search'
import '../../../types'

export interface ProductsResponse {
  products: ProductDTO[]
  count: number
  limit?: number
  offset?: number
}

/**
 * Behaves like the native `/store/products` route. The native middleware stack
 * (see ../../../middlewares.ts) populates `req.queryConfig`, `req.filterableFields`,
 * `req.pricingContext` and `req.taxContext`. When a `query`/`semanticSearch` is
 * present, the Search Module supplies the candidate product ids + ranking and that
 * id set is intersected into the native filters; everything else (fields, filters,
 * pricing, tax, inventory_quantity) is handled exactly as native.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse<ProductsResponse>) {
  const meili = meiliParams(req)
  const isSearch = isSearchRequest(meili)

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const { fields, pagination } = req.queryConfig
  const filters = req.filterableFields
  const limit = pagination.take
  const offset = pagination.skip

  // `variants.inventory_quantity` is a virtual field that `query.graph` cannot resolve.
  // Native strips it from the fields and post-computes it. Mirror that here.
  const allFields: string[] = [...fields]
  const withInventoryQuantity = allFields.some((f) => {
    return f.includes('variants.inventory_quantity')
  })
  const graphFields = withInventoryQuantity
    ? allFields.filter((f) => {
        return !f.includes('variants.inventory_quantity')
      })
    : allFields

  let productIds: string[] = []
  let totalCount = 0

  if (isSearch) {
    const search = searchModule(req)
    // The locale that decides which language the products are read back in also
    // decides which index is searched, so a storefront asks for a language once.
    const { index, locales } = localizedSearch({
      search,
      base: 'product',
      requested: meili.index,
      locale: requestLocale(req),
      language: meili.language,
    })

    const result = await search.search({
      entity: index,
      fields: ['id'],
      filters: { q: meili.query },
      pagination: { skip: offset, take: limit },
      search_options: searchOptions(meili, locales ? { locales } : undefined),
    })

    productIds = result.hits.map((hit) => {
      return hit.id
    })
    totalCount = result.metadata.count ?? productIds.length

    if (!productIds.length) {
      res.json({ products: [], count: 0, limit, offset })

      return
    }

    filters.id = { $in: productIds }
  }

  // Native pricing context (provided by setPricingContext middleware).
  const context: Record<string, unknown> = {}

  if (isPresent(req.pricingContext)) {
    context.variants = { calculated_price: QueryContext({ ...req.pricingContext }) }
  }

  // The engine already applied the page when it ranked the ids, so paging again
  // here would skip past the ids that were just selected — on any page but the
  // first, that leaves nothing to return. Ordering is dropped with it: relevance
  // is restored below.
  const graphPagination = isSearch ? { ...pagination, skip: 0, take: productIds.length } : pagination

  const { data: products = [], metadata } = await query.graph(
    {
      entity: 'product',
      fields: graphFields,
      filters,
      pagination: graphPagination,
      context,
    },
    {
      cache: { enable: true },
      locale: req.locale,
    },
  )

  if (withInventoryQuantity) {
    await wrapVariantsWithInventoryQuantityForSalesChannel(
      req,
      products
        .map((product) => {
          return product.variants
        })
        .flat(1),
    )
  }

  await wrapProductsWithTaxPrices(req, products)

  res.json({
    products: isSearch ? orderByRelevance(products, productIds) : products,
    count: isSearch ? totalCount : (metadata?.count ?? products.length),
    offset: isSearch ? offset : (metadata?.skip ?? offset),
    limit: isSearch ? limit : (metadata?.take ?? limit),
  })
}
