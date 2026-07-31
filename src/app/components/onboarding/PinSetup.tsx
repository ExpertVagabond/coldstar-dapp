import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { Fingerprint, CheckCircle2, ArrowLeft, Lock } from 'lucide-react';
import { ShootingStars } from '../shared/ShootingStars';
import { useStartupPage } from '../../../utils/useStartupPage';
import { createWallet, registerUSBWallet } from '../../../services/wallet';
import { isBiometricAvailable, authenticateWithBiometric } from '../../../services/biometric';
import { hapticSuccess, hapticError, hapticLight } from '../../../utils/mobile';

type SetupPhase = 'pin-enter' | 'pin-confirm' | 'biometric' | 'done';

export function PinSetup() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<SetupPhase>('pin-enter');
  const [isComplete, setIsComplete] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState('');
  const [biometricAvailable, setBiometricAvailable] = useState<boolean | null>(null);
  const [pinDigits, setPinDigits] = useState<string[]>([]);
  const [confirmDigits, setConfirmDigits] = useState<string[]>([]);
  const [pinError, setPinError] = useState('');
  const [savedPin, setSavedPin] = useState('');
  useStartupPage();

  useEffect(() => {
    const init = async () => {
      const available = await isBiometricAvailable();
      setBiometricAvailable(available);

      // If PIN was already set during USB flash, skip PIN entry
      const flashPin = sessionStorage.getItem('coldstar_flash_pin');
      if (flashPin && flashPin.length >= 6) {
        sessionStorage.removeItem('coldstar_flash_pin');
        setSavedPin(flashPin);
        if (available) {
          setPhase('biometric');
          // Inline biometric flow with the flash PIN (can't rely on savedPin state yet)
          setIsAuthenticating(true);
          try {
            const success = await authenticateWithBiometric();
            if (success) {
              hapticSuccess();
              await finalizeWallet(flashPin);
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
        } else {
          await finalizeWallet(flashPin);
        }
        return;
      }
    };
    init();
  }, []);

  const handlePinDigit = (digit: string) => {
    if (phase === 'pin-enter') {
      if (pinDigits.length >= 6) return;
      const newDigits = [...pinDigits, digit];
      setPinDigits(newDigits);
      hapticLight();
      if (newDigits.length === 6) {
        setSavedPin(newDigits.join(''));
        setTimeout(() => {
          setPhase('pin-confirm');
          setPinError('');
        }, 300);
      }
    } else if (phase === 'pin-confirm') {
      if (confirmDigits.length >= 6) return;
      const newDigits = [...confirmDigits, digit];
      setConfirmDigits(newDigits);
      hapticLight();
      if (newDigits.length === 6) {
        const confirmed = newDigits.join('');
        if (confirmed !== savedPin) {
          setPinError('PINs do not match — try again');
          setConfirmDigits([]);
          hapticError();
        } else {
          hapticSuccess();
          if (biometricAvailable) {
            setPhase('biometric');
            setTimeout(() => triggerBiometric(), 300);
          } else {
            finalizeWallet(savedPin);
          }
        }
      }
    }
  };

  const handleBackspace = () => {
    if (phase === 'pin-enter') {
      if (pinDigits.length === 0) return;
      setPinDigits(pinDigits.slice(0, -1));
    } else if (phase === 'pin-confirm') {
      if (confirmDigits.length === 0) return;
      setConfirmDigits(confirmDigits.slice(0, -1));
    }
    setPinError('');
    hapticLight();
  };

  const finalizeWallet = async (pin: string) => {
    try {
      // If coming from USB flash, the key is already on USB — just register metadata
      const flashPubkey = sessionStorage.getItem('coldstar_flash_pubkey');
      if (flashPubkey) {
        sessionStorage.removeItem('coldstar_flash_pubkey');
        await registerUSBWallet(flashPubkey, 'Main Wallet', pin);
      } else {
        // Software wallet creation (writes encrypted key to USB)
        await createWallet(pin, 'Main Wallet');
      }
      setIsComplete(true);
      setPhase('done');
      setTimeout(() => navigate('/onboarding/success'), 1500);
    } catch {
      setError('Failed to create wallet');
    }
  };

  const triggerBiometric = async () => {
    if (isAuthenticating) return;
    setIsAuthenticating(true);
    setError('');
    try {
      const success = await authenticateWithBiometric();
      if (success) {
        hapticSuccess();
        await finalizeWallet(savedPin);
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
        <AnimatePresence mode="wait">
          {(phase === 'pin-enter' || phase === 'pin-confirm') && (
            <motion.div
              key={phase}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="w-full text-center"
            >
              {/* Lock Icon */}
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 200 }}
                className="w-20 h-20 mx-auto mb-6 rounded-full bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/30 flex items-center justify-center"
              >
                <Lock className="w-10 h-10 text-amber-400" />
              </motion.div>

              <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">
                {phase === 'pin-enter' ? 'Create PIN' : 'Confirm PIN'}
              </h1>
              <p className="text-base text-white/60 mb-8">
                {phase === 'pin-enter'
                  ? 'Enter a 6-digit PIN to encrypt your wallet'
                  : 'Re-enter your PIN to confirm'}
              </p>

              {/* PIN Dots */}
              <div className="flex gap-4 justify-center mb-6">
                {Array.from({ length: 6 }).map((_, i) => {
                  const digits = phase === 'pin-enter' ? pinDigits : confirmDigits;
                  return (
                    <motion.div
                      key={i}
                      animate={digits[i] ? { scale: [1, 1.3, 1] } : {}}
                      transition={{ duration: 0.15 }}
                      className={`w-4 h-4 rounded-full border-2 transition-colors ${
                        digits[i]
                          ? 'bg-white border-white'
                          : 'bg-transparent border-white/30'
                      }`}
                    />
                  );
                })}
              </div>

              {/* Error */}
              {pinError && (
                <motion.p
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-sm text-red-400 mb-4"
                >
                  {pinError}
                </motion.p>
              )}

              {/* PIN Pad */}
              <div className="w-full max-w-xs mx-auto">
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
                    onClick={handleBackspace}
                    className="h-16 bg-white/5 rounded-2xl text-white/60 hover:bg-white/10 transition-colors active:scale-95 flex items-center justify-center"
                  >
                    <ArrowLeft className="w-6 h-6" />
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {phase === 'biometric' && !isComplete && (
            <motion.div
              key="biometric"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="w-full text-center"
            >
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

              <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3">
                {isAuthenticating ? 'Authenticating...' : 'Set Up Biometrics'}
              </h1>
              <p className="text-base text-white/60 mb-8 leading-relaxed">
                Scan your fingerprint to secure your wallet
              </p>

              <AnimatePresence>
                {error && (
                  <motion.p
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="text-sm text-red-400 mt-4"
                  >
                    {error}
                  </motion.p>
                )}
              </AnimatePresence>
            </motion.div>
          )}

          {isComplete && (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="w-full text-center"
            >
              {/* Success Icon */}
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.1, type: 'spring', stiffness: 200 }}
                className="w-20 h-20 mx-auto mb-8 rounded-3xl bg-gradient-to-br from-emerald-500/20 to-green-500/20 border border-emerald-500/30 flex items-center justify-center"
              >
                <CheckCircle2 className="w-10 h-10 text-emerald-400" />
              </motion.div>

              <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3">
                Wallet Secured
              </h1>
              <p className="text-base text-white/60">
                Your wallet is now protected by PIN + AES-256 encryption
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Info Footer */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="w-full max-w-md text-center text-xs text-white/40 relative z-10"
      >
        <p>Secured by AES-256 PIN encryption + Solana Mobile biometrics</p>
      </motion.div>
    </div>
  );
}
