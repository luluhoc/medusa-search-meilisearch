import { defineWidgetConfig } from '@medusajs/admin-sdk'
import { Container, Heading, Input, Select, Table, Text } from '@medusajs/ui'
import { useEffect, useState } from 'react'
import type { AdminSearchHit } from '../../api/admin/meilisearch/types'
import { indexesHolding, indexLabel, useAdminSearch, useSearchIndexes } from '../lib/api'

/** How long typing settles before the engine is asked. */
const DEBOUNCE_MS = 250

const LIMIT = 10

/**
 * The engine's own answer for a query, on the page where a merchant already
 * looks for products. The list below it is the database, ordered by whatever the
 * dashboard filters say; this is Meilisearch, ordered by relevance — which is
 * what a storefront shows, and the only place the two can be compared side by
 * side without leaving the dashboard.
 *
 * No prices and no sales channels: those are the storefront's business, and
 * mixing them in would hide whether a ranking problem is the engine's at all.
 */
const ProductListSearchPreviewWidget = () => {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState<string>()

  const indexes = useSearchIndexes()
  const candidates = indexesHolding('product', indexes.data?.indexes)
  const result = useAdminSearch({ index, query, limit: LIMIT, enabled: query.trim() !== '' })

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(draft)
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
    }
  }, [draft])

  // Nothing to preview against, and a product list is no place for a panel that
  // can only report its own emptiness.
  if (!indexes.isPending && candidates.length === 0) {
    return null
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between gap-x-2 px-6 py-4">
        <Heading level="h2">Search preview</Heading>
        <div className="flex items-center gap-x-2">
          {candidates.length > 1 && (
            <Select size="small" value={index ?? candidates[0].name} onValueChange={setIndex}>
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {candidates.map((entry) => {
                  return (
                    <Select.Item key={entry.name} value={entry.name}>
                      {indexLabel(entry)}
                    </Select.Item>
                  )
                })}
              </Select.Content>
            </Select>
          )}
          <Input
            size="small"
            placeholder="Search the index"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
            }}
          />
        </div>
      </div>

      {result.error && (
        <div className="px-6 py-4">
          <Text size="small" leading="compact" className="text-ui-fg-error">
            {result.error.message}
          </Text>
        </div>
      )}

      {query.trim() !== '' && !result.error && (
        <>
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell className="w-12">#</Table.HeaderCell>
                <Table.HeaderCell>Title</Table.HeaderCell>
                <Table.HeaderCell>Handle</Table.HeaderCell>
                <Table.HeaderCell>Status</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Score</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {result.data?.hits.map((hit, position) => {
                return <HitRow key={hit.id} hit={hit} position={position + 1} />
              })}
            </Table.Body>
          </Table>

          <div className="flex items-center justify-between gap-x-2 px-6 py-3">
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {result.data === undefined
                ? 'Searching…'
                : `${result.data.count?.toLocaleString() ?? '—'} matching, showing ${result.data.hits.length}`}
            </Text>
            {result.data?.processing_time_ms !== null && result.data?.processing_time_ms !== undefined && (
              <Text size="small" leading="compact" className="text-ui-fg-muted">
                {result.data.processing_time_ms} ms
              </Text>
            )}
          </div>
        </>
      )}
    </Container>
  )
}

const HitRow = ({ hit, position }: { hit: AdminSearchHit; position: number }) => {
  return (
    <Table.Row>
      <Table.Cell className="text-ui-fg-muted">{position}</Table.Cell>
      <Table.Cell>
        {/* A plain link rather than a router one: a widget is bundled apart from
            the dashboard and does not share its router instance. */}
        <a className="hover:text-ui-fg-base" href={`/app/products/${hit.id}`}>
          {text(hit, 'title') ?? hit.id}
        </a>
      </Table.Cell>
      <Table.Cell className="text-ui-fg-subtle">{text(hit, 'handle') ?? '—'}</Table.Cell>
      <Table.Cell className="text-ui-fg-subtle">{text(hit, 'status') ?? '—'}</Table.Cell>
      <Table.Cell className="text-ui-fg-subtle text-right">
        {hit.score === null ? '—' : hit.score.toFixed(3)}
      </Table.Cell>
    </Table.Row>
  )
}

/**
 * One field of a hit, when the index holds it as text. A document is whatever the
 * definition produces, so nothing here may be assumed to exist.
 */
function text(hit: AdminSearchHit, field: string): string | undefined {
  const value = hit.document[field]

  return typeof value === 'string' ? value : undefined
}

export const config = defineWidgetConfig({
  id: 'meilisearch:product-list-search-preview',
  zone: 'product.list.before',
})

export default ProductListSearchPreviewWidget
