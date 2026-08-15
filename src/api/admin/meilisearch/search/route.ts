import { MedusaRequest, MedusaResponse } from '@medusajs/framework'
import z from 'zod'
import { resolveIndexName, searchIndexed } from '../../../utils/admin'
import { searchModule } from '../../../utils/search'
import { AdminSearchResponse } from '../types'

/** How deep the ranking scan looks by default, and how deep it may be asked to. */
const DEFAULT_SCAN = 200
const MAX_SCAN = 1000

export const AdminSearchSchema = z.object({
  query: z.string().optional(),
  /** Which index to search. Defaults to `product`. */
  index: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).default(10),
  offset: z.coerce.number().min(0).default(0),
  /** Facets to compute, e.g. `facets=status&facets=tags.value`. */
  facets: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      return value === undefined ? undefined : Array.isArray(value) ? value : [value]
    }),
  semanticSearch: z.coerce.boolean().default(false),
  semanticRatio: z.coerce.number().min(0).max(1).default(0.5),
  embedder: z.string().default('default'),
  /** An id to report the ranking position of, alongside the page of hits. */
  find: z.string().optional(),
  /** How many hits to look through for `find` before calling it unplaced. */
  scan: z.coerce.number().min(1).max(MAX_SCAN).default(DEFAULT_SCAN),
})

export type AdminSearchParams = z.infer<typeof AdminSearchSchema>

/**
 * Runs a search against one index and answers with what the engine returned —
 * ranked hits, scores, an exact count, and optionally where a known id placed.
 *
 * This is deliberately not the store route: no prices, no sales channels, no
 * database read. A merchant asking why a product does not come up needs the
 * engine's own answer, not one the storefront's filters have already reshaped.
 */
export async function GET(req: MedusaRequest<unknown, AdminSearchParams>, res: MedusaResponse<AdminSearchResponse>) {
  const params = req.validatedQuery
  const search = searchModule(req)
  const index = resolveIndexName(search.listIndexes(), params.index)

  res.json(
    await searchIndexed(search, {
      index,
      query: params.query,
      limit: params.limit,
      offset: params.offset,
      facets: params.facets,
      find: params.find,
      scan: params.scan,
      ...(params.semanticSearch
        ? { vector: { field: params.embedder, query: params.query, semantic_ratio: params.semanticRatio } }
        : {}),
    }),
  )
}
