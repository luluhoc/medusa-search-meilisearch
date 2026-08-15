import { MedusaRequest } from '@medusajs/framework'
import { SearchTypes } from '@medusajs/types'
import { engineLocales, resolveLocalizedIndex } from '../../indexes/locales'
import '../types'

/**
 * The language the request asked for. Medusa resolves it for every `/store`
 * route from `?locale=` or the `x-medusa-locale` header, and normalizes it to a
 * BCP 47 tag, so the same parameter that decides which language is *returned*
 * decides which index is *searched*.
 */
export function requestLocale(req: MedusaRequest): string | undefined {
  return typeof req.locale === 'string' && req.locale !== '' ? req.locale : undefined
}

export interface LocalizedSearch {
  /** The index to search. */
  index: string

  /** The engine's tokenization language, when one follows from the request. */
  locales?: string[]
}

/**
 * Which index answers a request, and in which language it is tokenized.
 *
 * A named index is taken as given — asking for one by name is asking for that
 * one. Otherwise the request's locale picks the index that holds it, falling
 * back to the language alone (`fr-CA` → `fr-FR`'s index if that is what exists)
 * and then to the default index, because a storefront in a language nobody
 * indexed is better served by untranslated hits than by none.
 *
 * The query language follows the index rather than the request: tokenizing a
 * query as French against an index built in English would degrade a search that
 * currently works, so it is only derived from the locale that just chose the
 * index. An index named outright keeps the language it declared, and an explicit
 * `language` overrides either.
 */
export function localizedSearch({
  search,
  base,
  requested,
  locale,
  language,
}: {
  search: SearchTypes.ISearchModuleService
  base: string
  requested?: string
  locale?: string
  language?: string
}): LocalizedSearch {
  const routed = requested === undefined && locale !== undefined
  const index = routed ? (resolveLocalizedIndex({ available: search.listIndexes(), base, locale }) ?? base) : requested
  const resolved = index ?? base
  const locales = language ? [language] : routed && resolved !== base ? engineLocales(locale) : undefined

  return locales ? { index: resolved, locales } : { index: resolved }
}
