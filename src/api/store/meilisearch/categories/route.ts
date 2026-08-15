import { MedusaRequest, MedusaResponse } from '@medusajs/framework'
import { ProductCategoryDTO } from '@medusajs/types'
import { ContainerRegistrationKeys } from '../../../utils/medusa'
import { localizedSearch, requestLocale } from '../../../utils/locale'
import { isSearchRequest, meiliParams, orderByRelevance, searchModule, searchOptions } from '../../../utils/search'
import '../../../types'

export interface CategoriesResponse {
  // Envelope key kept as `categories` for backwards-compat with existing plugin
  // consumers (native uses `product_categories`); query/filter/sort behaviour matches
  // native `/store/product-categories`.
  categories: ProductCategoryDTO[]
  count: number
  limit?: number
  offset?: number
}

/**
 * Behaves like the native `/store/product-categories` route. The native middleware
 * stack (see ../../../middlewares.ts) populates `req.queryConfig` / `req.filterableFields`.
 * When a `query`/`semanticSearch` is present, the Search Module supplies the
 * candidate category ids + ranking; otherwise behaviour is identical to native.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse<CategoriesResponse>) {
  const meili = meiliParams(req)
  const isSearch = isSearchRequest(meili)

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const { fields, pagination } = req.queryConfig
  const filters = req.filterableFields
  const limit = pagination.take
  const offset = pagination.skip

  let categoryIds: string[] = []
  let totalCount = 0

  if (isSearch) {
    const search = searchModule(req)
    const { index, locales } = localizedSearch({
      search,
      base: 'category',
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

    categoryIds = result.hits.map((hit) => {
      return hit.id
    })
    totalCount = result.metadata.count ?? categoryIds.length

    if (!categoryIds.length) {
      res.json({ categories: [], count: 0, limit, offset })

      return
    }

    filters.id = { $in: categoryIds }
  }

  // The engine already applied the page when it ranked the ids, so paging again
  // here would skip past the ids that were just selected — on any page but the
  // first, that leaves nothing to return.
  const graphPagination = isSearch ? { ...pagination, skip: 0, take: categoryIds.length } : pagination

  const { data: categories = [], metadata } = await query.graph(
    {
      entity: 'product_category',
      fields,
      filters,
      pagination: graphPagination,
    },
    {
      locale: req.locale,
    },
  )

  res.json({
    categories: isSearch ? orderByRelevance(categories, categoryIds) : categories,
    count: isSearch ? totalCount : (metadata?.count ?? categories.length),
    offset: isSearch ? offset : (metadata?.skip ?? offset),
    limit: isSearch ? limit : (metadata?.take ?? limit),
  })
}
