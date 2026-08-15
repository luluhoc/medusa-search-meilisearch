/**
 * Meilisearch compares and sorts numbers, never strings — `created_at > "2024-01-01"`
 * is a type error to it, and an ISO string only happens to sort chronologically
 * while every document agrees on a timezone.
 *
 * So every date-shaped value is indexed twice: verbatim under its own key, and as
 * epoch milliseconds under a sibling carrying this suffix. Filters and sorts are
 * rewritten onto the shadow; reads never see it, because it is left out of the
 * index' displayed attributes.
 *
 * The shadow is additive on purpose. Converting in place would be less to carry
 * around, but a `keyword` field that happens to hold an ISO string would come back
 * as a number, and a caller cannot tell that apart from data that was always a
 * number.
 */
export const DATE_SHADOW_SUFFIX = '__ts'

/**
 * Deliberately strict: a date-shaped *string* is only recognised as a date when it
 * carries a time, so an id or a sku that looks like `2024-01-01` is left alone.
 * A `Date` needs no such caution.
 */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
}

/**
 * Epoch milliseconds for a date-shaped value, or `undefined` for anything else.
 */
export function toTimestamp(value: unknown): number | undefined {
  if (value instanceof Date) {
    const time = value.getTime()

    return Number.isNaN(time) ? undefined : time
  }

  if (typeof value !== 'string' || !ISO_DATE_TIME.test(value)) {
    return undefined
  }

  const time = Date.parse(value)

  return Number.isNaN(time) ? undefined : time
}

export function isDateLike(value: unknown): boolean {
  return toTimestamp(value) !== undefined
}

/**
 * The shadow of a dotted path. The suffix lands on the leaf key, because that is
 * where the shadow is written — `variants.created_at` is shadowed by
 * `variants.created_at__ts`, a sibling of `created_at` inside each variant.
 */
export function shadowPath(path: string): string {
  return `${path}${DATE_SHADOW_SUFFIX}`
}

/**
 * Renders a value as a Meilisearch filter literal. Numbers and booleans are bare;
 * everything else is quoted, so a value containing a space, a comma or an operator
 * keyword cannot change the shape of the expression it sits in.
 */
export function toFilterLiteral(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  const asTimestamp = toTimestamp(value)

  if (asTimestamp !== undefined) {
    return String(asTimestamp)
  }

  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
