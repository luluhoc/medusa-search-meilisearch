import { SearchTypes } from '@medusajs/types'
import { DATE_SHADOW_SUFFIX, isPlainObject, toTimestamp } from './values'

/** Meilisearch's own keys on a hit, none of which belong in the document. */
const RESERVED_HIT_KEYS = [
  '_formatted',
  '_matchesPosition',
  '_rankingScore',
  '_rankingScoreDetails',
  '_vectors',
  '_federation',
]

/**
 * Adds the epoch-ms shadow next to every date-shaped value, so filters and sorts
 * have a number to work with. See `DATE_SHADOW_SUFFIX` for why this is additive.
 *
 * Detection is by value rather than by declaration on purpose: a write arrives
 * with an index name and documents and no definition — the index may even have
 * been created by a `db:migrate` in another process — so there is nothing to look
 * a field's type up in.
 */
export function toMeilisearchDocument(document: SearchTypes.SearchDocument): Record<string, unknown> {
  return shadowObject(document)
}

function shadowObject(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, entry] of Object.entries(value)) {
    result[key] = withDateShadows(entry)

    const shadow = shadowValue(entry)

    if (shadow !== undefined) {
      result[`${key}${DATE_SHADOW_SUFFIX}`] = shadow
    }
  }

  return result
}

function withDateShadows(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withDateShadows)
  }

  return isPlainObject(value) ? shadowObject(value) : value
}

/**
 * The shadow of a single value: a timestamp, or an array of them when the field
 * holds many dates. A mixed array gets none — a half-shadowed array would filter
 * as though the non-date entries were absent.
 */
function shadowValue(value: unknown): number | number[] | undefined {
  if (!Array.isArray(value)) {
    return toTimestamp(value)
  }

  const timestamps = value.map(toTimestamp)
  const complete = timestamps.every((entry): entry is number => {
    return entry !== undefined
  })

  return timestamps.length && complete ? timestamps : undefined
}

/**
 * The document as the caller declared it: Meilisearch's per-hit metadata and the
 * date shadows removed. Shadows are already excluded from the index' displayed
 * attributes, so this only matters for an index whose settings a caller manages
 * itself through the escape hatch.
 */
export function fromMeilisearchHit(
  hit: Record<string, unknown>,
  { retrieved, primaryKey }: { retrieved: string[]; primaryKey: string },
): Record<string, unknown> {
  const document: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(hit)) {
    if (RESERVED_HIT_KEYS.includes(key) || key.endsWith(DATE_SHADOW_SUFFIX)) {
      continue
    }

    document[key] = isPlainObject(value) || Array.isArray(value) ? stripShadows(value) : value
  }

  // The primary key is fetched whether or not it was asked for, since it is what
  // identifies the hit. Hand back only what was asked for.
  if (!retrieved.includes(primaryKey)) {
    delete document[primaryKey]
  }

  return document
}

function stripShadows(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripShadows)
  }

  if (!isPlainObject(value)) {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => {
        return !key.endsWith(DATE_SHADOW_SUFFIX)
      })
      .map(([key, entry]) => {
        return [key, stripShadows(entry)]
      }),
  )
}
