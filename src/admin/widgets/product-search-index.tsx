import { defineWidgetConfig } from '@medusajs/admin-sdk'
import type { AdminProduct, DetailWidgetProps } from '@medusajs/framework/types'
import { ArrowPath } from '@medusajs/icons'
import { Button, CodeBlock, Container, Heading, Select, Skeleton, StatusBadge, Text, toast } from '@medusajs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import type { AdminIndexedDocumentResponse, AdminSearchIndexesResponse } from '../../api/admin/meilisearch/types'
import { sdk } from '../lib/sdk'

const INDEXES_KEY = ['meilisearch', 'indexes']

/**
 * What Meilisearch holds for this product, read from the engine rather than from
 * the database. A product page shows what the catalogue says; this shows what a
 * storefront search would actually find, which is the only way to see that a
 * document is missing, behind, or carrying a field the definition dropped.
 */
const ProductSearchIndexWidget = ({ data }: DetailWidgetProps<AdminProduct>) => {
  const queryClient = useQueryClient()
  // Undefined until the merchant picks one, so that the route's own default
  // decides which index is shown first rather than the widget second-guessing it.
  const [selected, setSelected] = useState<string>()
  const documentKey = ['meilisearch', 'product', data.id, selected]

  const indexes = useQuery({
    queryKey: INDEXES_KEY,
    queryFn: async () => {
      return sdk.client.fetch<AdminSearchIndexesResponse>('/admin/meilisearch/indexes')
    },
  })

  const document = useQuery({
    queryKey: documentKey,
    queryFn: async () => {
      return sdk.client.fetch<AdminIndexedDocumentResponse>(`/admin/meilisearch/products/${data.id}`, {
        query: selected === undefined ? undefined : { index: selected },
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
      // stands, so there is nothing left to refetch for this index.
      queryClient.setQueryData(documentKey, result)
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

  const error = indexes.error ?? document.error
  const index = document.data?.index
  const info = indexes.data?.indexes.find((entry) => {
    return entry.name === index
  })
  const indexed = document.data?.indexed === true
  const stale = isStale(document.data?.document, data.updated_at)

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between gap-x-2 px-6 py-4">
        <Heading level="h2">Search index</Heading>
        <div className="flex items-center gap-x-2">
          {index !== undefined && (indexes.data?.indexes.length ?? 0) > 1 && (
            <Select size="small" value={index} onValueChange={setSelected}>
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {indexes.data?.indexes.map((entry) => {
                  return (
                    <Select.Item key={entry.name} value={entry.name}>
                      {entry.name}
                    </Select.Item>
                  )
                })}
              </Select.Content>
            </Select>
          )}
          <Button
            size="small"
            variant="secondary"
            isLoading={reindex.isPending}
            disabled={index === undefined}
            onClick={() => {
              reindex.mutate()
            }}
          >
            <ArrowPath />
            Reindex
          </Button>
        </div>
      </div>

      {error ? (
        <Row label="Status">
          <Text size="small" leading="compact" className="text-ui-fg-error">
            {error.message}
          </Text>
        </Row>
      ) : (
        <>
          <Row label="Status">
            {document.isPending ? (
              <Skeleton className="h-5 w-24" />
            ) : (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <StatusBadge color={indexed ? 'green' : 'red'}>{indexed ? 'Indexed' : 'Not indexed'}</StatusBadge>
                {indexed && stale && <StatusBadge color="orange">Behind</StatusBadge>}
                {!indexed && data.status !== 'published' && (
                  <Text size="small" leading="compact">
                    This product is {data.status}, and the shipped index only holds published products.
                  </Text>
                )}
              </div>
            )}
          </Row>

          <Row label="Index">
            {document.isPending ? (
              <Skeleton className="h-5 w-32" />
            ) : (
              <Text size="small" leading="compact">
                {index}
                {info?.document_count !== null && info?.document_count !== undefined
                  ? ` · ${info.document_count.toLocaleString()} documents`
                  : ''}
              </Text>
            )}
          </Row>

          {info?.error !== null && info?.error !== undefined && (
            <Row label="Index error">
              <Text size="small" leading="compact" className="text-ui-fg-error">
                {info.error}
              </Text>
            </Row>
          )}

          {document.data?.document && (
            <div className="px-6 py-4">
              <CodeBlock
                snippets={[
                  {
                    label: 'Indexed document',
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

const Row = ({ label, children }: { label: string; children: ReactNode }) => {
  return (
    <div className="text-ui-fg-subtle grid grid-cols-2 items-center px-6 py-4">
      <Text size="small" weight="plus" leading="compact">
        {label}
      </Text>
      {children}
    </div>
  )
}

/**
 * Whether the indexed copy predates the product's last change. A signal rather
 * than a verdict — a variant edit changes what belongs in the document without
 * moving the product's own `updated_at` — but a document stamped before the
 * product's last change is behind for a reason.
 */
function isStale(document: Record<string, unknown> | null | undefined, updatedAt: unknown): boolean {
  const indexed = document?.updated_at

  if (typeof indexed !== 'string' || (typeof updatedAt !== 'string' && !(updatedAt instanceof Date))) {
    return false
  }

  return new Date(indexed).getTime() < new Date(updatedAt).getTime()
}

export const config = defineWidgetConfig({
  id: 'meilisearch:product-search-index',
  zone: 'product.details',
})

export default ProductSearchIndexWidget
