import { useState, useEffect, useCallback } from 'react';
import { CheckCircle2, Shield, AlertTriangle, Key, HardDrive, Lock, FileCheck } from 'lucide-react';
import { useNavigate } from 'react-router';
import { motion } from 'motion/react';
import { SwipeButton } from '../shared/SwipeButton';
import { useStartupPage } from '../../../utils/useStartupPage';
import { flashColdWallet, ejectUSB } from '../../../services/usb-flash';
import type { USBDevice, FlashProgress, FlashStep } from '../../../services/usb-flash';

const STEP_INFO: Record<FlashStep, { label: string; icon: typeof Shield; color: string }> = {
  idle: { label: 'Ready', icon: Shield, color: 'white/40' },
  detecting: { label: 'Detecting device', icon: HardDrive, color: 'blue-400' },
  permission: { label: 'Requesting access', icon: Lock, color: 'blue-400' },
  preparing: { label: 'Preparing disk', icon: HardDrive, color: 'blue-400' },
  formatting: { label: 'Formatting (FAT32)', icon: HardDrive, color: 'purple-400' },
  'writing-structure': { label: 'Creating wallet dirs', icon: HardDrive, color: 'purple-400' },
  'generating-keypair': { label: 'Generating Ed25519 key', icon: Key, color: 'amber-400' },
  encrypting: { label: 'Encrypting (Argon2id + AES-256-GCM)', icon: Lock, color: 'amber-400' },
  'writing-wallet': { label: 'Writing to USB', icon: HardDrive, color: 'emerald-400' },
  verifying: { label: 'Verifying integrity', icon: FileCheck, color: 'emerald-400' },
  complete: { label: 'Complete!', icon: CheckCircle2, color: 'emerald-400' },
  error: { label: 'Error', icon: AlertTriangle, color: 'red-400' },
};

const FLASH_STEPS: FlashStep[] = [
  'preparing',
  'formatting',
  'writing-structure',
  'generating-keypair',
  'encrypting',
  'writing-wallet',
  'verifying',
];

export function FirmwareFlash() {
  const [flashState, setFlashState] = useState<FlashStep>('idle');
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [showPinEntry, setShowPinEntry] = useState(true);
  const navigate = useNavigate();
  useStartupPage();

  const handleProgressUpdate = useCallback((update: FlashProgress) => {
    setFlashState(update.step);
    setProgress(update.progress);
    setStatusMessage(update.message);
    if (update.error) {
      setError(update.error);
    }
  }, []);

  const handleStartFlash = async () => {
    // Validate PIN
    if (pin.length < 6) {
      setPinError('PIN must be at least 6 digits');
      return;
    }
    if (pin !== pinConfirm) {
      setPinError('PINs do not match');
      return;
    }
    setPinError(null);
    setShowPinEntry(false);
    setError(null);

    // Get device from session storage
    const deviceStr = sessionStorage.getItem('coldstar_usb_device');
    let device: USBDevice;

    if (deviceStr) {
      device = JSON.parse(deviceStr);
    } else {
      // Fallback: create a simulated device for web development
      device = {
        deviceId: 0,
        vendorId: 0,
        productId: 0,
        deviceName: 'USB Drive',
        manufacturerName: 'Unknown',
        productName: 'USB Mass Storage',
        serialNumber: '',
        devicePath: '',
        storageSize: 0,
        formattedSize: 'Unknown',
      };
    }

    const result = await flashColdWallet(device, pin, 'Coldstar Wallet', handleProgressUpdate);

    if (result.success) {
      setPublicKey(result.publicKey || null);
      // Store the generated public key
      if (result.publicKey) {
        sessionStorage.setItem('coldstar_flash_pubkey', result.publicKey);
      }
      // Store flash PIN so PinSetup can reuse it (no double-prompt)
      sessionStorage.setItem('coldstar_flash_pin', pin);
      // Eject the drive safely
      await ejectUSB(device);
    }
  };

  const currentStepIndex = FLASH_STEPS.indexOf(flashState);

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-between p-6 pb-12 pt-16">
      <div className="flex-1 flex flex-col items-center justify-center max-w-md w-full">
        {/* Header icon — tile never rotates (a spinning rounded rect reads as
            a tumbling blob); active state pulses instead */}
        <motion.div
          animate={
            flashState === 'complete'
              ? { scale: [1, 1.2, 1] }
              : flashState !== 'idle'
              ? { scale: [1, 1.06, 1], opacity: [0.85, 1, 0.85] }
              : {}
          }
          transition={
            flashState === 'complete'
              ? { scale: { duration: 0.5 } }
              : { duration: 1.6, repeat: Infinity, ease: 'easeInOut' }
          }
          className="mb-12"
        >
          {flashState === 'complete' ? (
            <div className="w-32 h-32 rounded-3xl bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center shadow-2xl shadow-emerald-500/50">
              <CheckCircle2 className="w-16 h-16 text-white" />
            </div>
          ) : flashState === 'error' ? (
            <div className="w-32 h-32 rounded-3xl bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center shadow-2xl shadow-red-500/50">
              <AlertTriangle className="w-16 h-16 text-white" />
            </div>
          ) : (
            <div className="w-32 h-32 rounded-3xl bg-gradient-to-br from-white/10 to-white/5 flex items-center justify-center border-4 border-white/20">
              <div className="w-20 h-20 rounded-2xl bg-white/10 border-2 border-white/30 flex items-center justify-center">
                <Shield className="w-10 h-10 text-white/60" />
              </div>
            </div>
          )}
        </motion.div>

        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.5 }}
          className="text-center mb-8 w-full"
        >
          <h1 className="text-3xl font-semibold text-white mb-4">
            {flashState === 'complete' ? 'Cold Wallet Created!' :
             flashState === 'error' ? 'Flash Failed' :
             showPinEntry ? 'Set Wallet PIN' :
             'Flashing Cold Wallet'}
          </h1>
          <p className="text-base text-white/60 leading-relaxed">
            {flashState === 'idle' && showPinEntry
              ? 'This PIN encrypts your private key on the USB drive using Argon2id + AES-256-GCM'
              : flashState === 'error'
              ? error || 'An error occurred during flashing'
              : statusMessage || 'Initializing...'}
          </p>
        </motion.div>

        {/* PIN Entry (before flash starts) */}
        {showPinEntry && flashState === 'idle' && (
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.3, duration: 0.5 }}
            className="w-full space-y-4 mb-8"
          >
            <div>
              <label className="text-sm text-white/60 mb-2 block">Wallet PIN (min 6 digits)</label>
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                value={pin}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, '');
                  setPin(val);
                  setPinError(null);
                }}
                placeholder="Enter PIN"
                maxLength={12}
                className="w-full h-14 rounded-2xl bg-white/5 border border-white/10 text-white text-center text-xl font-mono tracking-[0.5em] px-4 focus:outline-none focus:border-white/30"
              />
            </div>
            <div>
              <label className="text-sm text-white/60 mb-2 block">Confirm PIN</label>
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                value={pinConfirm}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, '');
                  setPinConfirm(val);
                  setPinError(null);
                }}
                placeholder="Confirm PIN"
                maxLength={12}
                className="w-full h-14 rounded-2xl bg-white/5 border border-white/10 text-white text-center text-xl font-mono tracking-[0.5em] px-4 focus:outline-none focus:border-white/30"
              />
            </div>
            {pinError && (
              <p className="text-red-400 text-sm text-center">{pinError}</p>
            )}

            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 mt-4">
              <p className="text-xs text-white/50 leading-relaxed">
                <strong className="text-amber-400">Security: </strong>
                Your PIN will be used to derive an AES-256 encryption key via Argon2id 
                (64 MB memory-hard, 3 iterations). The private key is generated and 
                encrypted entirely in secure Rust memory — it never enters JavaScript.
              </p>
            </div>
          </motion.div>
        )}

        {/* Progress bar */}
        {!showPinEntry && flashState !== 'idle' && (
          <div className="w-full space-y-3 mb-8">
            <div className="relative w-full h-2 bg-white/10 rounded-full overflow-hidden">
              <motion.div
                className={`absolute inset-y-0 left-0 rounded-full ${
                  flashState === 'error'
                    ? 'bg-gradient-to-r from-red-500 to-red-400'
                    : flashState === 'complete'
                    ? 'bg-gradient-to-r from-emerald-500 to-green-400'
                    : 'bg-gradient-to-r from-white to-gray-300'
                }`}
                initial={{ width: 0 }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-white/60">{statusMessage}</span>
              <span className="text-white font-medium">{Math.round(progress)}%</span>
            </div>
          </div>
        )}

        {/* Step indicators */}
        {!showPinEntry && flashState !== 'idle' && flashState !== 'complete' && flashState !== 'error' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-2 w-full"
          >
            {FLASH_STEPS.map((step, i) => {
              const info = STEP_INFO[step];
              const isActive = step === flashState;
              const isDone = currentStepIndex > i;
              const Icon = info.icon;

              return (
                <div
                  key={step}
                  className={`flex items-center gap-3 p-3 rounded-xl transition-all duration-300 ${
                    isActive
                      ? 'bg-white/10 border border-white/20'
                      : isDone
                      ? 'bg-white/5 border border-white/5'
                      : 'bg-white/[0.02] border border-transparent'
                  }`}
                >
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center ${
                    isDone ? 'bg-emerald-500/20' :
                    isActive ? 'bg-white/20' : 'bg-white/5'
                  }`}>
                    {isDone ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <Icon className={`w-3 h-3 ${
                        isActive ? 'text-white' : 'text-white/30'
                      }`} />
                    )}
                  </div>
                  <span className={`text-sm ${
                    isActive ? 'text-white font-medium' :
                    isDone ? 'text-emerald-400/70' : 'text-white/30'
                  }`}>
                    {info.label}
                  </span>
                  {isActive && (
                    <motion.div
                      className="ml-auto w-2 h-2 rounded-full bg-white"
                      animate={{ opacity: [1, 0.3, 1] }}
                      transition={{ duration: 1, repeat: Infinity }}
                    />
                  )}
                </div>
              );
            })}
          </motion.div>
        )}

        {/* Success card with public key */}
        {flashState === 'complete' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-full space-y-4"
          >
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-4">
              <p className="text-sm text-emerald-400 text-center mb-3">
                Cold wallet created and encrypted on USB!
              </p>
              {publicKey && (
                <div className="bg-black/30 rounded-xl p-3">
                  <p className="text-xs text-white/40 mb-1">Wallet Address</p>
                  <p className="text-xs text-white font-mono break-all leading-relaxed">
                    {publicKey}
                  </p>
                </div>
              )}
            </div>

            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 space-y-2">
              <p className="text-xs text-amber-400 font-medium">USB Directory Structure</p>
              <div className="font-mono text-xs text-white/50 space-y-1">
                <p>📁 wallet/</p>
                <p>  ├── 🔒 keypair.json <span className="text-emerald-400/60">(encrypted)</span></p>
                <p>  └── 📄 pubkey.txt</p>
                <p>📁 inbox/ <span className="text-white/30">(unsigned tx)</span></p>
                <p>📁 outbox/ <span className="text-white/30">(signed tx)</span></p>
                <p>📁 .coldstar/</p>
                <p>  └── 📁 backup/</p>
              </div>
            </div>

            <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4">
              <p className="text-xs text-amber-400 leading-relaxed">
                <strong>Important:</strong> Remove the USB drive safely. Store it in a secure 
                location. Never connect to internet-connected computers for signing.
              </p>
            </div>
          </motion.div>
        )}

        {/* Error retry */}
        {flashState === 'error' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-full bg-red-500/10 border border-red-500/30 rounded-2xl p-4"
          >
            <p className="text-sm text-red-400 text-center">
              {error || 'An unexpected error occurred'}
            </p>
          </motion.div>
        )}
      </div>

      {/* Bottom actions */}
      <div className="w-full max-w-md">
        {showPinEntry && flashState === 'idle' ? (
          <SwipeButton onComplete={handleStartFlash} text="Swipe to flash cold wallet" />
        ) : flashState === 'complete' ? (
          <button
            onClick={() => navigate('/onboarding/pin-setup')}
            className="w-full h-14 rounded-2xl bg-white text-black font-bold text-base shadow-xl active:scale-95 transition-transform"
          >
            Continue
          </button>
        ) : flashState === 'error' ? (
          <button
            onClick={() => {
              setFlashState('idle');
              setShowPinEntry(true);
              setError(null);
              setProgress(0);
            }}
            className="w-full h-14 rounded-2xl bg-white/10 text-white font-semibold text-base active:scale-95 transition-transform"
          >
            Try Again
          </button>
        ) : null}
      </div>
    </div>
  );
}