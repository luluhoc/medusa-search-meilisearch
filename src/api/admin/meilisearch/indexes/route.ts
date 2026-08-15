import { MedusaRequest, MedusaResponse } from '@medusajs/framework'
import { describeIndex } from '../../../utils/admin'
import { searchModule } from '../../../utils/search'
import { AdminSearchIndexesResponse } from '../types'

/**
 * Every index the Search Module has loaded, with the number of documents
 * Meilisearch holds for each. Counted one index at a time rather than in a
 * single multi-search: an index that is declared but not migrated yet does not
 * exist in Meilisearch, and one missing index must not take the listing with it.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse<AdminSearchIndexesResponse>) {
  const search = searchModule(req)
  const indexes = await Promise.all(
    search.listIndexes().map(async (name) => {
      return describeIndex(search, name)
    }),
  )

  res.json({ indexes })
}
