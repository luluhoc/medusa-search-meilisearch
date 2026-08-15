import { MedusaRequest, MedusaResponse } from '@medusajs/framework'
import { describeCoverage } from '../../../../../utils/admin'
import { searchModule } from '../../../../../utils/search'
import { AdminIndexCoverageResponse } from '../../../types'

/**
 * Whether every product index holds this product. A catalogue indexed per
 * language stores the same product once per index, so the question a merchant
 * has is which languages are missing it — an answer the single-index route can
 * only give one index at a time.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse<AdminIndexCoverageResponse>) {
  const search = searchModule(req)

  res.json(await describeCoverage(search, { entity: 'product', base: 'product', id: req.params.id }))
}
