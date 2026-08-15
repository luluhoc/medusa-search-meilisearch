import { MedusaRequest, MedusaResponse } from '@medusajs/framework'
import { SearchHitsParams, SearchHitsResponse, SearchHitsSchema, searchHits } from '../../../utils/hits'

export const StoreSearchCategoriesSchema = SearchHitsSchema

export type StoreSearchCategoriesParams = SearchHitsParams
export type CategoriesHitsResponse = SearchHitsResponse

/**
 * The engine's own hits for the category index, without reading the categories
 * back out of the database.
 */
export async function GET(
  req: MedusaRequest<unknown, StoreSearchCategoriesParams>,
  res: MedusaResponse<CategoriesHitsResponse>,
) {
  await searchHits(req, res, 'category')
}
