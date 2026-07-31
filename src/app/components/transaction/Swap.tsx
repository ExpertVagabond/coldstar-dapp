import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ArrowLeft, ArrowDownUp, Settings, AlertTriangle, ChevronDown, Search, X, Shield, ShieldAlert } from 'lucide-react';
import { useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { SwipeButton } from '../shared/SwipeButton';
import { PinVerification } from '../shared/PinVerification';
import { useWallet } from '../../../contexts/WalletContext';
import { getKeypair } from '../../../services/wallet';
import { getTokenSafetyReport, type TokenSafetyReport } from '../../../services/rugcheck';
import {
  getSwapQuote,
  SWAP_TOKENS,
  SOL_MINT,
  searchJupiterTokens,
  type SwapQuote,
  type JupiterToken,
} from '../../../services/jupiter';
import { signAndSubmitSwap, SERVICE_FEE_RATE } from '../../../services/transactions';
import { getTokenPrices } from '../../../services/prices';
import { TokenIcon } from '../shared/TokenIcon';

interface SwapAsset {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logo: string;
  logoURI?: string | null;
  balance: string;
  balanceRaw: number;
  verified?: boolean;
}

type SwapStep = 'input' | 'review' | 'sign' | 'complete';

/** Convert a JupiterToken search result into our SwapAsset shape */
function jupiterTokenToSwapAsset(t: JupiterToken, walletBalance?: { balance: string; balanceRaw: number }): SwapAsset {
  const known = SWAP_TOKENS.find(s => s.mint === t.mint);
  return {
    mint: t.mint,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    logo: known?.logo ?? '🪙',
    logoURI: t.logoURI,
    balance: walletBalance?.balance ?? '0',
    balanceRaw: walletBalance?.balanceRaw ?? 0,
    verified: t.tags?.includes('verified') ?? !!known,
  };
}

export function Swap() {
  const navigate = useNavigate();
  const { assets: walletAssets, publicKey, refreshBalances } = useWallet();
  const [step, setStep] = useState<SwapStep>('input');
  const [fromAmount, setFromAmount] = useState('');
  const [slippage, setSlippage] = useState('0.5');
  const [showSlippageSettings, setShowSlippageSettings] = useState(false);
  const [showFromPicker, setShowFromPicker] = useState(false);
  const [showToPicker, setShowToPicker] = useState(false);
  const [isSigning, setIsSigning] = useState(false);
  const [showPinVerification, setShowPinVerification] = useState(false);
  const [isPinVerified, setIsPinVerified] = useState(false);
  const [verifiedPin, setVerifiedPin] = useState('');
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState('');
  const [txSignature, setTxSignature] = useState('');
  const [txError, setTxError] = useState('');

  // Token search state
  const [tokenSearchQuery, setTokenSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SwapAsset[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // RugCheck safety state for the "To" token
  const [toSafetyReport, setToSafetyReport] = useState<TokenSafetyReport | null>(null);
  const [isScanningTo, setIsScanningTo] = useState(false);

  // Infrastructure fee in SOL (lamports)
  const [feeInSolLamports, setFeeInSolLamports] = useState(0);

  // Build available swap token list, merging wallet balances with known swap tokens
  // Also include wallet-held tokens that aren't in the preset list
  const availableTokens: SwapAsset[] = useMemo(() => {
    const presetTokens: SwapAsset[] = SWAP_TOKENS.map(t => {
      const walletAsset = walletAssets.find(a => a.mint === t.mint);
      return {
        mint: t.mint,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        logo: t.logo,
        logoURI: t.logoURI ?? walletAsset?.logoURI,
        balance: walletAsset?.balance ?? '0',
        balanceRaw: walletAsset?.balanceRaw ?? 0,
        verified: true,
      };
    });

    // Add wallet-held tokens not in the preset list
    const presetMints = new Set(SWAP_TOKENS.map(t => t.mint));
    const extraTokens: SwapAsset[] = walletAssets
      .filter(a => !presetMints.has(a.mint) && a.mint !== SOL_MINT)
      .map(a => ({
        mint: a.mint,
        symbol: a.symbol,
        name: a.name,
        decimals: a.decimals,
        logo: a.logo,
        logoURI: a.logoURI,
        balance: a.balance,
        balanceRaw: a.balanceRaw,
        verified: false,
      }));

    return [...presetTokens, ...extraTokens];
  }, [walletAssets]);

  const [fromAsset, setFromAsset] = useState<SwapAsset>(availableTokens[0]);
  const [toAsset, setToAsset] = useState<SwapAsset>(availableTokens.find(t => t.symbol === 'USDC') ?? availableTokens[1]);

  // Update balances when wallet refreshes
  useEffect(() => {
    if (walletAssets.length > 0) {
      setFromAsset(prev => {
        const updated = availableTokens.find(t => t.mint === prev.mint);
        return updated ?? prev;
      });
      setToAsset(prev => {
        const updated = availableTokens.find(t => t.mint === prev.mint);
        return updated ?? prev;
      });
    }
  }, [walletAssets, availableTokens]);

  // Debounced token search
  useEffect(() => {
    if (!tokenSearchQuery || tokenSearchQuery.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const timer = setTimeout(async () => {
      try {
        const results = await searchJupiterTokens(tokenSearchQuery, 15);
        setSearchResults(
          results.map(t => {
            const walletAsset = walletAssets.find(a => a.mint === t.mint);
            return jupiterTokenToSwapAsset(t, walletAsset ? { balance: walletAsset.balance, balanceRaw: walletAsset.balanceRaw } : undefined);
          }),
        );
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [tokenSearchQuery, walletAssets]);

  // Reset search when picker closes
  useEffect(() => {
    if (!showFromPicker && !showToPicker) {
      setTokenSearchQuery('');
      setSearchResults([]);
    } else {
      // Focus the search input when picker opens
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, [showFromPicker, showToPicker]);

  // Scan to-token via RugCheck whenever it changes
  useEffect(() => {
    let cancelled = false;
    const SAFE_MINTS = new Set([
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      'So11111111111111111111111111111111111111112',     // wSOL
    ]);
    if (SAFE_MINTS.has(toAsset.mint)) {
      setToSafetyReport({ mint: toAsset.mint, score: 0, level: 'safe', risks: [] });
      return;
    }
    setIsScanningTo(true);
    getTokenSafetyReport(toAsset.mint)
      .then(r => { if (!cancelled) setToSafetyReport(r); })
      .catch(() => { if (!cancelled) setToSafetyReport(null); })
      .finally(() => { if (!cancelled) setIsScanningTo(false); });
    return () => { cancelled = true; };
  }, [toAsset.mint]);

  // Fetch quote when amount changes (debounced)
  const fetchQuote = useCallback(async () => {
    if (!fromAmount || parseFloat(fromAmount) <= 0 || !publicKey) {
      setQuote(null);
      return;
    }

    setIsQuoting(true);
    setQuoteError('');
    try {
      const amountInSmallest = Math.round(parseFloat(fromAmount) * Math.pow(10, fromAsset.decimals));
      const q = await getSwapQuote({
        inputMint: fromAsset.mint,
        outputMint: toAsset.mint,
        amount: amountInSmallest,
        slippageBps: Math.round(parseFloat(slippage) * 100),
        userPublicKey: publicKey,
      });
      setQuote(q);
    } catch (err: any) {
      setQuoteError(err.message || 'Failed to get quote');
      setQuote(null);
    } finally {
      setIsQuoting(false);
    }
  }, [fromAmount, fromAsset.mint, toAsset.mint, slippage, publicKey, fromAsset.decimals]);

  useEffect(() => {
    const timer = setTimeout(fetchQuote, 500);
    return () => clearTimeout(timer);
  }, [fetchQuote]);

  const toAmount = quote
    ? (parseInt(quote.outAmount) / Math.pow(10, toAsset.decimals)).toFixed(3)
    : '';

  const rate = quote
    ? ((parseInt(quote.outAmount) / Math.pow(10, toAsset.decimals)) /
       (parseInt(quote.inAmount) / Math.pow(10, fromAsset.decimals))).toFixed(3)
    : '';

  const minimumReceived = quote
    ? (parseInt(quote.otherAmountThreshold) / Math.pow(10, toAsset.decimals)).toFixed(3)
    : '';

  const infrastructureFeeSOL = (feeInSolLamports / 1e9).toFixed(6);

  // Compute infrastructure fee in SOL whenever the quote changes
  useEffect(() => {
    if (!quote || !fromAmount) {
      setFeeInSolLamports(0);
      return;
    }

    if (fromAsset.mint === SOL_MINT) {
      // Input is SOL: fee = 1% of input
      setFeeInSolLamports(Math.round(parseFloat(fromAmount) * 1e9 * SERVICE_FEE_RATE));
      return;
    }

    if (toAsset.mint === SOL_MINT) {
      // Output is SOL: fee = 1% of output
      setFeeInSolLamports(Math.round(parseInt(quote.outAmount) * SERVICE_FEE_RATE));
      return;
    }

    // Neither side is SOL: use price API to compute SOL equivalent
    let cancelled = false;
    (async () => {
      try {
        const prices = await getTokenPrices([fromAsset.mint, SOL_MINT]);
        const fromPrice = prices.get(fromAsset.mint)?.price ?? 0;
        const solPrice = prices.get(SOL_MINT)?.price ?? 0;
        if (!cancelled && fromPrice > 0 && solPrice > 0) {
          const valueInSol = (parseFloat(fromAmount) * fromPrice) / solPrice;
          setFeeInSolLamports(Math.round(valueInSol * 1e9 * SERVICE_FEE_RATE));
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [quote, fromAmount, fromAsset.mint, toAsset.mint]);

  const handleSwapAssets = () => {
    const temp = fromAsset;
    setFromAsset(toAsset);
    setToAsset(temp);
    setFromAmount('');
    setQuote(null);
  };

  const handleReview = () => {
    if (!fromAmount || !quote) return;
    setStep('review');
  };

  const handleSign = () => {
    setStep('sign');
    setShowPinVerification(true);
  };

  const handlePinVerified = (pin: string) => {
    setVerifiedPin(pin);
    setIsPinVerified(true);
    setShowPinVerification(false);
  };

  const handleCompleteSigning = async () => {
    if (!quote) return;
    setIsSigning(true);
    setTxError('');

    try {
      const keypair = await getKeypair(verifiedPin);
      const result = await signAndSubmitSwap(quote.swapTransaction, keypair, quote.requestId, feeInSolLamports);

      if (result.success) {
        setTxSignature(result.signature);
        setStep('complete');
        refreshBalances();
      } else {
        setTxError(result.error || 'Swap failed');
      }
    } catch (err: any) {
      setTxError(err.message || 'Failed to execute swap');
    } finally {
      setIsSigning(false);
    }
  };

  if (step === 'complete') {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6 pt-16">
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', duration: 0.6 }}
          className="w-24 h-24 rounded-3xl bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center shadow-2xl shadow-emerald-500/50 mb-8"
        >
          <span className="text-5xl">✓</span>
        </motion.div>

        <h1 className="text-3xl font-semibold text-white mb-4">Swap Complete!</h1>
        <p className="text-base text-white/60 text-center mb-8">
          Your swap has been successfully executed
        </p>

        <div className="w-full max-w-md bg-white/5 border border-white/10 rounded-2xl p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <TokenIcon logoURI={fromAsset.logoURI ?? undefined} logo={fromAsset.logo} symbol={fromAsset.symbol} size="w-10 h-10" textSize="text-2xl" />
              <div>
                <div className="text-lg font-semibold text-white truncate max-w-[180px]">{fromAmount}</div>
                <div className="text-sm text-white/60">{fromAsset.symbol}</div>
              </div>
            </div>
          </div>

          <div className="flex justify-center my-3">
            <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center">
              <ArrowDownUp className="w-4 h-4 text-white/60" />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <TokenIcon logoURI={toAsset.logoURI ?? undefined} logo={toAsset.logo} symbol={toAsset.symbol} size="w-10 h-10" textSize="text-2xl" />
              <div className="min-w-0">
              <div className="text-lg font-semibold text-white truncate max-w-[180px]">{toAmount}</div>
                <div className="text-sm text-white/60">{toAsset.symbol}</div>
              </div>
            </div>
          </div>
        </div>

        {txSignature && (
          <div className="w-full max-w-md bg-white/5 border border-white/10 rounded-2xl p-4 mb-8">
            <div className="text-sm text-white/60 mb-1">Transaction</div>
            <a
              href={`https://solscan.io/tx/${txSignature}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-mono text-blue-400 break-all underline"
            >
              {txSignature.slice(0, 20)}...{txSignature.slice(-10)}
            </a>
          </div>
        )}

        <button
          onClick={() => navigate('/app')}
          className="w-full max-w-md h-14 rounded-2xl bg-white text-black font-semibold active:scale-95 transition-transform"
        >
          Back to Home
        </button>
      </div>
    );
  }

  if (step === 'sign') {
    return (
      <div className="min-h-screen bg-black flex flex-col p-6">
        <div className="flex-1 flex flex-col items-center justify-center max-w-md mx-auto w-full">
          <motion.div
            animate={
              isSigning
                ? { scale: [1, 1.1, 1], rotate: [0, 5, -5, 0] }
                : {}
            }
            transition={{ duration: 0.5, repeat: isSigning ? Infinity : 0 }}
            className="w-24 h-24 rounded-3xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 border-2 border-blue-500/30 flex items-center justify-center mb-8"
          >
            <ArrowDownUp className="w-12 h-12 text-blue-400" />
          </motion.div>

          <h1 className="text-2xl font-semibold text-white mb-4 text-center">
            {isSigning ? 'Processing Swap...' : isPinVerified ? 'Confirm Swap' : 'Verify Identity'}
          </h1>
          <p className="text-base text-white/60 text-center mb-8">
            {isSigning
              ? 'Signing and submitting your swap'
              : isPinVerified
              ? 'Swipe to authorize this swap transaction'
              : 'Please verify your identity to continue'}
          </p>

          <div className="w-full bg-white/5 border border-white/10 rounded-2xl p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <TokenIcon logoURI={fromAsset.logoURI ?? undefined} logo={fromAsset.logo} symbol={fromAsset.symbol} size="w-10 h-10" textSize="text-2xl" />
                <div>
                  <div className="text-lg font-semibold text-white truncate max-w-[180px]">{fromAmount}</div>
                  <div className="text-sm text-white/60">{fromAsset.symbol}</div>
                </div>
              </div>
            </div>

            <div className="flex justify-center my-3">
              <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center">
                <ArrowDownUp className="w-4 h-4 text-white/60" />
              </div>
            </div>

            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3 min-w-0">
                <TokenIcon logoURI={toAsset.logoURI ?? undefined} logo={toAsset.logo} symbol={toAsset.symbol} size="w-10 h-10" textSize="text-2xl" />
                <div className="min-w-0">
                  <div className="text-lg font-semibold text-white truncate max-w-[180px]">{toAmount}</div>
                  <div className="text-sm text-white/60">{toAsset.symbol}</div>
                </div>
              </div>
            </div>

            <div className="border-t border-white/10 pt-3 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-white/60 shrink-0">Rate</span>
                <span className="text-xs text-white truncate ml-2 text-right">
                  1 {fromAsset.symbol} = {rate} {toAsset.symbol}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/60">Slippage</span>
                <span className="text-white">{slippage}%</span>
              </div>
              {quote && (
                <div className="flex justify-between text-sm">
                  <span className="text-white/60">Price Impact</span>
                  <span className={quote.priceImpactPct > 1 ? 'text-amber-400' : 'text-white'}>
                    {quote.priceImpactPct.toFixed(2)}%
                  </span>
                </div>
              )}
            </div>
          </div>

          {txError && (
            <div className="w-full bg-red-500/10 border border-red-500/30 rounded-2xl p-4 mb-4">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
                <p className="text-sm text-red-400">{txError}</p>
              </div>
            </div>
          )}
        </div>

        <div className="max-w-md mx-auto w-full">
          {!isSigning && isPinVerified && (
            <SwipeButton
              onComplete={handleCompleteSigning}
              text="Swipe to confirm swap"
              variant="sign"
            />
          )}

          {!isPinVerified && (
            <button
              onClick={() => setShowPinVerification(true)}
              className="w-full h-14 rounded-2xl bg-white text-black font-semibold active:scale-95 transition-transform"
            >
              Verify Identity
            </button>
          )}
        </div>

        <PinVerification
          isOpen={showPinVerification}
          onClose={() => {
            setShowPinVerification(false);
            setStep('review');
          }}
          onVerified={handlePinVerified}
          title="Authorize Swap"
          description="Scan your fingerprint to proceed with the swap"
        />
      </div>
    );
  }

  if (step === 'review') {
    return (
      <div className="min-h-screen bg-black flex flex-col">
        <div className="px-3 sm:px-6 pt-3 sm:pt-6 pb-4 border-b border-white/10">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setStep('input')}
              className="p-2 hover:bg-white/5 rounded-lg transition-colors active:scale-95"
            >
              <ArrowLeft className="w-6 h-6 text-white" />
            </button>
            <h1 className="text-xl font-semibold text-white">Review Swap</h1>
          </div>
        </div>

        <div className="flex-1 px-6 py-6">
          <div className="max-w-md mx-auto">
            <div className="bg-white/5 border border-white/10 rounded-2xl p-6 mb-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <TokenIcon logoURI={fromAsset.logoURI ?? undefined} logo={fromAsset.logo} symbol={fromAsset.symbol} size="w-10 h-10" textSize="text-2xl" />
                  <div>
                    <div className="text-lg font-semibold text-white truncate max-w-[180px]">{fromAmount}</div>
                    <div className="text-sm text-white/60">{fromAsset.symbol}</div>
                  </div>
                </div>
              </div>

              <div className="flex justify-center my-4">
                <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center">
                  <ArrowDownUp className="w-5 h-5 text-white/60" />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <TokenIcon logoURI={toAsset.logoURI ?? undefined} logo={toAsset.logo} symbol={toAsset.symbol} size="w-10 h-10" textSize="text-2xl" />
                  <div>
                    <div className="text-lg font-semibold text-white truncate max-w-[180px]">{toAmount}</div>
                    <div className="text-sm text-white/60">{toAsset.symbol}</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-3 mb-6">
              <div className="flex justify-between items-center">
                <span className="text-sm text-white/60">Rate</span>
                <span className="text-xs font-medium text-white truncate ml-2 text-right">
                  1 {fromAsset.symbol} = {rate} {toAsset.symbol}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-white/60 shrink-0">Slippage Tolerance</span>
                <span className="text-sm font-medium text-white">{slippage}%</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-white/60 shrink-0">Minimum Received</span>
                <span className="text-xs font-medium text-white truncate ml-2 text-right">
                  {minimumReceived} {toAsset.symbol}
                </span>
              </div>
              {quote && (
                <div className="flex justify-between items-center">
                  <span className="text-sm text-white/60">Price Impact</span>
                  <span className={`text-sm font-medium ${quote.priceImpactPct > 1 ? 'text-amber-400' : 'text-white'}`}>
                    {quote.priceImpactPct.toFixed(2)}%
                  </span>
                </div>
              )}
              <div className="flex justify-between items-center">
                <span className="text-sm text-white/60 shrink-0">Infrastructure Fee</span>
                <span className="text-xs font-medium text-white truncate ml-2 text-right">
                  {infrastructureFeeSOL} SOL (1%)
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-white/60 shrink-0 font-semibold">You Receive</span>
                <span className="text-xs font-semibold text-white truncate ml-2 text-right">
                  {toAmount} {toAsset.symbol}
                </span>
              </div>

              {/* Route plan */}
              {quote && quote.routePlan.length > 0 && (
                <>
                  <div className="border-t border-white/10 pt-3 mt-1">
                    <span className="text-xs text-white/40 uppercase tracking-wider">Route</span>
                  </div>
                  <div className="flex items-center gap-1 flex-wrap">
                    {quote.routePlan.map((r, i) => (
                      <span key={i} className="flex items-center gap-1">
                        <span className="text-xs bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-white/70">
                          {r.swapInfo.label}
                        </span>
                        {i < quote.routePlan.length - 1 && (
                          <span className="text-white/20 text-xs">→</span>
                        )}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 mb-4">
              <p className="text-sm text-amber-400 text-center">
                The final amount may differ due to price movement and slippage
              </p>
            </div>

            {/* RugCheck safety on review step */}
            {toSafetyReport && toSafetyReport.level === 'safe' && (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-4 mb-4">
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                  <span className="text-sm font-semibold text-emerald-400">
                    {toAsset.symbol} is safe (score {toSafetyReport.score}/100)
                  </span>
                </div>
              </div>
            )}
            {toSafetyReport && toSafetyReport.level !== 'safe' && (
              <div className={`border rounded-2xl p-4 mb-4 ${
                toSafetyReport.level === 'ruggable'
                  ? 'bg-red-500/10 border-red-500/30'
                  : 'bg-amber-500/10 border-amber-500/30'
              }`}>
                <div className="flex items-center gap-2 mb-2">
                  {toSafetyReport.level === 'ruggable' ? (
                    <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
                  ) : (
                    <ShieldAlert className="w-4 h-4 text-amber-400 flex-shrink-0" />
                  )}
                  <span className={`text-sm font-semibold ${
                    toSafetyReport.level === 'ruggable' ? 'text-red-400' : 'text-amber-400'
                  }`}>
                    RugCheck: {toAsset.symbol} scored {toSafetyReport.score}/100
                    {toSafetyReport.rugged ? ' — RUGGED' : ''}
                  </span>
                </div>
                {toSafetyReport.risks.length > 0 && (
                  <ul className="space-y-1 ml-6">
                    {toSafetyReport.risks.slice(0, 4).map((r, i) => (
                      <li key={i} className={`text-xs ${
                        r.level === 'danger' ? 'text-red-400/80' : r.level === 'warn' ? 'text-amber-400/80' : 'text-white/50'
                      }`}>
                        • {r.name}{r.description ? `: ${r.description}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <p className="text-center text-xs text-white/20">Powered by Jupiter Aggregator</p>
          </div>
        </div>

        <div className="px-6 pb-6">
          <button
            onClick={handleSign}
            className="w-full h-14 rounded-2xl bg-white text-black font-bold active:scale-95 transition-transform"
          >
            Continue to Sign
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black flex flex-col">
      <div className="px-3 sm:px-6 pt-12 sm:pt-14 pb-4 border-b border-white/10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate('/app')}
              className="p-2 hover:bg-white/5 rounded-lg transition-colors active:scale-95"
            >
              <ArrowLeft className="w-6 h-6 text-white" />
            </button>
            <h1 className="text-xl font-semibold text-white">Swap</h1>
          </div>
          <button
            onClick={() => setShowSlippageSettings(!showSlippageSettings)}
            className="p-2 hover:bg-white/5 rounded-lg transition-colors active:scale-95"
          >
            <Settings className="w-6 h-6 text-white/60" />
          </button>
        </div>
      </div>

      <div className="flex-1 px-6 py-6">
        <div className="max-w-md mx-auto space-y-4">
          {/* Slippage Settings */}
          <AnimatePresence>
            {showSlippageSettings && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="bg-white/5 border border-white/10 rounded-2xl p-4 overflow-hidden"
              >
                <div className="text-sm text-white/60 mb-3">Slippage Tolerance</div>
                <div className="flex gap-2">
                  {['0.1', '0.5', '1.0', '3.0'].map(val => (
                    <button
                      key={val}
                      onClick={() => setSlippage(val)}
                      className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${
                        slippage === val
                          ? 'bg-white text-black'
                          : 'bg-white/5 text-white/60 hover:bg-white/10'
                      }`}
                    >
                      {val}%
                    </button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* From */}
          <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
            <div className="text-sm text-white/60 mb-3">From</div>
            <div className="flex items-center gap-3 mb-3">
              <button
                onClick={() => setShowFromPicker(true)}
                className="flex items-center gap-2 flex-1 hover:bg-white/5 rounded-lg p-1 -m-1 transition-colors"
              >
                <TokenIcon logoURI={fromAsset.logoURI ?? undefined} logo={fromAsset.logo} symbol={fromAsset.symbol} size="w-7 h-7" textSize="text-xl" />
                <span className="font-semibold text-white">{fromAsset.symbol}</span>
                <ChevronDown className="w-4 h-4 text-white/40" />
              </button>
              <input
                type="text"
                value={fromAmount}
                onChange={(e) => {
                  const val = e.target.value;
                  if (/^\d*\.?\d*$/.test(val)) setFromAmount(val);
                }}
                placeholder="0.00"
                className="w-32 bg-transparent text-right text-2xl font-semibold text-white outline-none placeholder:text-white/20"
              />
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-white/40">Balance: {fromAsset.balance}</span>
              <button
                onClick={() => setFromAmount(fromAsset.balanceRaw.toString())}
                className="text-blue-400 font-medium active:scale-95 transition-transform"
              >
                Max
              </button>
            </div>
          </div>

          {/* Swap Button */}
          <div className="flex justify-center -my-2 relative z-10">
            <button
              onClick={handleSwapAssets}
              className="w-12 h-12 rounded-xl bg-white/10 hover:bg-white/20 border-2 border-black flex items-center justify-center active:scale-95 transition-all"
            >
              <ArrowDownUp className="w-5 h-5 text-white" />
            </button>
          </div>

          {/* To */}
          <div className={`bg-white/5 rounded-2xl p-4 border ${
            !isScanningTo && toSafetyReport
              ? toSafetyReport.level === 'safe' ? 'border-emerald-500/30'
                : toSafetyReport.level === 'caution' ? 'border-yellow-500/30'
                : 'border-red-500/30'
              : 'border-white/10'
          }`}>
            <div className="text-sm text-white/60 mb-3">To</div>
            <div className="flex items-center gap-3 mb-3">
              <button
                onClick={() => setShowToPicker(true)}
                className="flex items-center gap-2 flex-1 hover:bg-white/5 rounded-lg p-1 -m-1 transition-colors"
              >
                <TokenIcon logoURI={toAsset.logoURI ?? undefined} logo={toAsset.logo} symbol={toAsset.symbol} size="w-7 h-7" textSize="text-xl" />
                <span className="font-semibold text-white">{toAsset.symbol}</span>
                <ChevronDown className="w-4 h-4 text-white/40" />
              </button>
              <div className="text-xl font-semibold text-white truncate max-w-[140px] text-right">
                {isQuoting ? (
                  <span className="text-white/30 animate-pulse">...</span>
                ) : (
                  toAmount || '0.00'
                )}
              </div>
            </div>
            <div className="text-sm text-white/40">Balance: {toAsset.balance}</div>
          </div>

          {/* Quote Error */}
          {quoteError && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
                <p className="text-sm text-red-400">{quoteError}</p>
              </div>
            </div>
          )}

          {/* Rate Info */}
          {fromAmount && quote && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-white/5 border border-white/10 rounded-2xl p-4"
            >
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm text-white/60">Rate</span>
                <span className="text-xs font-medium text-white truncate ml-2 text-right">
                  1 {fromAsset.symbol} ≈ {rate} {toAsset.symbol}
                </span>
              </div>
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm text-white/60">Slippage</span>
                <span className="text-sm font-medium text-white">{slippage}%</span>
              </div>
              {quote.priceImpactPct > 0.5 && (
                <div className="flex justify-between items-center">
                  <span className="text-sm text-white/60">Price Impact</span>
                  <span className={`text-sm font-medium ${quote.priceImpactPct > 1 ? 'text-amber-400' : 'text-white'}`}>
                    {quote.priceImpactPct.toFixed(2)}%
                  </span>
                </div>
              )}

              {/* Route summary */}
              {quote.routePlan.length > 0 && (
                <div className="flex justify-between items-center pt-1 border-t border-white/5 mt-1">
                  <span className="text-xs text-white/40">Route</span>
                  <span className="text-xs text-white/40">
                    {quote.routePlan.map(r => r.swapInfo.label).join(' → ')}
                  </span>
                </div>
              )}
            </motion.div>
          )}

          {/* RugCheck safety warning for to-token */}
          {!isScanningTo && toSafetyReport && toSafetyReport.level === 'safe' && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-3"
            >
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                <p className="text-sm font-medium text-emerald-400">
                  {toAsset.symbol} is safe (score {toSafetyReport.score}/100)
                </p>
              </div>
            </motion.div>
          )}
          {!isScanningTo && toSafetyReport && toSafetyReport.level !== 'safe' && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`border rounded-2xl p-3 ${
                toSafetyReport.level === 'ruggable'
                  ? 'bg-red-500/10 border-red-500/30'
                  : 'bg-amber-500/10 border-amber-500/30'
              }`}
            >
              <div className="flex items-start gap-2">
                {toSafetyReport.level === 'ruggable' ? (
                  <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                ) : (
                  <ShieldAlert className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                )}
                <div>
                  <p className={`text-sm font-semibold ${
                    toSafetyReport.level === 'ruggable' ? 'text-red-400' : 'text-amber-400'
                  }`}>
                    {toAsset.symbol} scored {toSafetyReport.score}/100
                    {toSafetyReport.rugged ? ' — RUGGED' : ''}
                  </p>
                  {toSafetyReport.risks.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {toSafetyReport.risks.slice(0, 3).map((r, i) => (
                        <li key={i} className={`text-xs ${
                          r.level === 'danger' ? 'text-red-400/80' : r.level === 'warn' ? 'text-amber-400/80' : 'text-white/50'
                        }`}>
                          • {r.name}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </motion.div>
          )}
          {isScanningTo && (
            <div className="flex items-center gap-2 px-1">
              <div className="w-3 h-3 border-2 border-white/20 border-t-white/50 rounded-full animate-spin" />
              <span className="text-xs text-white/30">Scanning {toAsset.symbol} via RugCheck…</span>
            </div>
          )}

          {/* Powered by Jupiter */}
          <p className="text-center text-xs text-white/20 mt-2">Powered by Jupiter Aggregator</p>
        </div>
      </div>

      <div className="px-6 pb-6">
        <button
          onClick={handleReview}
          disabled={!fromAmount || !quote || isQuoting}
          className="w-full h-14 rounded-2xl bg-white text-black font-semibold active:scale-95 transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isQuoting ? 'Getting Quote...' : 'Review Swap'}
        </button>
      </div>

      {/* Token Picker Modals */}
      <AnimatePresence>
        {(showFromPicker || showToPicker) && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => { setShowFromPicker(false); setShowToPicker(false); }}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40"
            />
            <motion.div
              initial={{ opacity: 0, y: 100 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 100 }}
              className="fixed bottom-0 inset-x-0 bg-zinc-900 border-t border-white/10 rounded-t-3xl z-50 max-h-[80vh] flex flex-col"
            >
              <div className="p-4 border-b border-white/10 flex-shrink-0">
                <h3 className="text-lg font-semibold text-white text-center mb-3">
                  Select {showFromPicker ? 'From' : 'To'} Token
                </h3>
                {/* Search input */}
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={tokenSearchQuery}
                    onChange={(e) => setTokenSearchQuery(e.target.value)}
                    placeholder="Search by name, symbol, or paste mint address..."
                    className="w-full bg-white/5 border border-white/10 rounded-xl py-3 pl-10 pr-10 text-sm text-white placeholder:text-white/30 outline-none focus:border-white/20 transition-colors"
                  />
                  {tokenSearchQuery && (
                    <button
                      onClick={() => setTokenSearchQuery('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 hover:bg-white/10 rounded transition-colors"
                    >
                      <X className="w-4 h-4 text-white/40" />
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-1">
                {/* Show search results if searching, otherwise show default list */}
                {isSearching && (
                  <div className="flex items-center justify-center py-8">
                    <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
                    <span className="ml-3 text-sm text-white/40">Searching tokens...</span>
                  </div>
                )}

                {!isSearching && tokenSearchQuery.length >= 2 && searchResults.length === 0 && (
                  <div className="text-center py-8">
                    <p className="text-sm text-white/40">No tokens found for "{tokenSearchQuery}"</p>
                    <p className="text-xs text-white/20 mt-1">Try a different name, symbol, or paste a mint address</p>
                  </div>
                )}

                {(tokenSearchQuery.length >= 2 ? searchResults : availableTokens)
                  .filter(t => showFromPicker ? t.mint !== toAsset.mint : t.mint !== fromAsset.mint)
                  .map(token => (
                    <button
                      key={token.mint}
                      onClick={() => {
                        if (showFromPicker) {
                          setFromAsset(token);
                          setShowFromPicker(false);
                        } else {
                          setToAsset(token);
                          setShowToPicker(false);
                        }
                        setFromAmount('');
                        setQuote(null);
                      }}
                      className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition-colors"
                    >
                      {/* Token icon */}
                      <TokenIcon logoURI={token.logoURI ?? undefined} logo={token.logo} symbol={token.symbol} size="w-9 h-9" textSize="text-xl" />

                      <div className="flex-1 text-left min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-white truncate">{token.symbol}</span>
                          {token.verified && (
                            <Shield className="w-3 h-3 text-blue-400 flex-shrink-0" />
                          )}
                          {!token.verified && tokenSearchQuery.length >= 2 && (
                            <ShieldAlert className="w-3 h-3 text-amber-400 flex-shrink-0" />
                          )}
                        </div>
                        <div className="text-sm text-white/40 truncate">{token.name}</div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-sm text-white/60">{token.balance}</div>
                        {token.mint.length > 10 && tokenSearchQuery.length >= 2 && (
                          <div className="text-[10px] text-white/20 font-mono">
                            {token.mint.slice(0, 4)}...{token.mint.slice(-4)}
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
              </div>

              {/* Unverified token warning */}
              {tokenSearchQuery.length >= 2 && searchResults.some(t => !t.verified) && (
                <div className="flex-shrink-0 px-4 pb-4">
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-400/80">
                      Unverified tokens may be scams. Always verify the mint address before swapping.
                    </p>
                  </div>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}