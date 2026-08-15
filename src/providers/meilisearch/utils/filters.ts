import { SearchTypes } from '@medusajs/types'
import { MedusaError } from '@medusajs/utils'
import { MeilisearchIndexPlan } from './definition'
import { isDateLike, isPlainObject, shadowPath, toFilterLiteral, toTimestamp } from './values'

type FilterValue = SearchTypes.SearchFilterValue
type OperatorMap = SearchTypes.SearchOperatorMap<FilterValue>

const OPERATORS = new Set([
  '$eq',
  '$ne',
  '$in',
  '$nin',
  '$lt',
  '$lte',
  '$gt',
  '$gte',
  '$exists',
  '$contains',
  '$overlaps',
  '$prefix',
  '$like',
])

function isId(value: unknown): value is string {
  return typeof value === 'string'
}

function isOperatorMap(value: unknown): value is OperatorMap {
  return (
    isPlainObject(value) &&
    Object.keys(value).some((key) => {
      return OPERATORS.has(key)
    })
  )
}

function fail(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message)
}

/**
 * Which attribute a predicate on `path` is written against. A date is compared on
 * its epoch-ms shadow, because Meilisearch orders numbers and not strings — either
 * because the definition says the field is a date, or, where no definition is at
 * hand (a delete takes filters and an index name and nothing else), because the
 * value itself is date-shaped.
 */
function attributeFor(path: string, values: unknown[], plan?: MeilisearchIndexPlan): string {
  const declaredDate = plan?.fields.get(path)?.isDate
  const looksLikeDate =
    values.length > 0 &&
    values.every((value) => {
      return value === null || isDateLike(value)
    })

  return declaredDate || looksLikeDate ? shadowPath(path) : path
}

function comparison(path: string, symbol: string, value: FilterValue, plan?: MeilisearchIndexPlan): string {
  const timestamp = toTimestamp(value)
  const numeric = timestamp ?? value

  if (typeof numeric !== 'number') {
    fail(
      `Cannot compare "${path}" with ${symbol} against a non-numeric value on a Meilisearch index — only numbers and dates are ordered`,
    )
  }

  return `${attributeFor(path, [value], plan)} ${symbol} ${numeric}`
}

function membership(path: string, values: FilterValue[], negated: boolean, plan?: MeilisearchIndexPlan): string {
  const attribute = attributeFor(path, values, plan)
  const literals = values.map(toFilterLiteral).join(', ')

  return `${negated ? 'NOT ' : ''}${attribute} IN [${literals}]`
}

function equality(path: string, value: FilterValue, negated: boolean, plan?: MeilisearchIndexPlan): string {
  if (value === null) {
    return `${path} IS ${negated ? 'NOT ' : ''}NULL`
  }

  return `${attributeFor(path, [value], plan)} ${negated ? '!=' : '='} ${toFilterLiteral(value)}`
}

/**
 * Every predicate an operator map compiles to. Read key by key rather than by
 * iterating entries, so each operand keeps the type the map declares for it, and
 * an operator this provider does not know about is refused instead of dropped.
 */
function operator(path: string, operators: OperatorMap, plan?: MeilisearchIndexPlan): string[] {
  const unknown = Object.keys(operators).filter((name) => {
    return !OPERATORS.has(name)
  })

  if (unknown.length) {
    fail(`Unsupported filter operator${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} on "${path}"`)
  }

  if (operators.$like !== undefined) {
    fail(
      `Meilisearch has no pattern filter, so $like on "${path}" cannot be answered — use the free-text query, $prefix or $contains instead`,
    )
  }

  const predicates: string[] = []

  if (operators.$eq !== undefined) {
    predicates.push(equality(path, operators.$eq, false, plan))
  }

  if (operators.$ne !== undefined) {
    predicates.push(equality(path, operators.$ne, true, plan))
  }

  if (operators.$in !== undefined) {
    predicates.push(membership(path, operators.$in, false, plan))
  }

  if (operators.$nin !== undefined) {
    predicates.push(membership(path, operators.$nin, true, plan))
  }

  if (operators.$lt !== undefined) {
    predicates.push(comparison(path, '<', operators.$lt, plan))
  }

  if (operators.$lte !== undefined) {
    predicates.push(comparison(path, '<=', operators.$lte, plan))
  }

  if (operators.$gt !== undefined) {
    predicates.push(comparison(path, '>', operators.$gt, plan))
  }

  if (operators.$gte !== undefined) {
    predicates.push(comparison(path, '>=', operators.$gte, plan))
  }

  if (operators.$exists !== undefined) {
    // Written against the stored attribute rather than the shadow: both are
    // registered for a date, and the raw one is what exists for every type.
    predicates.push(`${operators.$exists ? '' : 'NOT '}${path} EXISTS`)
  }

  if (operators.$contains !== undefined) {
    // Meilisearch matches an array by equality on its elements, so membership
    // *is* containment there. On a single value there is nothing to be a member
    // of, and it falls through to the substring operator — which needs
    // Meilisearch's `containsFilter` experimental feature, and says so loudly
    // when it is off.
    const values = Array.isArray(operators.$contains) ? operators.$contains : [operators.$contains]
    const substring = !plan?.fields.get(path)?.field.array

    predicates.push(
      ...values.map((entry) => {
        return typeof entry === 'string' && substring
          ? `${path} CONTAINS ${toFilterLiteral(entry)}`
          : equality(path, entry, false, plan)
      }),
    )
  }

  if (operators.$overlaps !== undefined) {
    predicates.push(membership(path, operators.$overlaps, false, plan))
  }

  if (operators.$prefix !== undefined) {
    // Also behind `containsFilter`.
    predicates.push(`${path} STARTS WITH ${toFilterLiteral(operators.$prefix)}`)
  }

  return predicates
}

function group(predicates: string[], joiner: 'AND' | 'OR'): string | undefined {
  if (!predicates.length) {
    return undefined
  }

  return predicates.length === 1 ? predicates[0] : `(${predicates.join(` ${joiner} `)})`
}

function isFilterTree(value: unknown): value is SearchTypes.SearchFilters {
  return isPlainObject(value)
}

function isFilterTreeList(value: unknown): value is SearchTypes.SearchFilters[] {
  return Array.isArray(value) && value.every(isFilterTree)
}

function isFilterValue(value: unknown): value is FilterValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  )
}

function compile(filters: SearchTypes.SearchFilters, plan?: MeilisearchIndexPlan): string[] {
  const predicates: string[] = []

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) {
      continue
    }

    if ((key === '$and' || key === '$or') && isFilterTreeList(value)) {
      const branches = value
        .map((branch) => {
          return group(compile(branch, plan), 'AND')
        })
        .filter((branch): branch is string => {
          return !!branch
        })
      const joined = group(branches, key === '$and' ? 'AND' : 'OR')

      if (joined) {
        predicates.push(joined)
      }

      continue
    }

    if (key === '$not' && isFilterTree(value)) {
      const negated = group(compile(value, plan), 'AND')

      if (negated) {
        predicates.push(`NOT ${negated}`)
      }

      continue
    }

    if (key.startsWith('$')) {
      // Everything left is read as a field, and no field is named `$…`. Refusing
      // here is what keeps an operator this provider does not implement from
      // compiling into a predicate on a field that does not exist, which would
      // filter on nothing rather than say so.
      fail(`Unsupported filter operator "${key}"`)
    }

    if (isOperatorMap(value)) {
      predicates.push(...operator(key, value, plan))
      continue
    }

    if (Array.isArray(value)) {
      const entries: unknown[] = value

      predicates.push(membership(key, entries.filter(isFilterValue), false, plan))
      continue
    }

    if (isFilterTree(value)) {
      // A nested tree under a field key, which is how `$and` reads once its
      // branches are unwrapped. Compiled as its own conjunction.
      const nested = group(compile(value, plan), 'AND')

      if (nested) {
        predicates.push(nested)
      }

      continue
    }

    predicates.push(equality(key, value, false, plan))
  }

  return predicates
}

/**
 * Compiles the Search Module's filter tree into a Meilisearch filter expression.
 * `undefined` when the tree constrains nothing.
 */
export function buildFilterExpression(
  filters: SearchTypes.SearchFilters | undefined,
  plan?: MeilisearchIndexPlan,
): string | undefined {
  if (!filters) {
    return undefined
  }

  return compile(filters, plan).join(' AND ') || undefined
}

/**
 * Recognises a filter that is nothing but primary-key membership, so a delete can
 * go straight to Meilisearch's delete-by-id route instead of the much slower
 * delete-by-filter, which has to run a search first. `undefined` for anything
 * else, including the primary key alongside another field.
 */
export function extractPrimaryKeyIds(filters: SearchTypes.SearchFilters, primaryKey: string): string[] | undefined {
  const keys = Object.keys(filters)

  if (keys.length !== 1 || keys[0] !== primaryKey) {
    return undefined
  }

  const value = filters[primaryKey]
  let candidates: unknown = value

  if (isOperatorMap(value)) {
    // Only a filter that is *entirely* membership qualifies. `{ $in: [...], $ne: x }`
    // would delete more than it selects if the second operator were dropped here,
    // so anything else falls back to a delete by filter expression, which reads
    // every operator.
    const [name, ...rest] = Object.keys(value)

    if (rest.length || (name !== '$in' && name !== '$eq')) {
      return undefined
    }

    candidates = name === '$in' ? value.$in : value.$eq
  }

  const ids = Array.isArray(candidates) ? candidates : [candidates]

  return ids.every(isId) && ids.length ? ids : undefined
}
