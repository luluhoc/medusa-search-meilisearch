import { MedusaRequest, MedusaResponse } from '@medusajs/framework'
import z from 'zod'
import {
  PRODUCT_UPDATED_EVENT,
  reindexEntity,
  resolveIndexName,
  retrieveIndexedDocument,
} from '../../../../utils/admin'
import { searchModule } from '../../../../utils/search'
import { AdminIndexedDocumentResponse } from '../../types'

export const AdminIndexedProductSchema = z.object({
  /** Which index to read the product from. Defaults to `product`. */
  index: z.string().optional(),
})

export type AdminIndexedProductParams = z.infer<typeof AdminIndexedProductSchema>

/**
 * What one index currently holds for a product. This is the engine's own copy,
 * not the product read back out of the database, which is the whole point: it is
 * how a merchant sees that a document is missing, stale, or holding a field the
 * definition no longer produces.
 */
export async function GET(
  req: MedusaRequest<unknown, AdminIndexedProductParams>,
  res: MedusaResponse<AdminIndexedDocumentResponse>,
) {
  const search = searchModule(req)
  const index = resolveIndexName(search.listIndexes(), req.validatedQuery.index)

  res.json(await retrieveIndexedDocument(search, index, req.params.id))
}

/**
 * Reindexes one product and answers with the document as it now stands. The
 * write is waited on, so a response here means the engine has applied it and the
 * document in the body is what a search would return.
 */
export async function POST(
  req: MedusaRequest<unknown, AdminIndexedProductParams>,
  res: MedusaResponse<AdminIndexedDocumentResponse>,
) {
  const search = searchModule(req)
  const index = resolveIndexName(search.listIndexes(), req.validatedQuery.index)

  await reindexEntity(search, { index, id: req.params.id, event: PRODUCT_UPDATED_EVENT })

  res.json(await retrieveIndexedDocument(search, index, req.params.id))
}
