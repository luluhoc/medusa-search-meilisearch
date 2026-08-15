import { defineWidgetConfig } from '@medusajs/admin-sdk'
import { ArrowPath } from '@medusajs/icons'
import { Container, Heading, IconButton, Skeleton, StatusBadge, Table, Text } from '@medusajs/ui'
import { useQuery } from '@tanstack/react-query'
import type { AdminSearchIndexInfo } from '../../api/admin/meilisearch/types'
import { useSearchIndexes } from '../lib/api'
import { sdk } from '../lib/sdk'

/**
 * Every declared index, how many documents it holds, and how that compares with
 * the catalogue it was built from. An index that silently stopped being filled
 * looks exactly like a healthy one from a storefront — until a count is put next
 * to it.
 *
 * The comparison is a signal rather than a verdict: an index definition chooses
 * its own filters, so a count that differs from the catalogue's is only wrong if
 * the definition says it should have matched. It is the size of the gap that is
 * worth reading, not its existence.
 */
const SearchIndexHealthWidget = () => {
  const indexes = useSearchIndexes()
  const entries = indexes.data?.indexes ?? []

  const holds = (entity: string): boolean => {
    return entries.some((entry) => {
      return entry.entity === entity
    })
  }

  const products = useQuery({
    queryKey: ['meilisearch', 'catalogue', 'product'],
    enabled: holds('product'),
    queryFn: async () => {
      // The filter the shipped product index declares, so that the number next to
      // an index is the one it is supposed to have reached.
      return sdk.admin.product.list({ limit: 1, fields: 'id', status: ['published'] })
    },
  })

  const categories = useQuery({
    queryKey: ['meilisearch', 'catalogue', 'product_category'],
    enabled: holds('product_category'),
    queryFn: async () => {
      // As with products, the filters the shipped category index declares. An
      // unfiltered count would call every inactive and internal category missing
      // from an index that is not supposed to hold them.
      return sdk.admin.productCategory.list({ limit: 1, fields: 'id', is_active: true, is_internal: false })
    },
  })

  const catalogue: Record<string, number | undefined> = {
    product: products.data?.count,
    product_category: categories.data?.count,
  }

  if (!indexes.isPending && entries.length === 0) {
    return null
  }

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between gap-x-2 px-6 py-4">
        <Heading level="h2">Search indexes</Heading>
        <IconButton
          size="small"
          isLoading={indexes.isFetching}
          onClick={() => {
            void indexes.refetch()
          }}
        >
          <ArrowPath />
        </IconButton>
      </div>

      {indexes.error ? (
        <div className="px-6 py-4">
          <Text size="small" leading="compact" className="text-ui-fg-error">
            {indexes.error.message}
          </Text>
        </div>
      ) : indexes.isPending ? (
        <div className="px-6 py-4">
          <Skeleton className="h-5 w-48" />
        </div>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Index</Table.HeaderCell>
              <Table.HeaderCell>Language</Table.HeaderCell>
              <Table.HeaderCell className="text-right">Documents</Table.HeaderCell>
              <Table.HeaderCell className="text-right">Catalogue</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {entries.map((entry) => {
              return (
                <IndexRow
                  key={entry.name}
                  entry={entry}
                  expected={entry.entity === null ? undefined : catalogue[entry.entity]}
                />
              )
            })}
          </Table.Body>
        </Table>
      )}
    </Container>
  )
}

const IndexRow = ({ entry, expected }: { entry: AdminSearchIndexInfo; expected: number | undefined }) => {
  return (
    <Table.Row>
      <Table.Cell>{entry.name}</Table.Cell>
      <Table.Cell className="text-ui-fg-subtle">{entry.locale ?? '—'}</Table.Cell>
      <Table.Cell className="text-ui-fg-subtle text-right">
        {entry.document_count === null ? '—' : entry.document_count.toLocaleString()}
      </Table.Cell>
      <Table.Cell className="text-ui-fg-subtle text-right">{expected?.toLocaleString() ?? '—'}</Table.Cell>
      <Table.Cell>
        {entry.error === null ? (
          <Gap held={entry.document_count} expected={expected} />
        ) : (
          <Text size="small" leading="compact" className="text-ui-fg-error" title={entry.error}>
            {/* Almost always an index that migrations have not created yet, which
                is the one thing this panel exists to catch. */}
            Unavailable
          </Text>
        )}
      </Table.Cell>
    </Table.Row>
  )
}

const Gap = ({ held, expected }: { held: number | null; expected: number | undefined }) => {
  if (held === null || expected === undefined) {
    return null
  }

  const difference = held - expected

  if (difference === 0) {
    return <StatusBadge color="green">In step</StatusBadge>
  }

  return (
    <StatusBadge color="orange">
      {difference > 0 ? '+' : '−'}
      {Math.abs(difference).toLocaleString()}
    </StatusBadge>
  )
}

export const config = defineWidgetConfig({
  id: 'meilisearch:search-index-health',
  zone: 'product.list.after',
})

export default SearchIndexHealthWidget
