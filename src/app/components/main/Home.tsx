import { useState, useEffect } from 'react';
import { Send, ArrowDownToLine, RefreshCw, Eye, EyeOff, Layers3, ChevronDown, Image as ImageIcon, Star } from 'lucide-react';
import { useNavigate } from 'react-router';
import { motion, AnimatePresence, useMotionValue } from 'motion/react';
import { HardwareStatus } from '../shared/HardwareStatus';
import { BottomNav } from '../shared/BottomNav';
import { ShootingStars } from '../shared/ShootingStars';
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import { ImageWithFallback } from '../figma/ImageWithFallback';
import logoConnected from '../../../imports/Connected.png';
import logoDisconnected from '../../../imports/Not_Connected.png';
import { useWallet } from '../../../contexts/WalletContext';
import { getNFTsForWallet, type NFTAsset } from '../../../services/solana';
import { WalletDrawer } from '../shared/WalletDrawer';
import { TokenIcon } from '../shared/TokenIcon';
import { isOnline, onConnectivityChange } from '../../../services/transaction-cache';

export function Home() {
  const { assets, totalBalance, solBalance, isRefreshing, refreshBalances, publicKey, hardwareConnected, connectedDevice, connectedWalletPubkey, disconnectHardware } = useWallet();
  const [isBalanceVisible, setIsBalanceVisible] = useState(true);
  const [expandedAssetId, setExpandedAssetId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'assets' | 'nfts'>('assets');
  const [activeBalanceCard, setActiveBalanceCard] = useState(0);
  const [nfts, setNfts] = useState<NFTAsset[]>([]);
  const [nftsLoading, setNftsLoading] = useState(false);
  const [walletDrawerOpen, setWalletDrawerOpen] = useState(false);
  const [online, setOnline] = useState(isOnline());
  const carouselX = useMotionValue(0);
  const navigate = useNavigate();

  // Track connectivity changes to toggle fiat vs SOL display
  useEffect(() => {
    return onConnectivityChange((isOn) => setOnline(isOn));
  }, []);

  // Fetch real NFTs when switching to NFT tab or on mount
  useEffect(() => {
    if (activeView === 'nfts' && publicKey && nfts.length === 0 && !nftsLoading) {
      setNftsLoading(true);
      getNFTsForWallet(publicKey)
        .then(setNfts)
        .finally(() => setNftsLoading(false));
    }
  }, [activeView, publicKey]);

  const balanceCards = [
    {
      title: 'Total Portfolio',
      amount: totalBalance,
      change: assets.length > 0 ? `${assets[0]?.change24h >= 0 ? '+' : ''}${assets[0]?.change24h?.toFixed(1) ?? '0'}% (SOL)` : 'Loading...',
      isPositive: (assets[0]?.change24h ?? 0) >= 0,
    },
    {
      title: 'SPL Tokens',
      amount: totalBalance,
      change: `${assets.length} tokens`,
      isPositive: true,
    },
  ];

  const handleRefresh = async () => {
    await refreshBalances();
  };

  // Generate chart data based on actual 24h change
  const generateChartData = (change: number) => {
    const points = 20;
    const data = [];
    const baseValue = 100;
    
    for (let i = 0; i < points; i++) {
      const trend = (change / 100) * (i / points) * baseValue;
      const noise = (Math.random() - 0.5) * 5;
      data.push({ value: baseValue + trend + noise });
    }
    return data;
  };

  return (
    <div className="min-h-screen bg-black pb-32 pt-12 relative">
      {/* Shooting Stars Background */}
      <ShootingStars />
      
      {/* Header */}
      <div className="px-3 sm:px-6 pt-3 sm:pt-6 pb-2 sm:pb-4 relative z-10">
        <div className="flex items-center justify-between mb-3 sm:mb-6">
          <div className="flex items-center gap-3">
            <img 
              src={hardwareConnected && connectedWalletPubkey === publicKey ? logoConnected : logoDisconnected} 
              alt="Coldstar Logo" 
              className="h-8 sm:h-12 w-auto object-contain" 
            />
            <button
              onClick={() => setWalletDrawerOpen(true)}
              className="p-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 active:scale-95 transition-all"
            >
              <Star className="w-4 h-4 sm:w-5 sm:h-5 text-amber-400" />
            </button>
          </div>
          <HardwareStatus 
            connected={hardwareConnected && connectedWalletPubkey === publicKey} 
            deviceName={connectedDevice?.productName || connectedDevice?.deviceName}
            variant="badge" 
            onClick={hardwareConnected ? disconnectHardware : undefined}
          />
        </div>

        {/* Balance Cards Carousel */}
        <div className="relative mb-3 sm:mb-6 -mx-3 sm:-mx-6">
          <div className="overflow-hidden">
            <motion.div 
              className="flex cursor-grab active:cursor-grabbing"
              style={{ x: carouselX }}
              drag="x"
              dragConstraints={{ 
                left: -(balanceCards.length - 1) * (typeof window !== 'undefined' ? window.innerWidth - 20 + 10 : 0),
                right: 0 
              }}
              dragElastic={0.1}
              dragMomentum={false}
              onDragEnd={(_, info) => {
                const cardWidth = typeof window !== 'undefined' ? window.innerWidth - 20 + 10 : 0;
                const offset = info.offset.x;
                const velocity = info.velocity.x;

                let newIndex = activeBalanceCard;

                // Determine new index based on drag
                if (Math.abs(offset) > cardWidth * 0.25 || Math.abs(velocity) > 500) {
                  if (offset < 0 && activeBalanceCard < balanceCards.length - 1) {
                    newIndex = activeBalanceCard + 1;
                  } else if (offset > 0 && activeBalanceCard > 0) {
                    newIndex = activeBalanceCard - 1;
                  }
                }

                // Snap to the target card
                setActiveBalanceCard(newIndex);
                carouselX.set(-newIndex * cardWidth);
              }}
              animate={{ x: -activeBalanceCard * (typeof window !== 'undefined' ? window.innerWidth - 20 + 10 : 0) }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            >
              {balanceCards.map((card) => (
                <div
                  key={card.title}
                  className="flex-shrink-0 px-2.5"
                  style={{ width: 'calc(100vw - 20px + 10px)' }}
                >
                  <div className="bg-gradient-to-br from-white/10 to-white/5 rounded-2xl sm:rounded-3xl p-3.5 sm:p-6 border border-white/10 pointer-events-none">
                    <div className="flex items-center justify-between mb-1 sm:mb-2">
                      <span className="text-[11px] sm:text-sm text-white/60">{card.title}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsBalanceVisible(!isBalanceVisible);
                        }}
                        className="p-1 sm:p-2 hover:bg-white/5 rounded-lg transition-colors active:scale-95 pointer-events-auto"
                      >
                        {isBalanceVisible ? (
                          <Eye className="w-3 h-3 sm:w-4 sm:h-4 text-white/60" />
                        ) : (
                          <EyeOff className="w-3 h-3 sm:w-4 sm:h-4 text-white/60" />
                        )}
                      </button>
                    </div>
                    <div className="text-[26px] sm:text-4xl font-semibold text-white mb-0.5 sm:mb-1">
                      {isBalanceVisible
                        ? online
                          ? `$${card.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                          : `${solBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} SOL`
                        : '••••••'}
                    </div>
                    <div className={`flex items-center gap-1 ${card.isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                      <span className="text-[11px] sm:text-sm">{card.change}</span>
                      <span className="text-[9px] sm:text-xs text-white/40">24h</span>
                    </div>
                  </div>
                </div>
              ))}
            </motion.div>
          </div>
          
          {/* Pagination Dots */}
          <div className="flex items-center justify-center gap-1.5 mt-2.5 sm:mt-4">
            {balanceCards.map((_, index) => (
              <button
                key={index}
                onClick={() => {
                  setActiveBalanceCard(index);
                  const cardWidth = typeof window !== 'undefined' ? window.innerWidth - 20 + 10 : 0;
                  carouselX.set(-index * cardWidth);
                }}
                className={`h-1.5 rounded-full transition-all ${
                  activeBalanceCard === index 
                    ? 'w-6 bg-white' 
                    : 'w-1.5 bg-white/30'
                }`}
              />
            ))}
          </div>
        </div>

        {/* Quick Actions */}
        <div className="grid grid-cols-4 gap-1.5 sm:gap-3 mb-3 sm:mb-6">
          <button
            onClick={() => navigate('/app/send')}
            className="bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl sm:rounded-2xl p-2.5 sm:p-4 flex flex-col items-center gap-1 sm:gap-2 active:scale-95 transition-all"
          >
            <div className="w-7 h-7 sm:w-10 sm:h-10 rounded-xl bg-white/10 flex items-center justify-center">
              <Send className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-white" />
            </div>
            <span className="text-[10px] sm:text-sm font-medium text-white">Send</span>
          </button>

          <button
            onClick={() => navigate('/app/receive')}
            className="bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl sm:rounded-2xl p-2.5 sm:p-4 flex flex-col items-center gap-1 sm:gap-2 active:scale-95 transition-all"
          >
            <div className="w-7 h-7 sm:w-10 sm:h-10 rounded-xl bg-white/10 flex items-center justify-center">
              <ArrowDownToLine className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-white" />
            </div>
            <span className="text-[10px] sm:text-sm font-medium text-white">Receive</span>
          </button>

          <button
            onClick={() => navigate('/app/swap')}
            className="bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl sm:rounded-2xl p-2.5 sm:p-4 flex flex-col items-center gap-1 sm:gap-2 active:scale-95 transition-all"
          >
            <div className="w-7 h-7 sm:w-10 sm:h-10 rounded-xl bg-white/10 flex items-center justify-center">
              <RefreshCw className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-white" />
            </div>
            <span className="text-[10px] sm:text-sm font-medium text-white">Swap</span>
          </button>

          <button
            onClick={() => navigate('/app/bulk-send')}
            className="bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl sm:rounded-2xl p-2.5 sm:p-4 flex flex-col items-center gap-1 sm:gap-2 active:scale-95 transition-all"
          >
            <div className="w-7 h-7 sm:w-10 sm:h-10 rounded-xl bg-white/10 flex items-center justify-center">
              <Layers3 className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-white" />
            </div>
            <span className="text-[10px] sm:text-sm font-medium text-white">Bundle</span>
          </button>
        </div>
      </div>

      {/* Assets List */}
      <div className="px-3 sm:px-6 relative z-10">
        {/* Toggle Tabs */}
        <div className="flex items-center gap-2 mb-2.5 sm:mb-4 bg-white/5 rounded-2xl p-0.5 sm:p-1 border border-white/10">
          <button
            onClick={() => setActiveView('assets')}
            className="flex-1 relative py-1.5 sm:py-2.5 rounded-xl font-medium text-[11px] sm:text-sm transition-all active:scale-95"
          >
            {activeView === 'assets' && (
              <motion.div
                layoutId="activeViewTab"
                className="absolute inset-0 bg-white rounded-xl"
                transition={{ type: 'spring', duration: 0.5, bounce: 0.2 }}
              />
            )}
            <span className={`relative z-10 ${activeView === 'assets' ? 'text-black' : 'text-white/60'}`}>
              Assets ({assets.length})
            </span>
          </button>
          <button
            onClick={() => setActiveView('nfts')}
            className="flex-1 relative py-1.5 sm:py-2.5 rounded-xl font-medium text-[11px] sm:text-sm transition-all active:scale-95"
          >
            {activeView === 'nfts' && (
              <motion.div
                layoutId="activeViewTab"
                className="absolute inset-0 bg-white rounded-xl"
                transition={{ type: 'spring', duration: 0.5, bounce: 0.2 }}
              />
            )}
            <span className={`relative z-10 ${activeView === 'nfts' ? 'text-black' : 'text-white/60'}`}>
              NFTs ({nfts.length})
            </span>
          </button>
        </div>

        {/* Refresh Button - Only show for Assets */}
        {activeView === 'assets' && (
          <div className="flex justify-end mb-4">
            <button
              onClick={handleRefresh}
              className="p-2 hover:bg-white/5 rounded-lg transition-colors active:scale-95"
            >
              <RefreshCw
                className={`w-4 h-4 text-white/60 ${isRefreshing ? 'animate-spin' : ''}`}
              />
            </button>
          </div>
        )}

        {/* Content - Assets or NFTs */}
        <AnimatePresence mode="wait">
          {activeView === 'assets' ? (
            <motion.div
              key="assets"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.2 }}
              className="space-y-2"
            >
              {assets.length === 0 && !isRefreshing && (
                <div className="text-center py-12">
                  <p className="text-white/40 text-sm">No assets found</p>
                  <p className="text-white/30 text-xs mt-1">Your balances will appear here</p>
                </div>
              )}
              {assets.length === 0 && isRefreshing && (
                <div className="text-center py-12">
                  <RefreshCw className="w-6 h-6 text-white/30 mx-auto animate-spin mb-2" />
                  <p className="text-white/40 text-sm">Loading balances...</p>
                </div>
              )}
              {assets.map((asset, index) => {
                const isExpanded = expandedAssetId === asset.id;
                const chartData = generateChartData(asset.change24h);
                
                return (
                  <motion.div
                    key={asset.id}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.05 }}
                    className={`bg-white/5 rounded-2xl overflow-hidden border-l-2 ${
                      asset.id === 'sol' ? 'border-l-emerald-500/60 border border-l-2 border-white/10'
                        : asset.safetyScore === 'safe' ? 'border-l-emerald-500/60 border border-l-2 border-white/10'
                        : asset.safetyScore === 'caution' ? 'border-l-yellow-500/60 border border-l-2 border-white/10'
                        : 'border-l-red-500/60 border border-l-2 border-white/10'
                    }`}
                  >
                    {/* Asset Header */}
                    <button
                      onClick={() => setExpandedAssetId(isExpanded ? null : asset.id)}
                      className="w-full hover:bg-white/5 p-2.5 sm:p-4 flex items-center gap-2.5 sm:gap-4 active:scale-98 transition-all"
                    >
                      <TokenIcon
                        logoURI={asset.logoURI}
                        logo={asset.logo}
                        symbol={asset.symbol}
                        size="w-9 h-9 sm:w-12 sm:h-12"
                        textSize="text-lg sm:text-2xl"
                      />
                      
                      <div className="flex-1 text-left min-w-0">
                        <div className="flex items-center gap-1 sm:gap-2 mb-0.5">
                          <span className="text-xs sm:text-base font-semibold text-white">{asset.symbol}</span>
                          <span className="text-[9px] sm:text-xs text-white/40 truncate">{asset.name}</span>
                        </div>
                        <div className="flex items-center gap-1.5 sm:gap-2">
                          <span className="text-[10px] sm:text-sm text-white/60">{asset.balance}</span>
                          <span
                            className={`text-[9px] sm:text-xs font-medium ${ 
                              asset.change24h >= 0 ? 'text-emerald-400' : 'text-red-400'
                            }`}
                          >
                            {asset.change24h >= 0 ? '+' : ''}
                            {asset.change24h.toFixed(2)}%
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
                        <div className="text-xs sm:text-base font-semibold text-white text-right">{asset.fiatValue}</div>
                        <motion.div
                          animate={{ rotate: isExpanded ? 180 : 0 }}
                          transition={{ duration: 0.2 }}
                        >
                          <ChevronDown className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-white/40" />
                        </motion.div>
                      </div>
                    </button>

                    {/* Expandable Content */}
                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.3 }}
                          className="overflow-hidden"
                        >
                          <div className="px-4 pb-4 pt-2 border-t border-white/10">
                            {/* Safety Score Badge + Rugged Warning */}
                            <div className="mb-4">
                              {asset.rugged && (
                                <div className="mb-2 flex items-center gap-2 px-3 py-2 rounded-xl bg-red-500/20 border border-red-500/30">
                                  <span className="text-red-400 text-sm font-semibold">⚠ Rugged</span>
                                  <span className="text-red-400/70 text-xs">This token has been flagged as rugged</span>
                                </div>
                              )}
                              <div className="flex items-center gap-2 flex-wrap">
                                <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${
                                  asset.safetyScore === 'safe' 
                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                    : asset.safetyScore === 'caution'
                                    ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                                    : 'bg-red-500/20 text-red-400 border border-red-500/30'
                                }`}>
                                  <span className={`w-1.5 h-1.5 rounded-full ${
                                    asset.safetyScore === 'safe' 
                                      ? 'bg-emerald-400'
                                      : asset.safetyScore === 'caution'
                                      ? 'bg-yellow-400'
                                      : 'bg-red-400'
                                  }`} />
                                  {asset.safetyScore === 'safe' && 'Safe'}
                                  {asset.safetyScore === 'caution' && 'Caution'}
                                  {asset.safetyScore === 'ruggable' && 'Ruggable'}
                                </div>
                                <span className="text-[10px] text-white/30">Score: {asset.safetyScoreNum}/100</span>
                              </div>
                            </div>

                            {/* Risk Items from RugCheck */}
                            {asset.risks.length > 0 && (
                              <div className="mb-4 bg-white/5 rounded-xl p-3 space-y-2">
                                <span className="text-[11px] font-medium text-white/50 uppercase tracking-wider">Risk Analysis</span>
                                {asset.risks.map((risk, ri) => (
                                  <div key={ri} className="flex items-start gap-2">
                                    <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
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

                            {/* Chart */}
                            <div className="mb-4 bg-white/5 rounded-xl p-4">
                              <div className="flex items-center justify-between mb-3">
                                <span className="text-sm text-white/60">24h Price</span>
                                <span className={`text-sm font-medium ${
                                  asset.change24h >= 0 ? 'text-emerald-400' : 'text-red-400'
                                }`}>
                                  {asset.change24h >= 0 ? '+' : ''}{asset.change24h}%
                                </span>
                              </div>
                              <ResponsiveContainer width="100%" height={120}>
                                <LineChart data={chartData}>
                                  <YAxis hide domain={['dataMin', 'dataMax']} />
                                  <Line
                                    type="monotone"
                                    dataKey="value"
                                    stroke={asset.change24h >= 0 ? '#34d399' : '#ef4444'}
                                    strokeWidth={2}
                                    dot={false}
                                  />
                                </LineChart>
                              </ResponsiveContainer>
                            </div>

                            {/* Action Buttons */}
                            <div className="grid grid-cols-2 gap-3">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigate('/app/send', { state: { selectedAsset: asset.symbol } });
                                }}
                                className="bg-white text-black hover:bg-white/90 rounded-xl p-3 flex items-center justify-center gap-2 font-medium active:scale-95 transition-all"
                              >
                                <Send className="w-4 h-4" />
                                Send
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigate('/app/swap', { state: { fromAsset: asset.symbol } });
                                }}
                                className="bg-white/10 text-white hover:bg-white/20 border border-white/20 rounded-xl p-3 flex items-center justify-center gap-2 font-medium active:scale-95 transition-all"
                              >
                                <RefreshCw className="w-4 h-4" />
                                Swap
                              </button>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })}
            </motion.div>
          ) : (
            <motion.div
              key="nfts"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
              className="grid grid-cols-2 gap-3"
            >
              {nftsLoading && (
                <div className="col-span-2 text-center py-12">
                  <RefreshCw className="w-6 h-6 text-white/30 mx-auto animate-spin mb-2" />
                  <p className="text-white/40 text-sm">Loading NFTs...</p>
                </div>
              )}
              {!nftsLoading && nfts.length === 0 && (
                <div className="col-span-2 text-center py-12">
                  <ImageIcon className="w-8 h-8 text-white/20 mx-auto mb-2" />
                  <p className="text-white/40 text-sm">No NFTs found</p>
                  <p className="text-white/30 text-xs mt-1">Your NFTs will appear here</p>
                </div>
              )}
              {nfts.map((nft, index) => (
                <motion.div
                  key={nft.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden"
                >
                  {/* NFT Image */}
                  <div className="aspect-square bg-white/10 relative overflow-hidden">
                    {nft.image ? (
                      <ImageWithFallback
                        src={nft.image}
                        alt={nft.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <ImageIcon className="w-8 h-8 text-white/20" />
                      </div>
                    )}
                  </div>

                  {/* NFT Info */}
                  <div className="p-3">
                    <div className="text-sm font-semibold text-white mb-1 text-left truncate">
                      {nft.name}
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-white/40 truncate">{nft.collection}</span>
                      {nft.floorPrice && (
                        <span className="text-xs text-white/60 font-medium">{nft.floorPrice}</span>
                      )}
                    </div>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <BottomNav />

      {/* Multi-Wallet Drawer */}
      <WalletDrawer open={walletDrawerOpen} onOpenChange={setWalletDrawerOpen} />
    </div>
  );
}