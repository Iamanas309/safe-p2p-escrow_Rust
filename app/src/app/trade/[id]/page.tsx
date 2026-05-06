import { TradeDetailFeature } from '@/components/trade/trade-detail-feature'

export default async function TradePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <TradeDetailFeature tradeId={id} />
}
