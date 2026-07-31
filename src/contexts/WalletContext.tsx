/**
 * Wallet Context — Global state provider for wallet, balances, and prices
 */
import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { getWalletMeta, hasWallet, getPublicKey, switchWallet, removeWallet, type WalletMeta } from '../services/wallet';
import { getWalletBalance, type WalletBalance, type TokenBalance } from '../services/solana';

import { getTokenPrices, get24hChanges, formatUSD, type TokenPrice } from '../services/prices';
import { getTokenLogos } from '../services/jupiter';
import { classifyTokensFull, type SafetyLevel, type RiskItem } from '../services/rugcheck';
import { detectUSBDevices, ejectUSB, readFileFromUSB, type USBDevice } from '../services/usb-flash';

export interface AssetItem {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  balance: string;
  balanceRaw: number;
  fiatValue: string;
  fiatValueRaw: number;
  change24h: number;
  logo: string;
  logoURI?: string;
  safetyScore: SafetyLevel;
  safetyScoreNum: number;
  risks: RiskItem[];
  rugged?: boolean;
  decimals: number;
  coingeckoId?: string;
  /** Solscan metadata — holders, supply, market cap, volume */
  holders?: number;
  supply?: string;
  solscanMarketCap?: number;
  solscanVolume24h?: number;
  solscanPrice?: number;
}

interface WalletContextType {
  // State
  walletMeta: WalletMeta | null;
  publicKey: string | null;
  isWalletLoaded: boolean;
  solBalance: number;
  assets: AssetItem[];
  totalBalance: number;
  isRefreshing: boolean;
  lastRefresh: number;
  error: string | null;
  hardwareConnected: boolean;
  connectedDevice: USBDevice | null;
  connectedWalletPubkey: string | null;

  // Actions
  refreshBalances: () => Promise<void>;
  refreshWalletMeta: () => void;
  setError: (err: string | null) => void;
  disconnectHardware: () => Promise<void>;
  switchActiveWallet: (publicKey: string) => void;
  removeActiveWallet: (publicKey: string) => void;
}

const WalletContext = createContext<WalletContextType | null>(null);

const BALANCE_CACHE_KEY = 'coldstar_balance_cache';

function balanceCacheKey(pubkey?: string | null): string {
  return pubkey ? `${BALANCE_CACHE_KEY}:${pubkey}` : BALANCE_CACHE_KEY;
}

function loadCachedBalances(pubkey?: string | null): { solBalance: number; assets: AssetItem[]; totalBalance: number } {
  try {
    const raw = localStorage.getItem(balanceCacheKey(pubkey));
    if (raw) {
      const cached = JSON.parse(raw);
      return {
        solBalance: cached.solBalance ?? 0,
        assets: cached.assets ?? [],
        totalBalance: cached.totalBalance ?? 0,
      };
    }
  } catch {}
  return { solBalance: 0, assets: [], totalBalance: 0 };
}

function saveCachedBalances(pubkey: string | null, solBalance: number, assets: AssetItem[], totalBalance: number) {
  try {
    localStorage.setItem(balanceCacheKey(pubkey), JSON.stringify({ solBalance, assets, totalBalance }));
  } catch {}
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const initialPubkey = getPublicKey();
  const cached = loadCachedBalances(initialPubkey);
  const [walletMeta, setWalletMeta] = useState<WalletMeta | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [solBalance, setSolBalance] = useState(cached.solBalance);
  const [assets, setAssets] = useState<AssetItem[]>(cached.assets);
  const [totalBalance, setTotalBalance] = useState(cached.totalBalance);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hardwareConnected, setHardwareConnected] = useState(false);
  const [connectedDevice, setConnectedDevice] = useState<USBDevice | null>(null);
  const [connectedWalletPubkey, setConnectedWalletPubkey] = useState<string | null>(null);
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const usbPollRef = useRef<NodeJS.Timeout | null>(null);
  const usbCooldownUntilRef = useRef<number>(0);
  const lastPricesRef = useRef<Map<string, TokenPrice>>(new Map());

  const isWalletLoaded = hasWallet();

  // Load wallet metadata
  const refreshWalletMeta = useCallback(() => {
    const meta = getWalletMeta();
    setWalletMeta(meta);
    setPublicKey(meta?.publicKey ?? null);
  }, []);

  useEffect(() => {
    refreshWalletMeta();
  }, [refreshWalletMeta]);

  // Refresh balances from blockchain
  const refreshBalances = useCallback(async () => {
    const pk = getPublicKey();
    if (!pk) return;

    setIsRefreshing(true);
    setError(null);

    try {
      // 1. Get on-chain balances (includes Solscan metadata for all tokens)
      const balance: WalletBalance = await getWalletBalance(pk);
      setSolBalance(balance.solBalance);
      const tokenMeta = balance.tokenMeta;

      // 2. Collect all mint addresses for pricing
      const solMint = 'So11111111111111111111111111111111111111112';
      const mintAddresses = [solMint, ...balance.tokens.map(t => t.mint)];

      // 3. Fetch prices from Jupiter (fall back to last known prices on failure)
      let prices = new Map<string, TokenPrice>();
      try {
        prices = await getTokenPrices(mintAddresses);
        if (prices.size > 0) {
          lastPricesRef.current = prices;
        }
      } catch (e) {
        console.warn('Price fetch failed, using last known prices');
      }
      if (prices.size === 0 && lastPricesRef.current.size > 0) {
        prices = lastPricesRef.current;
      }

      // 4. Fetch 24h changes from CoinGecko
      const coingeckoIds: string[] = [];
      const mintToCoingecko = new Map<string, string>();
      
      // SOL
      coingeckoIds.push('solana');
      mintToCoingecko.set(solMint, 'solana');
      
      // Build coingecko mapping from Solscan metadata
      // Solscan doesn't provide coingeckoId directly, so we skip CoinGecko 24h changes
      // for tokens that don't have a known mapping. The price data from Jupiter is primary.

      let changes = new Map<string, number>();
      try {
        changes = await get24hChanges(coingeckoIds);
      } catch (e) {
        console.warn('24h change fetch failed');
      }

      // 5. Fetch token logos from Jupiter
      const allMints = [solMint, ...balance.tokens.map(t => t.mint)];
      let tokenLogos = new Map<string, string>();
      try {
        tokenLogos = await getTokenLogos(allMints);
      } catch (e) {
        console.warn('Token logo fetch failed');
      }

      // 6. Fetch safety scores
      const tokenMints = balance.tokens.map(t => t.mint);
      let safetyReports = new Map<string, import('../services/rugcheck').TokenSafetyReport>();
      try {
        safetyReports = await classifyTokensFull(tokenMints);
      } catch (e) {
        console.warn('Safety score fetch failed');
      }

      // 7. Build SOL asset
      const solPrice = prices.get(solMint)?.price ?? 0;
      const solFiatValue = balance.solBalance * solPrice;
      const solChange = changes.get('solana') ?? 0;

      const solAsset: AssetItem = {
        id: 'sol',
        mint: solMint,
        symbol: 'SOL',
        name: 'Solana',
        balance: balance.solBalance.toLocaleString('en-US', { maximumFractionDigits: 4 }),
        balanceRaw: balance.solBalance,
        fiatValue: formatUSD(solFiatValue),
        fiatValueRaw: solFiatValue,
        change24h: solChange,
        logo: '◎',
        logoURI: tokenLogos.get(solMint),
        safetyScore: 'safe',
        safetyScoreNum: 0,
        risks: [],
        decimals: 9,
        coingeckoId: 'solana',
      };

      // 8. Build token assets
      const tokenAssets: AssetItem[] = balance.tokens.map((token: TokenBalance) => {
        const price = prices.get(token.mint)?.price ?? 0;
        const fiatValue = token.balance * price;
        const change = 0; // 24h change requires CoinGecko ID, not available from Solscan
        const report = safetyReports.get(token.mint);
        const meta = tokenMeta.get(token.mint);

        return {
          id: token.mint,
          mint: token.mint,
          symbol: token.symbol,
          name: token.name,
          balance: token.uiAmount,
          balanceRaw: token.balance,
          fiatValue: formatUSD(fiatValue),
          fiatValueRaw: fiatValue,
          change24h: change,
          logo: token.logo,
          logoURI: tokenLogos.get(token.mint),
          safetyScore: report?.level ?? 'caution',
          safetyScoreNum: report?.score ?? 50,
          risks: report?.risks ?? [],
          rugged: report?.rugged,
          decimals: token.decimals,
          holders: meta?.holder,
          supply: meta?.supply,
          solscanMarketCap: meta?.market_cap,
          solscanVolume24h: meta?.volume_24h,
          solscanPrice: meta?.price,
        };
      });

      const allAssets = [solAsset, ...tokenAssets];
      setAssets(allAssets);

      // 9. Calculate total
      const total = allAssets.reduce((sum, a) => sum + a.fiatValueRaw, 0);
      setTotalBalance(total);
      setLastRefresh(Date.now());

      // 10. Persist to cache so balances survive remounts
      // Only overwrite cache if we got valid fiat data, or the on-chain balance is truly zero
      if (total > 0 || balance.solBalance === 0) {
        saveCachedBalances(pk, balance.solBalance, allAssets, total);
      }
    } catch (err: any) {
      console.error('Balance refresh error:', err);
      setError(err.message || 'Failed to refresh balances');
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  // Auto-refresh every 30 seconds when wallet is loaded
  useEffect(() => {
    if (isWalletLoaded && publicKey) {
      refreshBalances();
      refreshIntervalRef.current = setInterval(refreshBalances, 30_000);
    }
    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
      }
    };
  }, [isWalletLoaded, publicKey, refreshBalances]);

  // Poll for USB hardware connection every 3 seconds
  const checkUSBConnection = useCallback(async () => {
    // Skip polling during cooldown after a manual disconnect
    if (Date.now() < usbCooldownUntilRef.current) return;

    try {
      const devices = await detectUSBDevices();
      if (devices.length > 0) {
        setHardwareConnected(true);
        setConnectedDevice(devices[0]);
        // Read the public key stored on the USB to match it to a wallet
        try {
          const pubkey = await readFileFromUSB(devices[0], 'wallet/pubkey.txt');
          setConnectedWalletPubkey(pubkey?.trim() || null);
        } catch {
          setConnectedWalletPubkey(null);
        }
      } else {
        setHardwareConnected(false);
        setConnectedDevice(null);
        setConnectedWalletPubkey(null);
      }
    } catch {
      setHardwareConnected(false);
      setConnectedDevice(null);
      setConnectedWalletPubkey(null);
    }
  }, []);

  useEffect(() => {
    checkUSBConnection();
    usbPollRef.current = setInterval(checkUSBConnection, 3000);
    return () => {
      if (usbPollRef.current) clearInterval(usbPollRef.current);
    };
  }, [checkUSBConnection]);

  // Disconnect hardware (safely eject USB)
  const disconnectHardware = useCallback(async () => {
    if (connectedDevice) {
      await ejectUSB(connectedDevice);
    }
    setHardwareConnected(false);
    setConnectedDevice(null);
    setConnectedWalletPubkey(null);
    // Pause USB polling for 10 seconds so the device isn't immediately re-detected
    usbCooldownUntilRef.current = Date.now() + 10_000;
  }, [connectedDevice]);

  // Switch to a different wallet environment
  const switchActiveWallet = useCallback((targetPublicKey: string) => {
    if (switchWallet(targetPublicKey)) {
      const newCached = loadCachedBalances(targetPublicKey);
      setSolBalance(newCached.solBalance);
      setAssets(newCached.assets);
      setTotalBalance(newCached.totalBalance);
      refreshWalletMeta();
    }
  }, [refreshWalletMeta]);

  // Remove a wallet entirely
  const removeActiveWallet = useCallback((targetPublicKey: string) => {
    removeWallet(targetPublicKey);
    refreshWalletMeta();
    const newKey = getPublicKey();
    const newCached = loadCachedBalances(newKey);
    setSolBalance(newCached.solBalance);
    setAssets(newCached.assets);
    setTotalBalance(newCached.totalBalance);
  }, [refreshWalletMeta]);

  return (
    <WalletContext.Provider
      value={{
        walletMeta,
        publicKey,
        isWalletLoaded,
        solBalance,
        assets,
        totalBalance,
        isRefreshing,
        lastRefresh,
        error,
        hardwareConnected,
        connectedDevice,
        connectedWalletPubkey,
        refreshBalances,
        refreshWalletMeta,
        setError,
        disconnectHardware,
        switchActiveWallet,
        removeActiveWallet,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
