import { defineWidgetConfig } from '@medusajs/admin-sdk'
import type { AdminProduct, DetailWidgetProps } from '@medusajs/framework/types'
import { ArrowPath } from '@medusajs/icons'
import { Button, CodeBlock, Container, Heading, Skeleton, StatusBadge, Text, toast } from '@medusajs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { AdminIndexCoverageEntry, AdminIndexedDocumentResponse } from '../../api/admin/meilisearch/types'
import { coverageKey, INDEXES_KEY, useIndexCoverage } from '../lib/api'
import { sdk } from '../lib/sdk'

/**
 * What Meilisearch holds for this product, read from the engine rather than from
 * the database. A product page shows what the catalogue says; this shows what a
 * storefront search would actually find, which is the only way to see that a
 * document is missing, behind, or carrying a field the definition dropped.
 *
 * Every index holding products is listed at once rather than one at a time: a
 * catalogue indexed per language stores this product once per language, so
 * "is it indexed?" only has an answer per index.
 */
const ProductSearchIndexWidget = ({ data }: DetailWidgetProps<AdminProduct>) => {
  const queryClient = useQueryClient()
  const coverage = useIndexCoverage(data.id)
  // Undefined until the merchant picks a row, so that the first index reported —
  // the default-language one — is the one whose document is shown first.
  const [picked, setPicked] = useState<string>()
  const entries = coverage.data?.entries ?? []
  const selected = picked ?? entries.at(0)?.index
  const documentKey = ['meilisearch', 'product', data.id, selected]

  const document = useQuery({
    queryKey: documentKey,
    enabled: selected !== undefined,
    queryFn: async () => {
      return sdk.client.fetch<AdminIndexedDocumentResponse>(`/admin/meilisearch/products/${data.id}`, {
        query: { index: selected },
      })
    },
  })

  const reindex = useMutation({
    mutationFn: async () => {
      return sdk.client.fetch<AdminIndexedDocumentResponse>(`/admin/meilisearch/products/${data.id}`, {
        method: 'POST',
        query: selected === undefined ? undefined : { index: selected },
      })
    },
    onSuccess: (result) => {
      // The route waits for the write and answers with the document as it now
      // stands, so there is nothing left to refetch for this index. The others
      // were reconciled by the same event and have to be read again.
      queryClient.setQueryData(documentKey, result)
      void queryClient.invalidateQueries({ queryKey: coverageKey(data.id) })
      void queryClient.invalidateQueries({ queryKey: INDEXES_KEY })

      toast.success(
        result.indexed
          ? `Reindexed "${data.title}" in "${result.index}"`
          : `Removed "${data.title}" from "${result.index}"`,
      )
    },
    onError: (error: Error) => {
      toast.error('Reindex failed', { description: error.message })
    },
  })

  const error = coverage.error ?? document.error
  const missingEverywhere =
    entries.length > 0 &&
    entries.every((entry) => {
      return !entry.indexed
    })

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between gap-x-2 px-6 py-4">
        <Heading level="h2">Search index</Heading>
        <Button
          size="small"
          variant="secondary"
          isLoading={reindex.isPending}
          disabled={selected === undefined}
          onClick={() => {
            reindex.mutate()
          }}
        >
          <ArrowPath />
          Reindex
        </Button>
      </div>

      {error ? (
        <div className="px-6 py-4">
          <Text size="small" leading="compact" className="text-ui-fg-error">
            {error.message}
          </Text>
        </div>
      ) : (
        <>
          {coverage.isPending ? (
            <div className="px-6 py-4">
              <Skeleton className="h-5 w-48" />
            </div>
          ) : (
            entries.map((entry) => {
              return (
                <IndexRow
                  key={entry.index}
                  entry={entry}
                  selected={entry.index === selected}
                  updatedAt={data.updated_at}
                  onSelect={() => {
                    setPicked(entry.index)
                  }}
                />
              )
            })
          )}

          {!coverage.isPending && entries.length === 0 && (
            <div className="px-6 py-4">
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                No index holds products. Declare one under `src/search` in your Medusa application.
              </Text>
            </div>
          )}

          {missingEverywhere && data.status !== 'published' && (
            <div className="px-6 py-4">
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                This product is {data.status}, and the shipped indexes only hold published products.
              </Text>
            </div>
          )}

          {document.data?.document && (
            <div className="px-6 py-4">
              <CodeBlock
                snippets={[
                  {
                    label: `Indexed document · ${document.data.index}`,
                    language: 'json',
                    code: JSON.stringify(document.data.document, null, 2),
                  },
                ]}
              >
                <CodeBlock.Header />
                <CodeBlock.Body />
              </CodeBlock>
            </div>
          )}
        </>
      )}
    </Container>
  )
}

/**
 * One index' answer for this product. The whole row selects it, because the
 * document below is the reason to look at a row at all.
 */
const IndexRow = ({
  entry,
  selected,
  updatedAt,
  onSelect,
}: {
  entry: AdminIndexCoverageEntry
  selected: boolean
  updatedAt: unknown
  onSelect: () => void
}) => {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`hover:bg-ui-bg-base-hover grid w-full grid-cols-2 items-center px-6 py-3 text-left ${
        selected ? 'bg-ui-bg-base-pressed' : ''
      }`}
    >
      <Text size="small" weight={selected ? 'plus' : 'regular'} leading="compact" className="text-ui-fg-base">
        {entry.index}
        {entry.locale === null ? '' : ` · ${entry.locale}`}
      </Text>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {entry.error === null ? (
          <>
            <StatusBadge color={entry.indexed ? 'green' : 'red'}>
              {entry.indexed ? 'Indexed' : 'Not indexed'}
            </StatusBadge>
            {entry.indexed && isStale(entry.updated_at, updatedAt) && <StatusBadge color="orange">Behind</StatusBadge>}
          </>
        ) : (
          <Text size="small" leading="compact" className="text-ui-fg-error">
            {entry.error}
          </Text>
        )}
      </div>
    </button>
  )
}

/**
 * Whether the indexed copy predates the product's last change. A signal rather
 * than a verdict — a variant edit changes what belongs in the document without
 * moving the product's own `updated_at` — but a document stamped before the
 * product's last change is behind for a reason.
 */
function isStale(indexed: string | null, updatedAt: unknown): boolean {
  if (indexed === null || (typeof updatedAt !== 'string' && !(updatedAt instanceof Date))) {
    return false
  }

  return new Date(indexed).getTime() < new Date(updatedAt).getTime()
}

export const config = defineWidgetConfig({
  id: 'meilisearch:product-search-index',
  zone: 'product.details',
})

export default ProductSearchIndexWidget
