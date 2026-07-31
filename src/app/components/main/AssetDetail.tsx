import { useState, useEffect } from 'react';
import { ArrowLeft, Send, ArrowDownToLine, RefreshCw, TrendingUp, TrendingDown, Loader2, Shield, ShieldAlert, AlertTriangle } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';

import { useWallet } from '../../../contexts/WalletContext';
import { getPriceHistory, getTokenMarketData, formatCompact, type MarketData } from '../../../services/prices';

const TIMEFRAME_DAYS: Record<string, number> = { '1D': 1, '1W': 7, '1M': 30, '1Y': 365 };

export function AssetDetail() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { assets } = useWallet();
  const [timeframe, setTimeframe] = useState<'1D' | '1W' | '1M' | '1Y'>('1D');
  const [chartData, setChartData] = useState<[number, number][]>([]);
  const [chartLoading, setChartLoading] = useState(true);
  const [marketData, setMarketData] = useState<MarketData | null>(null);

  // Find the asset from wallet context
  const asset = assets.find(a => a.id === id || a.symbol.toLowerCase() === id?.toLowerCase());

  // Fetch price history when timeframe or asset changes
  useEffect(() => {
    if (!asset?.coingeckoId) {
      setChartData([]);
      setChartLoading(false);
      return;
    }
    
    setChartLoading(true);
    getPriceHistory(asset.coingeckoId, TIMEFRAME_DAYS[timeframe])
      .then(data => setChartData(data.map(d => [d.timestamp, d.price] as [number, number])))
      .catch(() => setChartData([]))
      .finally(() => setChartLoading(false));
  }, [asset?.coingeckoId, timeframe]);

  // Fetch market data once
  useEffect(() => {
    if (!asset?.coingeckoId) return;
    getTokenMarketData(asset.coingeckoId)
      .then(data => setMarketData(data))
      .catch(() => {});
  }, [asset?.coingeckoId]);

  if (!asset) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <p className="text-white/60">Asset not found</p>
      </div>
    );
  }

  // Chart rendering
  const prices = chartData.map(d => d[1]);
  const maxPrice = prices.length > 0 ? Math.max(...prices) : 1;
  const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
  const priceRange = maxPrice - minPrice || 1;
  const isPositive = asset.change24h >= 0;
  const lineColor = isPositive ? 'rgba(16, 185, 129, 1)' : 'rgba(239, 68, 68, 1)';
  const gradientStart = isPositive ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)';

  return (
    <div className="min-h-screen bg-black">
      <div className="px-3 sm:px-6 pt-12 sm:pt-14 pb-4 border-b border-white/10">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/app')}
            className="p-2 hover:bg-white/5 rounded-lg transition-colors active:scale-95"
          >
            <ArrowLeft className="w-6 h-6 text-white" />
          </button>
          <h1 className="text-xl font-semibold text-white">{asset.name}</h1>
        </div>
      </div>

      <div className="px-6 py-6">
        {/* Price Section */}
        <div className="mb-8">
          <div className="text-4xl font-semibold text-white mb-2">
            {asset.balanceRaw > 0
              ? `$${(asset.fiatValueRaw / asset.balanceRaw).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`
              : '$0.00'
            }
          </div>
          <div className="flex items-center gap-2">
            {asset.change24h >= 0 ? (
              <TrendingUp className="w-5 h-5 text-emerald-400" />
            ) : (
              <TrendingDown className="w-5 h-5 text-red-400" />
            )}
            <span
              className={`text-lg font-medium ${
                asset.change24h >= 0 ? 'text-emerald-400' : 'text-red-400'
              }`}
            >
              {asset.change24h >= 0 ? '+' : ''}
              {asset.change24h.toFixed(2)}% (24h)
            </span>
          </div>
        </div>

        {/* Chart */}
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            {(['1D', '1W', '1M', '1Y'] as const).map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-all active:scale-95 ${
                  timeframe === tf
                    ? 'bg-white text-black'
                    : 'bg-white/5 text-white/60 hover:bg-white/10'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>

          <div className="h-48 relative">
            {chartLoading ? (
              <div className="h-full flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-white/30 animate-spin" />
              </div>
            ) : prices.length > 0 ? (
              <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="chartGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor={gradientStart} />
                    <stop offset="100%" stopColor="rgba(0, 0, 0, 0)" />
                  </linearGradient>
                </defs>
                
                <path
                  d={`M 0 ${100 - ((prices[0] - minPrice) / priceRange) * 100} ${prices
                    .map((p, i) => `L ${(i / (prices.length - 1)) * 100} ${100 - ((p - minPrice) / priceRange) * 100}`)
                    .join(' ')} L 100 100 L 0 100 Z`}
                  fill="url(#chartGradient)"
                />
                
                <path
                  d={`M 0 ${100 - ((prices[0] - minPrice) / priceRange) * 100} ${prices
                    .map((p, i) => `L ${(i / (prices.length - 1)) * 100} ${100 - ((p - minPrice) / priceRange) * 100}`)
                    .join(' ')}`}
                  fill="none"
                  stroke={lineColor}
                  strokeWidth="0.5"
                />
              </svg>
            ) : (
              <div className="h-full flex items-center justify-center">
                <p className="text-white/30 text-sm">No chart data available</p>
              </div>
            )}
          </div>
        </div>

        {/* Balance Card */}
        <div className="bg-gradient-to-br from-white/10 to-white/5 rounded-3xl p-6 border border-white/10 mb-6">
          <div className="text-sm text-white/60 mb-2">Your Balance</div>
          <div className="text-3xl font-semibold text-white mb-1">
            {asset.balance} {asset.symbol}
          </div>
          <div className="text-lg text-white/60">
            ≈ {asset.fiatValue}
          </div>
        </div>

        {/* Safety & Risk Analysis */}
        {asset.id !== 'sol' && (
          <div className={`bg-white/5 rounded-2xl p-4 mb-6 border ${
            asset.safetyScore === 'safe' ? 'border-emerald-500/30'
              : asset.safetyScore === 'caution' ? 'border-yellow-500/30'
              : 'border-red-500/30'
          }`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                {asset.safetyScore === 'safe' ? (
                  <Shield className="w-4 h-4 text-emerald-400" />
                ) : asset.safetyScore === 'caution' ? (
                  <ShieldAlert className="w-4 h-4 text-yellow-400" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-red-400" />
                )}
                <span className="text-sm font-medium text-white">RugCheck Safety</span>
              </div>
              <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                asset.safetyScore === 'safe'
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : asset.safetyScore === 'caution'
                  ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                  : 'bg-red-500/20 text-red-400 border border-red-500/30'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  asset.safetyScore === 'safe' ? 'bg-emerald-400'
                    : asset.safetyScore === 'caution' ? 'bg-yellow-400'
                    : 'bg-red-400'
                }`} />
                {asset.safetyScore === 'safe' ? 'Safe' : asset.safetyScore === 'caution' ? 'Caution' : 'Ruggable'}
              </div>
            </div>

            {asset.rugged && (
              <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-red-500/20 border border-red-500/30">
                <span className="text-red-400 text-sm font-semibold">⚠ Rugged</span>
                <span className="text-red-400/70 text-xs">This token has been flagged as rugged</span>
              </div>
            )}

            <div className="flex items-center gap-2 mb-3">
              <div className="flex-1 h-2 rounded-full bg-white/10 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    asset.safetyScoreNum <= 10 ? 'bg-emerald-400'
                      : asset.safetyScoreNum <= 30 ? 'bg-yellow-400'
                      : 'bg-red-400'
                  }`}
                  style={{ width: `${Math.min(100, asset.safetyScoreNum)}%` }}
                />
              </div>
              <span className="text-xs text-white/40 w-12 text-right">{asset.safetyScoreNum}/100</span>
            </div>

            {asset.risks.length > 0 && (
              <div className="space-y-2">
                {asset.risks.map((risk, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className={`mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      risk.level === 'danger' ? 'bg-red-400'
                        : risk.level === 'warn' ? 'bg-yellow-400'
                        : 'bg-blue-400'
                    }`} />
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-white/80">{risk.name}</div>
                      <div className="text-[10px] text-white/40 leading-tight">{risk.description}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {asset.risks.length === 0 && !asset.rugged && (
              <div className="text-xs text-white/30 text-center py-1">No risks detected</div>
            )}
          </div>
        )}

        {/* Quick Actions (below safety) */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <button
            onClick={() => navigate('/app/send')}
            className="bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl p-4 flex flex-col items-center gap-2 active:scale-95 transition-all"
          >
            <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center">
              <Send className="w-5 h-5 text-white" />
            </div>
            <span className="text-sm font-medium text-white">Send</span>
          </button>

          <button
            onClick={() => navigate('/app/receive')}
            className="bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl p-4 flex flex-col items-center gap-2 active:scale-95 transition-all"
          >
            <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center">
              <ArrowDownToLine className="w-5 h-5 text-white" />
            </div>
            <span className="text-sm font-medium text-white">Receive</span>
          </button>

          <button
            onClick={() => navigate('/app/swap')}
            className="bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl p-4 flex flex-col items-center gap-2 active:scale-95 transition-all"
          >
            <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center">
              <RefreshCw className="w-5 h-5 text-white" />
            </div>
            <span className="text-sm font-medium text-white">Swap</span>
          </button>
        </div>

        {/* Stats */}
        <div className="space-y-3">
          {/* Market data — prefer CoinGecko if available, fall back to Solscan meta */}
          <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-white/60 mb-1">Market Cap</div>
                <div className="text-base font-semibold text-white">
                  {marketData?.marketCap
                    ? formatCompact(marketData.marketCap)
                    : asset.solscanMarketCap
                    ? formatCompact(asset.solscanMarketCap)
                    : '—'}
                </div>
              </div>
              <div>
                <div className="text-xs text-white/60 mb-1">24h Volume</div>
                <div className="text-base font-semibold text-white">
                  {marketData?.totalVolume
                    ? formatCompact(marketData.totalVolume)
                    : asset.solscanVolume24h
                    ? formatCompact(asset.solscanVolume24h)
                    : '—'}
                </div>
              </div>
            </div>
          </div>

          {marketData && (marketData.high24h || marketData.low24h) && (
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-xs text-white/60 mb-1">24h High</div>
                  <div className="text-base font-semibold text-white">
                    {marketData.high24h ? `$${marketData.high24h.toLocaleString()}` : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-white/60 mb-1">24h Low</div>
                  <div className="text-base font-semibold text-white">
                    {marketData.low24h ? `$${marketData.low24h.toLocaleString()}` : '—'}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Solscan-specific info: holders & supply */}
          {(asset.holders != null || asset.supply) && (
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
              <div className="grid grid-cols-2 gap-4">
                {asset.holders != null && (
                  <div>
                    <div className="text-xs text-white/60 mb-1">Holders</div>
                    <div className="text-base font-semibold text-white">
                      {asset.holders.toLocaleString()}
                    </div>
                  </div>
                )}
                {asset.supply && (
                  <div>
                    <div className="text-xs text-white/60 mb-1">Total Supply</div>
                    <div className="text-base font-semibold text-white">
                      {formatCompact(Number(asset.supply) / Math.pow(10, asset.decimals))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}