import { MedusaRequest, MedusaResponse } from '@medusajs/framework'
import { SearchHitsParams, SearchHitsResponse, SearchHitsSchema, searchHits } from '../../../utils/hits'

export const StoreSearchProductsSchema = SearchHitsSchema

export type StoreSearchProductsParams = SearchHitsParams
export type ProductsHitsResponse = SearchHitsResponse

/**
 * The engine's own hits for the product index, without reading the products back
 * out of the database. Prices, inventory and tax are not part of a hit — use
 * `/store/meilisearch/products` when the response has to carry them.
 */
export async function GET(
  req: MedusaRequest<unknown, StoreSearchProductsParams>,
  res: MedusaResponse<ProductsHitsResponse>,
) {
  await searchHits(req, res, 'product')
}
