import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Fingerprint, X } from 'lucide-react';
import { getWalletPassphrase } from '../../../services/wallet';
import { isBiometricAvailable, authenticateWithBiometric } from '../../../services/biometric';
import { hapticSuccess, hapticError } from '../../../utils/mobile';

interface PinVerificationProps {
  isOpen: boolean;
  onClose: () => void;
  onVerified: (pin: string) => void;
  title?: string;
  description?: string;
}

export function PinVerification({ 
  isOpen, 
  onClose, 
  onVerified,
  title = 'Authorize Transaction',
  description = 'Scan your fingerprint to authorize this transaction'
}: PinVerificationProps) {
  const [error, setError] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  // Auto-prompt biometric when modal opens
  useEffect(() => {
    if (isOpen) {
      triggerBiometric();
    }
  }, [isOpen]);

  const triggerBiometric = async () => {
    if (isAuthenticating) return;
    setIsAuthenticating(true);
    setError('');

    try {
      const available = await isBiometricAvailable();
      if (!available) {
        // Fallback: if biometric not available, pass passphrase directly
        const passphrase = await getWalletPassphrase();
        if (passphrase) {
          hapticSuccess();
          onVerified(passphrase);
        } else {
          setError('No wallet passphrase found');
        }
        setIsAuthenticating(false);
        return;
      }

      const success = await authenticateWithBiometric();
      if (success) {
        hapticSuccess();
        const passphrase = await getWalletPassphrase();
        if (passphrase) {
          onVerified(passphrase);
        } else {
          setError('No wallet passphrase found');
        }
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
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50"
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="fixed inset-x-4 top-1/2 -translate-y-1/2 max-w-md mx-auto bg-gradient-to-br from-white/10 to-white/5 border border-white/20 rounded-3xl p-6 z-50"
          >
            {/* Close Button */}
            <button
              onClick={onClose}
              className="absolute top-4 right-4 w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
            >
              <X className="w-4 h-4 text-white" />
            </button>

            {/* Fingerprint Icon Button */}
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={triggerBiometric}
              disabled={isAuthenticating}
              className="w-24 h-24 mx-auto mb-6 rounded-full bg-gradient-to-br from-white/10 to-white/5 border border-white/10 flex items-center justify-center active:bg-white/15 transition-colors"
            >
              <motion.div
                animate={isAuthenticating ? { scale: [1, 1.1, 1], opacity: [1, 0.5, 1] } : {}}
                transition={{ duration: 1, repeat: isAuthenticating ? Infinity : 0 }}
              >
                <Fingerprint className="w-12 h-12 text-white" />
              </motion.div>
            </motion.button>

            {/* Title */}
            <h2 className="text-2xl font-bold text-white text-center mb-2">
              {isAuthenticating ? 'Authenticating...' : title}
            </h2>

            {/* Description */}
            <p className="text-sm text-white/60 text-center mb-6">
              {description}
            </p>

            {/* Tap hint */}
            {!isAuthenticating && !error && (
              <p className="text-xs text-white/40 text-center">
                Tap the fingerprint icon to authenticate
              </p>
            )}

            {/* Error Message */}
            {error && (
              <motion.p
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-sm text-red-400 text-center"
              >
                {error}
              </motion.p>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
