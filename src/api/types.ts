/* eslint-disable @typescript-eslint/no-namespace */

export interface MeiliParams {
  /** Free text. Absent means the route behaves exactly like its native counterpart. */
  query?: string

  /**
   * The search index to query, as named by its `defineSearchIndex` call.
   *
   * @default "product" / "category"
   */
  index?: string

  /** Query-time language hint, passed to the engine as `search_options.locales`. */
  language?: string

  /** Run the query against an embedder instead of, or alongside, the keyword index. */
  semanticSearch: boolean

  /** 0 is pure keyword, 1 is pure semantic. */
  semanticRatio: number

  /** The embedder to use for semantic search, as registered on the index. */
  embedder: string
}

// Augment Express.Request so req.meiliParams and req.locale are available
// on MedusaRequest (which extends Express.Request) without type casts.
declare global {
  namespace Express {
    interface Request {
      meiliParams?: MeiliParams
      locale?: string
    }
  }
}
