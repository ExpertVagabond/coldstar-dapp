import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, ChevronDown, Scan, Shield, Clipboard, Fingerprint, Lock } from 'lucide-react';
import { useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { SwipeButton } from '../shared/SwipeButton';
import { HardwareStatus } from '../shared/HardwareStatus';
import { hapticLight, hapticSuccess, hapticError } from '../../../utils/mobile';
import { useWallet } from '../../../contexts/WalletContext';
import { getKeypair, verifyPin } from '../../../services/wallet';
import { sendSol, sendSplToken, isValidAddress, SERVICE_FEE_RATE } from '../../../services/transactions';
import { isBiometricAvailable, authenticateWithBiometric } from '../../../services/biometric';
import { BarcodeScanner, BarcodeFormat } from '@capacitor-mlkit/barcode-scanning';
import { TokenIcon } from '../shared/TokenIcon';

type SendStep = 'address' | 'biometric' | 'amount' | 'review' | 'pin' | 'sign' | 'complete';

const RECENT_ADDRESSES_KEY = 'coldstar_recent_addresses';
const MAX_RECENT_ADDRESSES = 5;

function getRecentAddresses(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_ADDRESSES_KEY);
    if (!stored) return [];
    const addresses = JSON.parse(stored);
    return Array.isArray(addresses) ? addresses.filter((a: unknown) => typeof a === 'string' && isValidAddress(a as string)) : [];
  } catch {
    return [];
  }
}

function saveRecentAddress(address: string) {
  if (!isValidAddress(address)) return;
  const existing = getRecentAddresses();
  const filtered = existing.filter(a => a !== address);
  const updated = [address, ...filtered].slice(0, MAX_RECENT_ADDRESSES);
  localStorage.setItem(RECENT_ADDRESSES_KEY, JSON.stringify(updated));
}

export function Send() {
  const navigate = useNavigate();
  const { assets: walletAssets, refreshBalances, hardwareConnected } = useWallet();
  const [step, setStep] = useState<SendStep>('address');
  
  // Build asset list from real wallet data
  const assetList = walletAssets.map(a => ({
    symbol: a.symbol,
    balance: a.balance,
    logo: a.logo,
    logoURI: a.logoURI,
    mint: a.mint,
    decimals: a.decimals,
    balanceRaw: a.balanceRaw,
  }));
  
  const [selectedAsset, setSelectedAsset] = useState(assetList[0] || { symbol: 'SOL', balance: '0', logo: '◎', mint: 'So11111111111111111111111111111111111111112', decimals: 9, balanceRaw: 0 });
  const [showAssets, setShowAssets] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [isSigning, setIsSigning] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const [showPrivateInfo, setShowPrivateInfo] = useState(false);
  const [, setIsPinVerified] = useState(false);
  const [pinDigits, setPinDigits] = useState<string[]>([]);
  const [pinError, setPinError] = useState('');
  const [biometricError, setBiometricError] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [amountDisplay, setAmountDisplay] = useState('0');
  const [txSignature, setTxSignature] = useState('');
  const [txError, setTxError] = useState('');
  const [verifiedPin, setVerifiedPin] = useState('');
  const [addressError, setAddressError] = useState('');

  const handleNumberPress = (num: string) => {
    if (num === '.' && amountDisplay.includes('.')) return;
    if (amountDisplay === '0' && num !== '.') {
      setAmountDisplay(num);
    } else {
      setAmountDisplay(amountDisplay + num);
    }
    setAmount(amountDisplay === '0' && num !== '.' ? num : amountDisplay + num);
  };

  const handleBackspace = () => {
    if (amountDisplay.length <= 1) {
      setAmountDisplay('0');
      setAmount('');
    } else {
      const newValue = amountDisplay.slice(0, -1);
      setAmountDisplay(newValue);
      setAmount(newValue);
    }
  };

  const handlePercentage = (percent: number) => {
    const balance = selectedAsset.balanceRaw;
    const value = ((balance * percent) / 100).toFixed(6);
    setAmountDisplay(value);
    setAmount(value);
    hapticLight();
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && isValidAddress(text.trim())) {
        setRecipient(text.trim());
        setAddressError('');
      } else if (text) {
        setRecipient(text.trim());
        setAddressError('Invalid Solana address');
      }
      hapticLight();
    } catch (err) {
      console.warn('Clipboard access not available:', err);
    }
  };

  const handleQRScan = async () => {
    hapticLight();
    try {
      const { camera } = await BarcodeScanner.requestPermissions();
      if (camera !== 'granted' && camera !== 'limited') {
        setAddressError('Camera permission denied');
        return;
      }
      const { barcodes } = await BarcodeScanner.scan({
        formats: [BarcodeFormat.QrCode],
      });
      if (barcodes.length > 0) {
        let rawValue = barcodes[0].rawValue || '';
        // Strip solana: URI prefix if present
        if (rawValue.startsWith('solana:')) {
          rawValue = rawValue.replace('solana:', '').split('?')[0];
        }
        rawValue = rawValue.trim();
        if (isValidAddress(rawValue)) {
          setRecipient(rawValue);
          setAddressError('');
          hapticSuccess();
        } else {
          setAddressError('QR code does not contain a valid Solana address');
          hapticError();
        }
      }
    } catch (err: any) {
      if (err?.message?.includes('canceled') || err?.message?.includes('cancelled')) {
        // User cancelled scan — do nothing
      } else {
        setAddressError('QR scanner not available');
        console.warn('QR scan failed:', err);
      }
    }
  };

  const handleReview = () => {
    if (!recipient || !amount) return;
    setStep('review');
  };

  const handleSign = () => {
    setStep('pin');
    setPinDigits([]);
    setPinError('');
  };

  const triggerBiometric = useCallback(async () => {
    if (isAuthenticating) return;
    setIsAuthenticating(true);
    setBiometricError('');

    try {
      const available = await isBiometricAvailable();
      if (!available) {
        // Skip biometric on devices without it
        hapticSuccess();
        setStep('amount');
        setIsAuthenticating(false);
        return;
      }

      const success = await authenticateWithBiometric();
      if (success) {
        hapticSuccess();
        setStep('amount');
      } else {
        hapticError();
        setBiometricError('Authentication failed. Tap to try again.');
      }
    } catch {
      hapticError();
      setBiometricError('Authentication failed. Tap to try again.');
    } finally {
      setIsAuthenticating(false);
    }
  }, [isAuthenticating]);

  // Auto-trigger biometric when entering the biometric step
  useEffect(() => {
    if (step === 'biometric' && !isAuthenticating) {
      triggerBiometric();
    }
  }, [step]);

  const handlePinDigit = async (digit: string) => {
    if (pinDigits.length >= 6) return;
    const newDigits = [...pinDigits, digit];
    setPinDigits(newDigits);
    hapticLight();

    if (newDigits.length === 6) {
      // PIN complete — verify against stored hash (keys are on USB, not phone)
      const enteredPin = newDigits.join('');
      try {
        const valid = await verifyPin(enteredPin);
        if (valid) {
          setVerifiedPin(enteredPin);
          setIsPinVerified(true);
          hapticSuccess();
          setTimeout(() => setStep('sign'), 300);
        } else {
          setPinError('Wrong PIN');
          setPinDigits([]);
          hapticError();
        }
      } catch {
        setPinError('Wrong PIN — verification failed');
        setPinDigits([]);
        hapticError();
      }
    }
  };

  const handlePinBackspace = () => {
    if (pinDigits.length === 0) return;
    setPinDigits(pinDigits.slice(0, -1));
    setPinError('');
    hapticLight();
  };

  const handleCompleteSigning = async () => {
    setIsSigning(true);
    setTxError('');
    
    try {
      const keypair = await getKeypair(verifiedPin);
      
      let result;
      const solMint = 'So11111111111111111111111111111111111111112';
      
      if (selectedAsset.symbol === 'SOL' || selectedAsset.mint === solMint) {
        // Send native SOL
        result = await sendSol({
          from: keypair,
          to: recipient,
          amount: parseFloat(amount),
        });
      } else {
        // Send SPL token
        result = await sendSplToken({
          from: keypair,
          to: recipient,
          amount: parseFloat(amount),
          mint: selectedAsset.mint,
          decimals: selectedAsset.decimals,
        });
      }

      if (result.success) {
        setTxSignature(result.signature);
        saveRecentAddress(recipient);
        setStep('complete');
        refreshBalances();
      } else {
        setTxError(result.error || 'Transaction failed');
      }
    } catch (err: any) {
      setTxError(err.message || 'Failed to sign transaction');
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

        <h1 className="text-3xl font-semibold text-white mb-4">Transaction Sent!</h1>
        <p className="text-base text-white/60 text-center mb-8">
          Your transaction has been broadcast to the network
        </p>

        <div className="w-full max-w-md space-y-3 mb-8">
          <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
            <div className="text-sm text-white/60 mb-1">Amount</div>
            <div className="text-xl font-semibold text-white">
              {amount} {selectedAsset.symbol}
            </div>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
            <div className="text-sm text-white/60 mb-1">To</div>
            <div className="text-sm font-mono text-white break-all">
              {recipient}
            </div>
          </div>
          {txSignature && (
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
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
        </div>

        <button
          onClick={() => navigate('/app')}
          className="w-full max-w-md h-14 rounded-2xl bg-white text-black font-semibold active:scale-95 transition-transform"
        >
          Back to Home
        </button>
      </div>
    );
  }

  if (step === 'pin') {
    return (
      <div className="min-h-screen bg-black flex flex-col">
        {/* Header */}
        <div className="px-6 pt-12 pb-4">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setStep('review')}
              className="p-2 hover:bg-white/5 rounded-lg transition-colors active:scale-95"
            >
              <ArrowLeft className="w-6 h-6 text-white" />
            </button>
            <h1 className="text-xl font-semibold text-white">AES-256 Decryption</h1>
          </div>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-6">
          {/* Lock Icon */}
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 200 }}
            className="w-20 h-20 rounded-full bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/30 flex items-center justify-center mb-6"
          >
            <Lock className="w-10 h-10 text-amber-400" />
          </motion.div>

          <h2 className="text-2xl font-bold text-white mb-2 text-center">
            Enter PIN
          </h2>
          <p className="text-sm text-white/60 text-center mb-8">
            Enter your 6-digit PIN for AES-256 decryption
          </p>

          {/* PIN Dots */}
          <div className="flex gap-4 mb-8">
            {Array.from({ length: 6 }).map((_, i) => (
              <motion.div
                key={i}
                animate={pinDigits[i] ? { scale: [1, 1.3, 1] } : {}}
                transition={{ duration: 0.15 }}
                className={`w-4 h-4 rounded-full border-2 transition-colors ${
                  pinDigits[i]
                    ? 'bg-white border-white'
                    : 'bg-transparent border-white/30'
                }`}
              />
            ))}
          </div>

          {/* Error message */}
          {pinError && (
            <motion.p
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-sm text-red-400 mb-4"
            >
              {pinError}
            </motion.p>
          )}

          {/* Transaction summary */}
          <div className="w-full max-w-sm bg-white/5 border border-white/10 rounded-2xl p-4 mb-8">
            <div className="flex justify-between items-center">
              <span className="text-sm text-white/60">Amount</span>
              <span className="text-sm font-semibold text-white">{amount} {selectedAsset.symbol}</span>
            </div>
            <div className="border-t border-white/10 my-2" />
            <div className="flex justify-between items-center">
              <span className="text-sm text-white/60">To</span>
              <span className="text-sm font-mono text-white">
                {recipient.slice(0, 4)}...{recipient.slice(-4)}
              </span>
            </div>
          </div>

          {/* PIN Pad */}
          <div className="w-full max-w-xs">
            <div className="grid grid-cols-3 gap-3">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
                <button
                  key={num}
                  onClick={() => handlePinDigit(num.toString())}
                  className="h-16 bg-white/5 rounded-2xl text-white text-2xl font-semibold hover:bg-white/10 transition-colors active:scale-95"
                >
                  {num}
                </button>
              ))}
              <div />
              <button
                onClick={() => handlePinDigit('0')}
                className="h-16 bg-white/5 rounded-2xl text-white text-2xl font-semibold hover:bg-white/10 transition-colors active:scale-95"
              >
                0
              </button>
              <button
                onClick={handlePinBackspace}
                className="h-16 bg-white/5 rounded-2xl text-white/60 hover:bg-white/10 transition-colors active:scale-95 flex items-center justify-center"
              >
                <ArrowLeft className="w-6 h-6" />
              </button>
            </div>
          </div>
        </div>
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
            className="w-24 h-24 rounded-3xl bg-gradient-to-br from-emerald-500/20 to-green-500/20 border-2 border-emerald-500/30 flex items-center justify-center mb-8"
          >
            <span className="text-5xl">{isSigning ? '🔐' : '📡'}</span>
          </motion.div>

          <h1 className="text-2xl font-semibold text-white mb-4 text-center">
            {isSigning ? 'Broadcasting Transaction...' : 'Ready to Broadcast'}
          </h1>
          <p className="text-base text-white/60 text-center mb-8">
            {isSigning
              ? 'Signing and broadcasting to Solana network'
              : 'Swipe to sign and broadcast this transaction'}
          </p>

          {txError && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full bg-red-500/10 border border-red-500/30 rounded-2xl p-4 mb-4"
            >
              <p className="text-sm text-red-400 text-center">{txError}</p>
            </motion.div>
          )}

          <div className="w-full mb-8">
            <HardwareStatus connected={hardwareConnected} variant="badge" />
          </div>

          <div className="w-full space-y-3 mb-8">
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
              <div className="text-sm text-white/60 mb-1">Sending</div>
              <div className="text-xl font-semibold text-white">
                {amount} {selectedAsset.symbol}
              </div>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
              <div className="text-sm text-white/60 mb-1">To</div>
              <div className="text-sm font-mono text-white break-all">
                {recipient}
              </div>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm text-white/60">Network Fee</span>
                <span className="text-sm font-medium text-white">0.000005 SOL</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-white/60">Service Fee (1%)</span>
                <span className="text-sm font-medium text-white">
                  {(parseFloat(amount || '0') * SERVICE_FEE_RATE).toFixed(6)} SOL
                </span>
              </div>
            </div>
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-3">
              <div className="flex items-center gap-2 justify-center">
                <Lock className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-xs text-emerald-400 font-medium">
                  AES-256 decryption key ready &bull; PIN verified
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="max-w-md mx-auto w-full">
          {!isSigning && (
            <SwipeButton
              onComplete={handleCompleteSigning}
              text="Swipe to broadcast"
              variant="sign"
            />
          )}
        </div>
      </div>
    );
  }

  if (step === 'review') {
    return (
      <div className="min-h-screen bg-black flex flex-col">
        <div className="px-3 sm:px-6 pt-12 sm:pt-14 pb-4 border-b border-white/10">
          <div className="flex items-center gap-4 mb-4">
            <button
              onClick={() => setStep('amount')}
              className="p-2 hover:bg-white/5 rounded-lg transition-colors active:scale-95"
            >
              <ArrowLeft className="w-6 h-6 text-white" />
            </button>
            <h1 className="text-xl font-semibold text-white">Review Transaction</h1>
          </div>
        </div>

        <div className="flex-1 px-6 py-6">
          <div className="max-w-md mx-auto space-y-4">
            <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
              <div className="text-center mb-4">
                <TokenIcon
                  logoURI={selectedAsset.logoURI}
                  logo={selectedAsset.logo}
                  symbol={selectedAsset.symbol}
                  size="w-16 h-16"
                  textSize="text-4xl"
                  className="mx-auto mb-2"
                />
                <div className="text-3xl font-semibold text-white mb-1">
                  {amount}
                </div>
                <div className="text-lg text-white/60">{selectedAsset.symbol}</div>
                
                {/* Private Send Badge */}
                {isPrivate && (
                  <div className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 bg-purple-500/20 border border-purple-500/30 rounded-full">
                    <Shield className="w-3.5 h-3.5 text-purple-400" />
                    <span className="text-xs font-medium text-purple-400">Private Transfer</span>
                  </div>
                )}
              </div>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-3">
              <div>
                <div className="text-sm text-white/60 mb-1">From</div>
                <div className="text-sm font-mono text-white">Your Wallet</div>
              </div>
              <div className="border-t border-white/10" />
              <div>
                <div className="text-sm text-white/60 mb-1">To</div>
                <div className="text-sm font-mono text-white break-all">{recipient}</div>
              </div>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm text-white/60">Network</span>
                <span className="text-sm font-medium text-white">Solana</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-white/60">Network Fee</span>
                <span className="text-sm font-medium text-white">0.000005 SOL</span>
              </div>
              {isPrivate && (
                <div className="flex justify-between items-center">
                  <span className="text-sm text-white/60">Privacy Fee</span>
                  <span className="text-sm font-medium text-white">0.00001 SOL</span>
                </div>
              )}
              <div className="flex justify-between items-center">
                <span className="text-sm text-white/60">Service Fee (1%)</span>
                <span className="text-sm font-medium text-white">
                  {(parseFloat(amount || '0') * SERVICE_FEE_RATE).toFixed(6)} SOL
                </span>
              </div>
              <div className="border-t border-white/10 my-2" />
              <div className="flex justify-between items-center">
                <span className="text-sm font-semibold text-white">Total</span>
                <span className="text-base font-semibold text-white">
                  {(parseFloat(amount) + 0.000005 + (isPrivate ? 0.00001 : 0) + parseFloat(amount) * SERVICE_FEE_RATE).toFixed(6)} {selectedAsset.symbol}
                </span>
              </div>
            </div>
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

  if (step === 'biometric') {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-between p-6">
        {/* Back button */}
        <div className="w-full pt-6">
          <button
            onClick={() => setStep('address')}
            className="p-2 hover:bg-white/5 rounded-lg transition-colors active:scale-95"
          >
            <ArrowLeft className="w-6 h-6 text-white" />
          </button>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center max-w-md w-full">
          {/* Fingerprint Icon */}
          <motion.button
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 200 }}
            whileTap={{ scale: 0.9 }}
            onClick={triggerBiometric}
            disabled={isAuthenticating}
            className="w-28 h-28 mx-auto mb-8 rounded-full bg-gradient-to-br from-white/10 to-white/5 border border-white/10 flex items-center justify-center active:bg-white/15 transition-colors"
          >
            <motion.div
              animate={isAuthenticating ? { scale: [1, 1.1, 1], opacity: [1, 0.5, 1] } : {}}
              transition={{ duration: 1, repeat: isAuthenticating ? Infinity : 0 }}
            >
              <Fingerprint className="w-14 h-14 text-white" />
            </motion.div>
          </motion.button>

          <h1 className="text-3xl font-bold text-white mb-3 text-center">
            {isAuthenticating ? 'Authenticating...' : 'Verify Identity'}
          </h1>

          <p className="text-base text-white/60 text-center mb-8">
            Scan your fingerprint to build a transaction
          </p>

          {/* Recipient summary */}
          <div className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 mb-6">
            <div className="text-sm text-white/60 mb-1">Sending to</div>
            <div className="text-sm font-mono text-white break-all">
              {recipient}
            </div>
          </div>

          {!isAuthenticating && !biometricError && (
            <p className="text-xs text-white/40 text-center">
              Tap the fingerprint icon to authenticate
            </p>
          )}

          {biometricError && (
            <motion.p
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-sm text-red-400 text-center"
            >
              {biometricError}
            </motion.p>
          )}
        </div>

        <div className="w-full max-w-md text-center text-xs text-white/40 pb-4">
          <p>Biometric authentication required before entering amount</p>
        </div>
      </div>
    );
  }

  if (step === 'amount') {
    return (
      <div className="min-h-screen bg-black flex flex-col">
        {/* Header */}
        <div className="px-3 sm:px-6 pt-12 sm:pt-14 pb-4">
          <div className="flex items-center justify-between mb-1">
            <button
              onClick={() => setStep('address')}
              className="p-2 hover:bg-white/5 rounded-lg transition-colors active:scale-95"
            >
              <ArrowLeft className="w-6 h-6 text-white" />
            </button>
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded bg-white/10 flex items-center justify-center">
                <span className="text-xs">📋</span>
              </div>
              <span className="text-base font-medium text-white">
                {recipient ? `${recipient.slice(0, 4)}...${recipient.slice(-4)}` : 'No recipient'}
              </span>
            </div>
            <div className="w-10" /> {/* Spacer for centering */}
          </div>
        </div>

        {/* Amount Display */}
        <div className="flex-1 flex flex-col items-center">
          <div className="text-center mb-4 mt-4">
            <div className="flex items-baseline justify-center">
              <span className={`text-6xl font-semibold tracking-tight ${
                amountDisplay && amountDisplay !== '0' ? 'text-white' : 'text-white/40'
              }`}>
                {amountDisplay || '0'}
              </span>
              <span className={`text-2xl font-semibold ml-2 ${
                amountDisplay && amountDisplay !== '0' ? 'text-white' : 'text-white/40'
              }`}>
                {selectedAsset.symbol}
              </span>
            </div>
          </div>

          {/* Balance and Privacy Buttons */}
          <div className="flex gap-3 mb-4">
            <button
              onClick={() => setShowAssets(!showAssets)}
              className="px-4 h-10 bg-white/10 rounded-full flex items-center gap-2 hover:bg-white/15 transition-colors active:scale-95"
            >
              <div className="flex items-center gap-1.5">
                <div className="w-4 h-4 flex items-center justify-center">
                  <div className="w-2 h-2 bg-emerald-400 rounded-full" />
                  <div className="w-2 h-2 bg-blue-400 rounded-full -ml-1" />
                  <div className="w-2 h-2 bg-purple-400 rounded-full -ml-1" />
                </div>
                <span className="text-sm font-medium text-white">
                  {selectedAsset.balance} {selectedAsset.symbol}
                </span>
              </div>
              <ChevronDown className="w-4 h-4 text-white/60" />
            </button>

            <button
              onClick={() => setIsPrivate(!isPrivate)}
              className="px-4 h-10 bg-white/10 rounded-full flex items-center gap-2 hover:bg-white/15 transition-colors active:scale-95"
            >
              <Shield className="w-4 h-4 text-white" />
              <span className="text-sm font-medium text-white">
                {isPrivate ? 'Private' : 'Public'}
              </span>
              <ChevronDown className="w-4 h-4 text-white/60" />
            </button>
          </div>

          {/* Percentage Buttons */}
          <div className="flex gap-3 mb-4 px-6">
            <button
              onClick={() => handlePercentage(25)}
              className="flex-1 h-10 bg-white/5 rounded-2xl text-white font-semibold hover:bg-white/10 transition-colors active:scale-95"
            >
              25%
            </button>
            <button
              onClick={() => handlePercentage(50)}
              className="flex-1 h-10 bg-white/5 rounded-2xl text-white font-semibold hover:bg-white/10 transition-colors active:scale-95"
            >
              50%
            </button>
            <button
              onClick={() => handlePercentage(75)}
              className="flex-1 h-10 bg-white/5 rounded-2xl text-white font-semibold hover:bg-white/10 transition-colors active:scale-95"
            >
              75%
            </button>
            <button
              onClick={() => handlePercentage(100)}
              className="flex-1 h-10 bg-white/5 rounded-2xl text-white font-semibold hover:bg-white/10 transition-colors active:scale-95"
            >
              Max
            </button>
          </div>

          {/* Custom Numeric Keypad */}
          <div className="w-full flex-1 max-w-sm px-6 flex flex-col">
            <div className="grid grid-cols-3 gap-1 flex-1">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
                <button
                  key={num}
                  onClick={() => handleNumberPress(num.toString())}
                  className="bg-transparent text-white text-2xl font-semibold hover:bg-white/5 rounded-2xl transition-colors active:scale-95"
                >
                  {num}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-1 flex-1">
              <button
                onClick={() => handleNumberPress('.')}
                className="bg-transparent text-white text-2xl font-semibold hover:bg-white/5 rounded-2xl transition-colors active:scale-95"
              >
                .
              </button>
              <button
                onClick={() => handleNumberPress('0')}
                className="bg-transparent text-white text-2xl font-semibold hover:bg-white/5 rounded-2xl transition-colors active:scale-95"
              >
                0
              </button>
              <button
                onClick={handleBackspace}
                className="bg-transparent text-white hover:bg-white/5 rounded-2xl transition-colors active:scale-95 flex items-center justify-center"
              >
                <ArrowLeft className="w-6 h-6 text-white/60" />
              </button>
            </div>
          </div>
        </div>

        {/* Continue Button */}
        <div className="px-6 pb-6">
          {!recipient ? (
            <div className="space-y-3">
              <p className="text-sm text-white/60 text-center mb-3">
                Add recipient address first
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleQRScan}
                  className="flex-1 h-14 bg-white/5 border border-white/10 rounded-2xl hover:bg-white/10 transition-colors active:scale-98 flex items-center justify-center gap-2"
                >
                  <Scan className="w-5 h-5 text-white" />
                  <span className="text-white font-medium">Scan QR</span>
                </button>
                <button
                  onClick={handlePaste}
                  className="flex-1 h-14 bg-white/5 border border-white/10 rounded-2xl hover:bg-white/10 transition-colors active:scale-98 flex items-center justify-center gap-2"
                >
                  <Clipboard className="w-5 h-5 text-white" />
                  <span className="text-white font-medium">Paste</span>
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={handleReview}
              disabled={!amount || amount === '0'}
              className="w-full h-14 rounded-2xl bg-white/10 text-white/40 font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed enabled:bg-white enabled:text-black enabled:active:scale-95"
            >
              Continue
            </button>
          )}
        </div>

        {/* Asset Selection Modal */}
        <AnimatePresence>
          {showAssets && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end"
              onClick={() => setShowAssets(false)}
            >
              <motion.div
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 30, stiffness: 300 }}
                onClick={(e) => e.stopPropagation()}
                className="w-full bg-gradient-to-b from-zinc-900 to-black border-t border-white/10 rounded-t-3xl p-6"
              >
                <div className="w-12 h-1 bg-white/20 rounded-full mx-auto mb-6" />
                <h2 className="text-xl font-semibold text-white mb-4">Select Asset</h2>
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {assetList.map((asset) => (
                    <button
                      key={asset.symbol}
                      onClick={() => {
                        setSelectedAsset(asset);
                        setShowAssets(false);
                        setAmountDisplay('0');
                        setAmount('');
                      }}
                      className="w-full p-4 rounded-2xl bg-white/5 border border-white/10 hover:bg-white/10 transition-colors active:scale-98 flex items-center gap-3"
                    >
                      <TokenIcon
                        logoURI={asset.logoURI}
                        logo={asset.logo}
                        symbol={asset.symbol}
                        size="w-10 h-10"
                        textSize="text-xl"
                      />
                      <div className="flex-1 text-left">
                        <div className="font-semibold text-white">{asset.symbol}</div>
                        <div className="text-sm text-white/60">
                          Balance: {asset.balance}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Private Send Info Modal */}
        <AnimatePresence>
          {showPrivateInfo && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end"
              onClick={() => setShowPrivateInfo(false)}
            >
              <motion.div
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={{ type: 'spring', damping: 30, stiffness: 300 }}
                onClick={(e) => e.stopPropagation()}
                className="w-full bg-gradient-to-b from-zinc-900 to-black border-t border-white/10 rounded-t-3xl p-6 max-h-[80vh] overflow-y-auto"
              >
                <div className="w-12 h-1 bg-white/20 rounded-full mx-auto mb-6" />

                <div className="max-w-md mx-auto">
                  <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-500/20 to-blue-500/20 border border-purple-500/30 flex items-center justify-center mb-4">
                    <Shield className="w-8 h-8 text-purple-400" />
                  </div>

                  <h2 className="text-2xl font-semibold text-white mb-2">Private Send</h2>
                  <p className="text-base text-white/60 mb-6">
                    Enhanced privacy for your Solana transactions
                  </p>

                  <div className="space-y-4 mb-6">
                    <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                      <h3 className="font-semibold text-white mb-2">How it works</h3>
                      <p className="text-sm text-white/70 leading-relaxed">
                        Private Send uses Solana's confidential transfer extension to encrypt transaction amounts on-chain. While sender and recipient addresses remain visible, the amount transferred is hidden from public view.
                      </p>
                    </div>

                    <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                      <h3 className="font-semibold text-white mb-2">What's hidden</h3>
                      <ul className="text-sm text-white/70 space-y-1">
                        <li>• Transaction amount</li>
                        <li>• Token balance changes</li>
                      </ul>
                    </div>

                    <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                      <h3 className="font-semibold text-white mb-2">What's visible</h3>
                      <ul className="text-sm text-white/70 space-y-1">
                        <li>• Sender address</li>
                        <li>• Recipient address</li>
                        <li>• Token type (e.g., USDC, SOL)</li>
                        <li>• Transaction timestamp</li>
                      </ul>
                    </div>

                    <div className="bg-purple-500/10 border border-purple-500/20 rounded-2xl p-4">
                      <h3 className="font-semibold text-white mb-2">Additional Fee</h3>
                      <p className="text-sm text-white/70 leading-relaxed">
                        Private transactions require additional computation. An extra fee of <span className="font-medium text-white">0.00001 SOL</span> is added to cover the cost of confidential transfer processing.
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={() => setShowPrivateInfo(false)}
                    className="w-full h-14 rounded-2xl bg-white text-black font-semibold active:scale-95 transition-transform"
                  >
                    Got it
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  // Address selection page (default)
  return (
    <div className="min-h-screen bg-black flex flex-col">
      {/* Header */}
      <div className="px-3 sm:px-6 pt-12 sm:pt-14 pb-6">
        <button
          onClick={() => navigate('/app')}
          className="p-2 hover:bg-white/5 rounded-lg transition-colors active:scale-95"
        >
          <ArrowLeft className="w-6 h-6 text-white" />
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col px-6 pt-8">
        <div className="w-full max-w-md mx-auto">
          {/* Title */}
          <div className="mb-12">
            <h1 className="text-4xl font-semibold text-white mb-3 tracking-tight">
              Send to
            </h1>
            <p className="text-base text-white/40">
              Enter recipient wallet address
            </p>
          </div>

          {/* Selected Address Display */}
          <AnimatePresence>
            {recipient && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="bg-white/5 border border-white/10 rounded-3xl p-5 mb-6"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-white/40 mb-2 uppercase tracking-wider font-medium">
                      Recipient
                    </div>
                    <div className="text-sm font-mono text-white break-all leading-relaxed">
                      {recipient}
                    </div>
                  </div>
                  <button
                    onClick={() => setRecipient('')}
                    className="p-2 hover:bg-white/10 rounded-lg transition-colors active:scale-95 flex-shrink-0"
                  >
                    <span className="text-white/40 text-lg">×</span>
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Action Buttons */}
          <div className="space-y-4 mb-12">
            <button
              onClick={handleQRScan}
              className="w-full h-16 bg-white/5 border border-white/10 rounded-3xl hover:bg-white/10 hover:border-white/20 transition-all active:scale-98 flex items-center px-6 group"
            >
              <Scan className="w-5 h-5 text-white/60 group-hover:text-white/80 transition-colors" />
              <span className="flex-1 text-center text-white font-medium">Scan QR Code</span>
              <div className="w-5" />
            </button>
            
            <button
              onClick={handlePaste}
              className="w-full h-16 bg-white/5 border border-white/10 rounded-3xl hover:bg-white/10 hover:border-white/20 transition-all active:scale-98 flex items-center px-6 group"
            >
              <Clipboard className="w-5 h-5 text-white/60 group-hover:text-white/80 transition-colors" />
              <span className="flex-1 text-center text-white font-medium">Paste Address</span>
              <div className="w-5" />
            </button>
          </div>

          {/* Address Error */}
          {addressError && (
            <motion.p
              initial={{ opacity: 0, y: -5 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-sm text-red-400 text-center mb-4"
            >
              {addressError}
            </motion.p>
          )}

          {/* Recent Addresses */}
          {!recipient && (() => {
            const recentAddresses = getRecentAddresses();
            if (recentAddresses.length === 0) return null;
            return (
              <div>
                <div className="text-xs text-white/40 mb-4 uppercase tracking-wider font-medium">
                  Recent
                </div>
                <div className="space-y-3">
                  {recentAddresses.map((addr, idx) => (
                    <button
                      key={idx}
                      onClick={() => {
                        setRecipient(addr);
                        setAddressError('');
                        hapticLight();
                      }}
                      className="w-full p-4 rounded-2xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all active:scale-98 flex items-center gap-3"
                    >
                      <div className="w-2 h-2 rounded-full bg-white/20" />
                      <div className="flex-1 text-left">
                        <div className="text-sm font-mono text-white/80">
                          {addr.slice(0, 4)}...{addr.slice(-4)}
                        </div>
                      </div>
                      <ArrowLeft className="w-4 h-4 text-white/20 rotate-180" />
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Continue Button */}
      <div className="px-6 pb-8 pt-6">
        <button
          onClick={() => setStep('biometric')}
          disabled={!recipient}
          className="w-full h-14 rounded-full bg-white/10 text-white/30 font-bold text-base tracking-wide transition-all disabled:opacity-50 disabled:cursor-not-allowed enabled:bg-white enabled:text-black enabled:active:scale-98"
        >
          Continue
        </button>
      </div>
    </div>
  );
}