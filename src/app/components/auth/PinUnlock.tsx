import { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Fingerprint, KeyRound } from 'lucide-react';
import { ShootingStars } from '../shared/ShootingStars';
import logoDisconnected from '../../../imports/Not_Connected.png';
import { useStartupPage } from '../../../utils/useStartupPage';
import { isBiometricAvailable, authenticateWithBiometric } from '../../../services/biometric';
import { verifyUSBWalletPin } from '../../../services/wallet';
import { detectUSBDevices } from '../../../services/usb-flash';
import { hapticSuccess, hapticError } from '../../../utils/mobile';

interface PinUnlockProps {
  onUnlock: () => void;
}

export function PinUnlock({ onUnlock }: PinUnlockProps) {
  const [error, setError] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState<boolean | null>(null);
  // PIN fallback — without it, a device with no usable biometrics is locked
  // out of the app entirely. Requires the USB drive (same trust as signing).
  const [showPinFallback, setShowPinFallback] = useState(false);
  const [pin, setPin] = useState('');
  const [verifyingPin, setVerifyingPin] = useState(false);
  useStartupPage();

  const handlePinUnlock = async () => {
    if (pin.length < 6 || verifyingPin) return;
    setVerifyingPin(true);
    setError('');
    try {
      const devices = await detectUSBDevices();
      if (devices.length === 0) {
        setError('Insert your Coldstar USB drive to unlock with PIN');
        return;
      }
      await verifyUSBWalletPin(devices[0], pin);
      hapticSuccess();
      onUnlock();
    } catch {
      hapticError();
      setError('Wrong PIN, or the drive could not be read');
    } finally {
      setVerifyingPin(false);
    }
  };

  // Check biometric availability and auto-prompt on mount
  useEffect(() => {
    const init = async () => {
      const available = await isBiometricAvailable();
      setBiometricAvailable(available);
      if (available) {
        triggerBiometric();
      } else {
        setShowPinFallback(true);
      }
    };
    init();
  }, []);

  const triggerBiometric = async () => {
    if (isAuthenticating) return;
    setIsAuthenticating(true);
    setError('');

    try {
      const success = await authenticateWithBiometric();
      if (success) {
        hapticSuccess();
        onUnlock();
      } else {
        hapticError();
        setError('Authentication failed. Tap to try again.');
      }
    } catch {
      hapticError();
      setError('Authentication failed. Tap to try again.');
    } finally {
      setIsAuthenticating(false);
    }
  };

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-between p-6 relative overflow-hidden">
      <ShootingStars />

      <div className="w-full max-w-md flex-1 flex flex-col items-center justify-center relative z-10">
        {/* Logo */}
        <motion.img
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          src={logoDisconnected}
          alt="Coldstar"
          className="h-16 mb-12"
        />

        {/* Fingerprint Icon */}
        <motion.button
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.1, type: 'spring', stiffness: 200 }}
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

        {/* Title */}
        <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3">
          {isAuthenticating ? 'Authenticating...' : 'Unlock Coldstar'}
        </h1>

        {/* Description */}
        <p className="text-base text-white/60 mb-8 leading-relaxed text-center">
          {biometricAvailable === false
            ? 'Biometrics unavailable — unlock with your wallet PIN (USB drive required)'
            : 'Use your fingerprint to unlock the wallet'
          }
        </p>

        {/* Tap to retry hint */}
        {!isAuthenticating && biometricAvailable !== false && !showPinFallback && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 2 }}
            className="text-sm text-white/40"
          >
            Tap the fingerprint icon to authenticate
          </motion.p>
        )}

        {/* PIN fallback (USB drive required — same trust boundary as signing) */}
        {showPinFallback ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-full mt-2"
          >
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              value={pin}
              onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handlePinUnlock(); }}
              placeholder="Wallet PIN"
              maxLength={12}
              className="w-full h-14 rounded-2xl bg-white/5 border border-white/10 text-white text-center text-xl font-mono tracking-[0.5em] px-4 focus:outline-none focus:border-white/30"
            />
            <button
              onClick={handlePinUnlock}
              disabled={pin.length < 6 || verifyingPin}
              className="w-full h-12 mt-3 rounded-2xl bg-white text-black font-semibold disabled:opacity-40 active:scale-[0.98] transition-transform"
            >
              {verifyingPin ? 'Verifying…' : 'Unlock'}
            </button>
          </motion.div>
        ) : (
          !isAuthenticating && (
            <button
              onClick={() => setShowPinFallback(true)}
              className="flex items-center gap-2 text-sm text-white/40 mt-4 active:text-white/60"
            >
              <KeyRound className="w-4 h-4" />
              Use wallet PIN instead
            </button>
          )
        )}

        {/* Error Message */}
        {error && (
          <motion.p
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-sm text-red-400 mt-4"
          >
            {error}
          </motion.p>
        )}
      </div>

      {/* Footer */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="w-full max-w-md text-center text-xs text-white/40 relative z-10"
      >
        <p>Secured by Solana Mobile Seeker biometric authentication</p>
      </motion.div>
    </div>
  );
}
