import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { Plus, Copy, Check, Wallet, Usb, Trash2, Shield, ExternalLink } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '../ui/sheet';
import { getWalletRegistry, type WalletRegistryEntry } from '../../../services/wallet';
import { useWallet } from '../../../contexts/WalletContext';

interface WalletDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function truncateKey(key: string): string {
  if (key.length <= 12) return key;
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export function WalletDrawer({ open, onOpenChange }: WalletDrawerProps) {
  const navigate = useNavigate();
  const {
    switchActiveWallet,
    removeActiveWallet,
    publicKey: activeKey,
    connectedDevice,
    connectedWalletPubkey,
  } = useWallet();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [registry, setRegistry] = useState<WalletRegistryEntry[]>(() => getWalletRegistry());

  // Refresh registry when drawer opens or active key changes
  useEffect(() => {
    if (open) {
      setRegistry(getWalletRegistry());
    }
  }, [open, activeKey]);

  const handleCopy = async (publicKey: string) => {
    await navigator.clipboard.writeText(publicKey);
    setCopiedKey(publicKey);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleSwitch = (publicKey: string) => {
    if (publicKey === activeKey) return;
    switchActiveWallet(publicKey);
    setRegistry(getWalletRegistry());
  };

  const handleRemove = (publicKey: string) => {
    if (confirmRemove === publicKey) {
      removeActiveWallet(publicKey);
      setConfirmRemove(null);
      setRegistry(getWalletRegistry());
      // If no wallets left, navigate to setup
      if (registry.length <= 1) {
        onOpenChange(false);
        navigate('/');
      }
    } else {
      setConfirmRemove(publicKey);
      setTimeout(() => setConfirmRemove(null), 3000);
    }
  };

  const handleCreateNew = () => {
    sessionStorage.setItem('coldstar_creating_new_wallet', 'true');
    onOpenChange(false);
    navigate('/');
  };

  const handleBackup = () => {
    onOpenChange(false);
    navigate('/onboarding/backup');
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="bg-black border-white/10 w-[85%] sm:max-w-sm p-0"
      >
        <SheetHeader className="px-5 pt-14 pb-3 border-b border-white/10">
          <SheetTitle className="text-white text-lg font-semibold flex items-center gap-2">
            <Wallet className="w-5 h-5 text-emerald-400" />
            My Wallets
          </SheetTitle>
          <p className="text-xs text-white/50 mt-1">
            Tap a wallet to switch to it
          </p>
        </SheetHeader>

        {/* Wallet List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {registry.length === 0 ? (
            <div className="text-center py-12">
              <Usb className="w-10 h-10 text-white/20 mx-auto mb-3" />
              <p className="text-white/40 text-sm">No wallets yet</p>
              <p className="text-white/30 text-xs mt-1">Connect a USB device to create one</p>
            </div>
          ) : (
            registry.map((entry: WalletRegistryEntry, index: number) => {
              const isActive = entry.publicKey === activeKey;
              const isHWConnected = connectedWalletPubkey === entry.publicKey;
              const deviceName = connectedDevice?.productName || connectedDevice?.deviceName || 'USB Device';
              return (
                <div
                  key={entry.publicKey}
                  onClick={() => handleSwitch(entry.publicKey)}
                  className={`relative rounded-2xl p-4 border-2 transition-all cursor-pointer ${
                    isActive
                      ? 'bg-emerald-500/15 border-emerald-400/50 shadow-[0_0_15px_rgba(16,185,129,0.2)] ring-1 ring-emerald-400/20'
                      : 'bg-white/5 border-white/10 hover:bg-white/10'
                  }`}
                >
                  {/* Active indicator bar */}
                  {isActive && (
                    <div className="absolute left-0 top-3 bottom-3 w-1 rounded-r-full bg-emerald-400" />
                  )}

                  {/* Hardware connection badge */}
                  {isHWConnected ? (
                    <span className="absolute top-3 right-3 px-2 py-0.5 text-[10px] font-medium rounded-full bg-emerald-500/30 text-emerald-300 border border-emerald-400/40 shadow-[0_0_8px_rgba(16,185,129,0.3)] flex items-center gap-1">
                      <Usb className="w-3 h-3" />
                      {deviceName}
                    </span>
                  ) : (
                    <span className="absolute top-3 right-3 px-2 py-0.5 text-[10px] font-medium rounded-full bg-white/10 text-white/40 border border-white/10">
                      Inactive
                    </span>
                  )}

                  {/* Wallet label */}
                  <div className="flex items-center gap-2 mb-2">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                      isActive ? 'bg-emerald-500/20' : 'bg-white/10'
                    }`}>
                      <Usb className={`w-4 h-4 ${isActive ? 'text-emerald-400' : 'text-white/60'}`} />
                    </div>
                    <div>
                      <p className="text-white font-medium text-sm">
                        {entry.label || `Wallet #${index + 1}`}
                      </p>
                      <p className="text-white/40 text-[10px]">
                        {new Date(entry.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>

                  {/* Public key + actions */}
                  <div className="flex items-center gap-2 mt-2">
                    <code className="text-xs text-white/50 font-mono bg-white/5 px-2 py-1 rounded-lg flex-1 overflow-hidden">
                      {truncateKey(entry.publicKey)}
                    </code>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleCopy(entry.publicKey); }}
                      className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 active:scale-95 transition-all"
                    >
                      {copiedKey === entry.publicKey ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5 text-white/50" />
                      )}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRemove(entry.publicKey); }}
                      className={`p-1.5 rounded-lg active:scale-95 transition-all ${
                        confirmRemove === entry.publicKey
                          ? 'bg-red-500/20 hover:bg-red-500/30'
                          : 'bg-white/5 hover:bg-white/10'
                      }`}
                      title={confirmRemove === entry.publicKey ? 'Tap again to confirm' : 'Remove wallet'}
                    >
                      <Trash2 className={`w-3.5 h-3.5 ${
                        confirmRemove === entry.publicKey ? 'text-red-400' : 'text-white/50'
                      }`} />
                    </button>
                  </div>
                  {confirmRemove === entry.publicKey && (
                    <p className="text-red-400 text-[10px] mt-1.5">Tap trash again to remove</p>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Create / Backup Buttons */}
        <div className="p-4 border-t border-white/10 flex flex-row gap-2">
          <button
            onClick={handleCreateNew}
            className="flex-1 h-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center gap-2 text-white font-medium text-sm hover:bg-white/10 active:scale-[0.98] transition-all"
          >
            <Plus className="w-4 h-4 text-emerald-400" />
            New Wallet
          </button>
          {registry.length > 0 && (
            <button
              onClick={handleBackup}
              className="flex-1 h-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center gap-2 text-white font-medium text-sm hover:bg-white/10 active:scale-[0.98] transition-all"
            >
              <Shield className="w-4 h-4 text-amber-400" />
              Backup Keys
            </button>
          )}
        </div>

        {/* Legal */}
        <div className="px-4 py-3 border-t border-white/10 flex items-center justify-center gap-4">
          <button
            onClick={() => window.open('https://coldstar.dev/seeker-privacy', '_blank', 'noopener,noreferrer')}
            className="text-xs text-white/50 hover:text-white transition-colors flex items-center gap-1"
          >
            Privacy Policy
            <ExternalLink className="w-3 h-3" />
          </button>
          <span className="text-white/20">·</span>
          <button
            onClick={() => window.open('https://coldstar.dev/seeker-terms', '_blank', 'noopener,noreferrer')}
            className="text-xs text-white/50 hover:text-white transition-colors flex items-center gap-1"
          >
            Terms of Use
            <ExternalLink className="w-3 h-3" />
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
