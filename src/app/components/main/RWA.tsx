import { Landmark, Shield } from 'lucide-react';
import { motion } from 'motion/react';
import { BottomNav } from '../shared/BottomNav';
import { TokenIcon } from '../shared/TokenIcon';
import { useWallet } from '../../../contexts/WalletContext';

// RWA token mints — stablecoins, tokenized assets, etc.
const RWA_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6', // USDY
  'toPbBTsmMFH7svParEsrzkyuCxrnnmme1rKEzNmF8cH',  // PAXG (Wormhole)
]);

export function RWA() {
  const { assets, totalBalance } = useWallet();

  // Filter to RWA tokens the user holds or could hold
  const rwaAssets = assets.filter(a => RWA_MINTS.has(a.mint));
  const rwaTotal = rwaAssets.reduce((sum, a) => sum + a.fiatValueRaw, 0);

  return (
    <div className="min-h-screen bg-black text-white flex flex-col pb-32 pt-12">
      <div className="px-3 sm:px-6 pt-3 sm:pt-6 pb-4">
        <h1 className="text-2xl font-semibold text-white mb-2">Real World Assets</h1>
        <p className="text-white/40 text-sm mb-6">
          Stablecoins and tokenized real-world assets in your wallet
        </p>

        {/* RWA Portfolio Summary */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-gradient-to-br from-emerald-500/10 to-teal-500/10 rounded-3xl p-6 border border-emerald-500/20 mb-6"
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 flex items-center justify-center">
              <Landmark className="w-6 h-6 text-emerald-400" />
            </div>
            <div>
              <div className="text-sm text-white/60">RWA Holdings</div>
              <div className="text-2xl font-semibold text-white">
                ${rwaTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>
          {totalBalance > 0 && (
            <div className="text-sm text-white/40">
              {((rwaTotal / totalBalance) * 100).toFixed(1)}% of portfolio
            </div>
          )}
        </motion.div>

        {/* RWA Token List */}
        {rwaAssets.length > 0 ? (
          <div className="space-y-3">
            {rwaAssets.map((asset, index) => (
              <motion.div
                key={asset.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
                className="bg-white/5 border border-white/10 rounded-2xl p-4 hover:bg-white/10 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <TokenIcon
                    logoURI={asset.logoURI}
                    logo={asset.logo}
                    symbol={asset.symbol}
                    size="w-10 h-10"
                    textSize="text-2xl"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-semibold text-white">{asset.symbol}</span>
                      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-500/10">
                        <Shield className="w-3 h-3 text-emerald-400" />
                        <span className="text-xs text-emerald-400">RWA</span>
                      </span>
                    </div>
                    <span className="text-sm text-white/40">{asset.name}</span>
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-white">{asset.balance}</div>
                    <div className="text-sm text-white/60">{asset.fiatValue}</div>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="text-center py-12"
          >
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-emerald-500/20 to-teal-500/20 flex items-center justify-center mx-auto mb-6">
              <Landmark className="w-10 h-10 text-emerald-400" />
            </div>

            <h2 className="text-xl font-semibold mb-3">No RWA Tokens Yet</h2>
            <p className="text-gray-400 text-sm max-w-xs mx-auto">
              Swap to USDC, USDT, USDY, or PAXG to see them here.
              Real-world assets provide stable, yield-bearing portfolio holdings.
            </p>
          </motion.div>
        )}
      </div>

      <BottomNav />
    </div>
  );
}
