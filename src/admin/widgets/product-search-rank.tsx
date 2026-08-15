import { defineWidgetConfig } from '@medusajs/admin-sdk'
import type { AdminProduct, DetailWidgetProps } from '@medusajs/framework/types'
import { MagnifyingGlass } from '@medusajs/icons'
import { Badge, Container, Heading, IconButton, Input, Select, Skeleton, StatusBadge, Text } from '@medusajs/ui'
import { useState } from 'react'
import type { AdminSearchHit, AdminSearchRank } from '../../api/admin/meilisearch/types'
import { indexesHolding, indexLabel, useAdminSearch, useSearchIndexes } from '../lib/api'

/** How many of the winning hits to show next to the rank. */
const TOP_HITS = 5

/**
 * Where this product places for a query a customer would type. The indexed
 * document says what the engine stores; this says what the engine *does* with
 * it, which is the question behind "why doesn't this come up when I search for
 * it?" — and the two have different answers when the document is fine and
 * something else simply outranks it.
 */
const ProductSearchRankWidget = ({ data }: DetailWidgetProps<AdminProduct>) => {
  // Seeded with the product's own title, because a product that does not place
  // for its own name is the case worth seeing without being asked for.
  const [draft, setDraft] = useState(data.title)
  const [query, setQuery] = useState(data.title)
  const [index, setIndex] = useState<string>()

  const indexes = useSearchIndexes()
  const candidates = indexesHolding('product', indexes.data?.indexes)
  const result = useAdminSearch({ index, query, find: data.id, limit: TOP_HITS, enabled: query.trim() !== '' })
  const rank = result.data?.rank ?? null

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between gap-x-2 px-6 py-4">
        <Heading level="h2">Search rank</Heading>
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
      </div>

      <div className="px-6 py-4">
        <form
          className="flex items-center gap-x-2"
          onSubmit={(event) => {
            event.preventDefault()
            setQuery(draft)
          }}
        >
          <Input
            size="small"
            placeholder="Search as a customer would"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
            }}
          />
          <IconButton size="small" type="submit" isLoading={result.isFetching}>
            <MagnifyingGlass />
          </IconButton>
        </form>
      </div>

      {result.error ? (
        <div className="px-6 py-4">
          <Text size="small" leading="compact" className="text-ui-fg-error">
            {result.error.message}
          </Text>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-x-2 px-6 py-4">
            {result.isPending ? (
              <Skeleton className="h-5 w-24" />
            ) : (
              <>
                <RankBadge rank={rank} />
                <Text size="small" leading="compact" className="text-ui-fg-subtle">
                  {result.data.count?.toLocaleString() ?? '—'} matching
                </Text>
              </>
            )}
          </div>

          {rank !== null && rank.position === null && (
            <div className="px-6 py-4">
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {rank.exhausted
                  ? 'This product does not match the query at all. Check that the words you typed are in a searchable field.'
                  : `Something outranks it: it is not in the first ${rank.scanned.toLocaleString()} hits.`}
              </Text>
            </div>
          )}

          {(result.data?.hits.length ?? 0) > 0 && (
            <div className="flex flex-col gap-y-2 px-6 py-4">
              <Text size="xsmall" weight="plus" leading="compact" className="text-ui-fg-muted">
                Top hits
              </Text>
              {result.data?.hits.map((hit, position) => {
                return <HitRow key={hit.id} hit={hit} position={position + 1} isSelf={hit.id === data.id} />
              })}
            </div>
          )}
        </>
      )}
    </Container>
  )
}

/**
 * The rank as a verdict. "Not in the first N" and "does not match" are different
 * failures, so they are never shown under the same colour.
 */
const RankBadge = ({ rank }: { rank: AdminSearchRank | null }) => {
  if (rank === null) {
    return <StatusBadge color="grey">Unranked</StatusBadge>
  }

  if (rank.position === null) {
    // Scanned to the end without finding it: it does not match, which is a
    // different fault from being buried under everything that does.
    return <StatusBadge color={rank.exhausted ? 'red' : 'orange'}>Unranked</StatusBadge>
  }

  return <StatusBadge color={rank.position <= TOP_HITS ? 'green' : 'orange'}>Rank #{rank.position}</StatusBadge>
}

const HitRow = ({ hit, position, isSelf }: { hit: AdminSearchHit; position: number; isSelf: boolean }) => {
  return (
    <div className="flex items-center gap-x-2">
      <Text size="small" leading="compact" className="text-ui-fg-muted w-4 shrink-0">
        {position}
      </Text>
      <Text
        size="small"
        leading="compact"
        weight={isSelf ? 'plus' : 'regular'}
        className="truncate"
        title={hitTitle(hit)}
      >
        {hitTitle(hit)}
      </Text>
      {isSelf && (
        <Badge size="2xsmall" color="green">
          This product
        </Badge>
      )}
    </div>
  )
}

/**
 * What to call a hit. The document is whatever the definition indexes, so the
 * usual title fields are tried before falling back to the id — which is at least
 * always there, being the primary key.
 */
function hitTitle(hit: AdminSearchHit): string {
  const title = hit.document.title ?? hit.document.name

  return typeof title === 'string' ? title : hit.id
}

export const config = defineWidgetConfig({
  id: 'meilisearch:product-search-rank',
  zone: 'product.details.side.after',
})

export default ProductSearchRankWidget
