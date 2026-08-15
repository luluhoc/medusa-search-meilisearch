import { normalizeLocale } from '@medusajs/utils'

/**
 * The locale codes Meilisearch's tokenizer accepts — ISO-639-1 and ISO-639-3
 * alike. A code outside this set is refused by the engine when settings are
 * applied, which would fail a migration over a language the catalogue only
 * happens to be translated into. A locale that is not here is therefore indexed
 * without a declared language and left to Meilisearch's own detection.
 */
const ENGINE_LOCALES = new Set([
  'af',
  'ak',
  'am',
  'ar',
  'az',
  'be',
  'bn',
  'bg',
  'ca',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'eo',
  'et',
  'fi',
  'fr',
  'gu',
  'he',
  'hi',
  'hr',
  'hu',
  'hy',
  'id',
  'it',
  'jv',
  'ja',
  'kn',
  'ka',
  'km',
  'ko',
  'la',
  'lv',
  'lt',
  'ml',
  'mr',
  'mk',
  'my',
  'ne',
  'nl',
  'nb',
  'or',
  'pa',
  'fa',
  'pl',
  'pt',
  'ro',
  'ru',
  'si',
  'sk',
  'sl',
  'sn',
  'es',
  'sr',
  'sv',
  'ta',
  'te',
  'tl',
  'th',
  'tk',
  'tr',
  'uk',
  'ur',
  'uz',
  'vi',
  'yi',
  'zh',
  'zu',
  'afr',
  'aka',
  'amh',
  'ara',
  'aze',
  'bel',
  'ben',
  'bul',
  'cat',
  'ces',
  'cmn',
  'dan',
  'deu',
  'ell',
  'eng',
  'epo',
  'est',
  'fin',
  'fra',
  'guj',
  'heb',
  'hin',
  'hrv',
  'hun',
  'hye',
  'ind',
  'ita',
  'jav',
  'jpn',
  'kan',
  'kat',
  'khm',
  'kor',
  'lat',
  'lav',
  'lit',
  'mal',
  'mar',
  'mkd',
  'mya',
  'nep',
  'nld',
  'nob',
  'ori',
  'pan',
  'pes',
  'pol',
  'por',
  'ron',
  'rus',
  'sin',
  'slk',
  'slv',
  'sna',
  'spa',
  'srp',
  'swe',
  'tam',
  'tel',
  'tgl',
  'tha',
  'tuk',
  'tur',
  'ukr',
  'urd',
  'uzb',
  'vie',
  'yid',
  'zho',
  'zul',
])

/**
 * Language subtags that name a language Meilisearch knows under another code.
 * The deprecated ISO-639-1 codes still come out of some browsers, and Norwegian
 * is written `no` far more often than as one of its two written standards.
 */
const LOCALE_ALIASES: Record<string, string> = {
  in: 'id',
  iw: 'he',
  ji: 'yi',
  fil: 'tl',
  no: 'nb',
  nn: 'nb',
}

/** A BCP 47 tag in the casing Medusa stores translations under, e.g. `fr-FR`. */
export function normalizeLocaleTag(locale: string): string {
  return normalizeLocale(locale.trim())
}

/**
 * The index a locale gets when a factory fans out over `locales`. The tag is
 * kept whole rather than reduced to its language, because `pt-BR` and `pt-PT`
 * are different catalogues, and Meilisearch accepts `-` in an index name.
 */
export function localeIndexName(base: string, locale: string): string {
  return `${base}-${normalizeLocaleTag(locale)}`
}

/**
 * The locale to tokenize with, as Meilisearch names it. A region says nothing
 * about tokenization — `fr-CA` and `fr-FR` are both analyzed as French — so only
 * the language subtag is passed on, and only when the engine knows it.
 */
export function engineLocales(locale: string): string[] | undefined {
  const language = normalizeLocaleTag(locale).split('-')[0].toLowerCase()
  const code = LOCALE_ALIASES[language] ?? language

  return ENGINE_LOCALES.has(code) ? [code] : undefined
}

/**
 * The locales to look for an index under, most specific first. A storefront
 * asking for `fr-CA` is better served by a French index than by the default one,
 * so the region is dropped before giving up.
 */
export function localeFallbacks(locale: string): string[] {
  const tag = normalizeLocaleTag(locale)
  const language = tag.split('-')[0].toLowerCase()

  return tag === language ? [tag] : [tag, language]
}

interface LocalizedIndex {
  /** The index' name, as `defineSearchIndex` registered it. */
  index: string

  /** The index this one is the localized copy of, e.g. `product`. */
  base: string

  /** The locale its documents were read in, e.g. `fr-FR`. Absent for an index holding the default language. */
  locale?: string

  /** The entity it indexes, e.g. `product`. */
  entity: string
}

/**
 * What each index holds — which entity, and in which language. Index definitions
 * are declared by the application at boot and read again by the HTTP routes on
 * every request, so the map has to outlive both; it hangs off `globalThis` under
 * a namespaced key so that two copies of this package in one dependency tree
 * still agree, the way Medusa's own module registry does.
 */
const REGISTRY_KEY = Symbol.for('@luluhoc/medusa-search-meilisearch/localized-indexes')

type Registry = Map<string, LocalizedIndex>

function registry(): Registry {
  const global = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry }

  global[REGISTRY_KEY] ??= new Map()

  return global[REGISTRY_KEY]
}

/** Records what `index` holds. Called by the index factories. */
export function registerLocalizedIndex(entry: LocalizedIndex): void {
  registry().set(entry.index, entry)
}

/** The locale an index was declared for, or `undefined` for a default-language one. */
export function indexLocale(index: string): string | undefined {
  return registry().get(index)?.locale
}

/** The entity an index was declared over, or `undefined` for one this package did not declare. */
export function indexEntity(index: string): string | undefined {
  return registry().get(index)?.entity
}

/** One loaded index and the language it holds, as the admin routes report it. */
export interface EntityIndex {
  index: string
  locale?: string
}

/**
 * Every loaded index holding `entity` — the default-language one and each
 * localized copy — which is what turns "is this product indexed?" into an answer
 * per language rather than per index name.
 *
 * Registration is the evidence, and the naming convention is the fallback for an
 * index declared without this package's factories: those register nothing, and a
 * name is then all there is to go on. `available` is what the Search Module
 * actually loaded, so a definition that was renamed or dropped is not reported.
 */
export function indexesForEntity({
  available,
  entity,
  base,
}: {
  available: string[]
  entity: string
  base: string
}): EntityIndex[] {
  const indexes = registry()
  const found: EntityIndex[] = []

  for (const name of available) {
    const entry = indexes.get(name)

    if (entry) {
      if (entry.entity === entity) {
        found.push({ index: name, locale: entry.locale })
      }

      continue
    }

    if (name === base || name.startsWith(`${base}-`)) {
      found.push({ index: name })
    }
  }

  // The default-language index first, since it is the one a merchant reads as
  // "the catalogue" and the localized copies as translations of it.
  return found.sort((left, right) => {
    return (left.locale ?? '').localeCompare(right.locale ?? '')
  })
}

/**
 * The index to search for a request in `locale`, or `undefined` when no index
 * holds that language and the caller should fall back to the default one.
 *
 * A registered name is preferred, so an index declared under a name of its own
 * still resolves; the naming convention is tried next, which covers indexes
 * declared by hand rather than through this package's factories. `available` is
 * what the Search Module actually loaded — an index that was renamed or removed
 * must not be searched just because it was once registered.
 */
export function resolveLocalizedIndex({
  available,
  base,
  locale,
}: {
  available: string[]
  base: string
  locale: string
}): string | undefined {
  const indexes = registry()

  for (const tag of localeFallbacks(locale)) {
    // Every index registered for this language is considered, not just the first:
    // a definition that was renamed or dropped stays in the registry for the life
    // of the process, and must not stand in for one that is actually loaded.
    const registered = [...indexes.values()].find((entry) => {
      return entry.base === base && entry.locale === tag && available.includes(entry.index)
    })

    if (registered) {
      return registered.index
    }

    const conventional = localeIndexName(base, tag)

    if (available.includes(conventional)) {
      return conventional
    }
  }

  return undefined
}
