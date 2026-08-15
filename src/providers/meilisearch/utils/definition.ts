import { SearchTypes } from '@medusajs/types'
import { MedusaError } from '@medusajs/utils'
import type { Embedders, Locale, Settings } from 'meilisearch'
import { MEILISEARCH_PROVIDER_KEY, MeilisearchFieldOptions, MeilisearchProviderOptions } from '../types'
import { shadowPath } from './values'

/**
 * Meilisearch reserves `_geo` for geo filtering and sorting; a geo field under any
 * other name is an ordinary object to it, which would leave `_geoRadius` filters
 * silently unmatched.
 */
const GEO_FIELD = '_geo'

/**
 * The `maxTotalHits` derived when nothing else declares one. Meilisearch's own
 * default is 1000, which is below the size of an ordinary catalogue — high enough
 * here that a count over a catalogue reads as a count, and bounded so a query
 * asking for a page far past the end still costs something finite.
 */
const DEFAULT_MAX_TOTAL_HITS = 100_000

export interface MeilisearchFieldPlan {
  path: string
  field: SearchTypes.SearchFieldDefinition
  /** Filters and sorts on this field are rewritten onto its epoch-ms shadow. */
  isDate: boolean
}

export interface MeilisearchIndexPlan {
  /** The definition's logical name, for error messages that name what to fix. */
  name: string
  physicalName: string
  primaryKey: string
  fields: Map<string, MeilisearchFieldPlan>
  settings: Settings
}

/**
 * Walks a definition's fields into dotted paths. Object fields yield themselves
 * and their descendants, matching how the Search Module addresses nested fields.
 */
function flattenFields(
  fields: Record<string, SearchTypes.SearchFieldDefinition>,
  prefix = '',
): { path: string; field: SearchTypes.SearchFieldDefinition }[] {
  return Object.entries(fields).flatMap(([name, field]) => {
    const path = prefix ? `${prefix}.${name}` : name
    const self = { path, field }

    return field.type === 'object' && field.fields ? [self, ...flattenFields(field.fields, path)] : [self]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The embedder a `vector` field configures, if it configures one. Read through a
 * guard rather than asserted: `provider_options` is untyped by construction, and
 * what is in it is Meilisearch's to validate.
 */
function fieldEmbedder(field: SearchTypes.SearchFieldDefinition): Record<string, unknown> | undefined {
  const options: MeilisearchFieldOptions = field.provider_options?.[MEILISEARCH_PROVIDER_KEY] ?? {}

  return isRecord(options.embedder) ? options.embedder : undefined
}

/**
 * Meilisearch caps `totalHits` — and how deep a caller can page — at
 * `maxTotalHits`, and applies its default of 1000 silently: an exact count over a
 * larger catalogue comes back as the number 1000, and a storefront paging through
 * results dead-ends there. Answering "1000" for 10,000 documents is the kind of
 * approximation this provider refuses everywhere else, so a catalogue-sized
 * ceiling is derived when nothing declares one.
 */
function pagination(
  settings: SearchTypes.SearchIndexSettings,
  options: MeilisearchProviderOptions,
): Settings['pagination'] {
  const declared = settings.pagination?.max_total_hits

  if (declared !== undefined) {
    return { maxTotalHits: declared }
  }

  // The provider-wide `settings` option is spread *before* the derived settings,
  // so a default emitted here would override the one setting it should defer to.
  if (options.settings?.pagination) {
    return undefined
  }

  return { maxTotalHits: DEFAULT_MAX_TOTAL_HITS }
}

/** Per-index Meilisearch settings, from `settings.provider_options.meilisearch`. */
function indexOptions(settings: SearchTypes.SearchIndexSettings): Settings {
  const options = settings.provider_options?.[MEILISEARCH_PROVIDER_KEY]

  return isRecord(options) ? options : {}
}

function fail(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message)
}

/**
 * Refuses a definition Meilisearch cannot hold. Raised from `upsertIndex`, so it
 * surfaces while migrations run rather than as absent hits later.
 */
export function assertIndexSupported(definition: SearchTypes.ResolvedSearchIndexDefinition): void {
  for (const { path, field } of flattenFields(definition.fields)) {
    if (field.correlated) {
      fail(
        `Field "${path}" on search index "${definition.name}" is declared correlated, which Meilisearch cannot express: it flattens arrays of objects, so a filter on two sub-fields matches across different elements`,
      )
    }

    if (field.type === 'geo' && path !== GEO_FIELD) {
      fail(
        `Geo field "${path}" on search index "${definition.name}" must be named "${GEO_FIELD}" — Meilisearch only recognises geo data under that key`,
      )
    }

    if (field.type === 'vector' && !field.dimensions && !fieldEmbedder(field)) {
      fail(
        `Vector field "${path}" on search index "${definition.name}" needs "dimensions", or an embedder under provider_options.${MEILISEARCH_PROVIDER_KEY}.embedder that declares them`,
      )
    }
  }
}

function isSearchable(field: SearchTypes.SearchFieldDefinition): boolean {
  return field.searchable === true || typeof field.searchable === 'object'
}

function searchWeight(field: SearchTypes.SearchFieldDefinition): number {
  return typeof field.searchable === 'object' ? (field.searchable.weight ?? 1) : 1
}

/**
 * Meilisearch has no per-attribute weight: it ranks by the *order* of
 * `searchableAttributes`, earlier attributes winning. Declared weights therefore
 * become an ordering, highest first, with declaration order breaking ties.
 */
function searchableAttributes(fields: MeilisearchFieldPlan[]): string[] {
  return fields
    .filter(({ field }) => {
      return isSearchable(field)
    })
    .map((plan, position) => {
      return { plan, position }
    })
    .sort((a, b) => {
      return searchWeight(b.plan.field) - searchWeight(a.plan.field) || a.position - b.position
    })
    .map(({ plan }) => {
      return plan.path
    })
}

function typoTolerance(settings: SearchTypes.SearchIndexSettings): Settings['typoTolerance'] {
  const typos = settings.typo_tolerance

  if (!typos) {
    return undefined
  }

  return {
    enabled: typos.enabled,
    disableOnAttributes: typos.disabled_on_attributes,
    minWordSizeForTypos: {
      oneTypo: typos.min_word_size_for_one_typo,
      twoTypos: typos.min_word_size_for_two_typos,
    },
  }
}

/**
 * Embedders come from two places: the provider's own option, for embedders
 * Meilisearch generates from a document template and that every index shares, and
 * a `vector` field, which registers an embedder under its own name. A field that
 * declares nothing but `dimensions` gets a `userProvided` embedder, the one source
 * that matches a vector the seed writes into the document itself.
 */
function embedders(fields: MeilisearchFieldPlan[], options: MeilisearchProviderOptions): Embedders | undefined {
  const declared = fields.filter(({ field }) => {
    return field.type === 'vector'
  })

  if (!declared.length) {
    return options.embedders
  }

  const fromFields: Embedders = {}

  for (const { path, field } of declared) {
    fromFields[path] = {
      source: 'userProvided',
      dimensions: field.dimensions ?? 0,
      ...fieldEmbedder(field),
    }
  }

  return { ...options.embedders, ...fromFields }
}

/**
 * The dotted paths a hit can carry. Object containers are left out — only their
 * declared leaves are stored, so displaying the container would hand back a
 * partial object. Date shadows are left out too, which is what keeps them
 * invisible to callers.
 */
function displayedAttributes(fields: MeilisearchFieldPlan[], primaryKey: string): string[] {
  const displayed = fields
    .filter(({ field }) => {
      return field.type !== 'object' && field.retrievable !== false
    })
    .map(({ path }) => {
      return path
    })

  return displayed.includes(primaryKey) ? displayed : [primaryKey, ...displayed]
}

export function buildIndexPlan(
  definition: SearchTypes.ResolvedSearchIndexDefinition,
  options: MeilisearchProviderOptions,
): MeilisearchIndexPlan {
  const fields: MeilisearchFieldPlan[] = flattenFields(definition.fields).map(({ path, field }) => {
    return {
      path,
      field,
      isDate: field.type === 'date',
    }
  })

  const settings = definition.settings

  // A facet is a filter to Meilisearch — `facets` only works on an attribute that
  // is filterable — so facetable fields are registered alongside filterable ones.
  // A date registers both: the shadow carries comparisons, and the raw value stays
  // available for an equality or existence check written against what is stored.
  const filterable = fields
    .filter(({ field }) => {
      return field.filterable === true || field.facetable === true || typeof field.facetable === 'object'
    })
    .flatMap(({ path, isDate }) => {
      return isDate ? [path, shadowPath(path)] : [path]
    })

  const sortable = fields
    .filter(({ field }) => {
      return field.sortable
    })
    .flatMap(({ path, isDate }) => {
      return isDate ? [path, shadowPath(path)] : [path]
    })

  const derived: Settings = {
    searchableAttributes: searchableAttributes(fields),
    filterableAttributes: filterable,
    sortableAttributes: sortable,
    displayedAttributes: displayedAttributes(fields, definition.primary_key),
    synonyms: settings.synonyms,
    stopWords: settings.stop_words,
    typoTolerance: typoTolerance(settings),
    faceting: settings.faceting && {
      maxValuesPerFacet: settings.faceting.max_values_per_facet,
      sortFacetValuesBy: settings.faceting.sort_by ? { '*': settings.faceting.sort_by } : undefined,
    },
    pagination: pagination(settings, options),
    distinctAttribute: settings.distinct_attribute,
    localizedAttributes: settings.locales?.length
      ? [{ attributePatterns: ['*'], locales: settings.locales as Locale[] }]
      : undefined,
    embedders: embedders(fields, options),
  }

  return {
    name: definition.name,
    physicalName: definition.physical_name,
    primaryKey: definition.primary_key,
    fields: new Map(
      fields.map((plan) => {
        return [plan.path, plan]
      }),
    ),
    // Order matters: the definition wins over the provider-wide default, and a
    // per-index escape hatch wins over both. The derived settings are pruned
    // before they are merged rather than after, because a setting the definition
    // never declared arrives here as `undefined` — and an undefined that outranks
    // the provider-wide option would delete it instead of deferring to it.
    settings: prune({ ...options.settings, ...prune({ ...derived }), ...indexOptions(settings) }),
  }
}

/**
 * Drops keys that were never configured. Meilisearch reads an explicit `null` as
 * "reset to default", which is not the same as leaving a setting alone.
 */
function prune(settings: Record<string, unknown>): Settings {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => {
      return value !== undefined
    }),
  )
}
