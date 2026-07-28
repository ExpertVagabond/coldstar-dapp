import { useState, useEffect, useCallback, useRef } from 'react';
import {
  CheckCircle2, Shield, AlertTriangle, Key, HardDrive,
  Lock, FileCheck, Usb, WifiOff,
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import { SwipeButton } from '../shared/SwipeButton';
import { useStartupPage } from '../../../utils/useStartupPage';
import {
  detectUSBDevices,
  requestUSBPermission,
  checkExistingWallet,
  flashColdWallet,
  ejectUSB,
} from '../../../services/usb-flash';
import type { USBDevice, FlashProgress, FlashStep } from '../../../services/usb-flash';
import { dlog } from '../../../services/debug-log';
import { hasWallet, addToWalletRegistry, registerUSBWallet, verifyUSBWalletPin } from '../../../services/wallet';
import logoImg from '../../../imports/Connected-1.png';

// ─── Phase type ───
type Phase = 'scanning' | 'detected' | 'pin-entry' | 'flashing' | 'complete' | 'error';

// ─── Flash step metadata ───
const STEP_INFO: Record<FlashStep, { label: string; icon: typeof Shield }> = {
  idle: { label: 'Ready', icon: Shield },
  detecting: { label: 'Detecting device', icon: HardDrive },
  permission: { label: 'Requesting access', icon: Lock },
  preparing: { label: 'Preparing disk', icon: HardDrive },
  formatting: { label: 'Formatting (FAT32)', icon: HardDrive },
  'writing-structure': { label: 'Creating wallet dirs', icon: HardDrive },
  'generating-keypair': { label: 'Generating Ed25519 key', icon: Key },
  encrypting: { label: 'Encrypting (Argon2id + AES-256-GCM)', icon: Lock },
  'writing-wallet': { label: 'Writing to USB', icon: HardDrive },
  verifying: { label: 'Verifying integrity', icon: FileCheck },
  complete: { label: 'Complete!', icon: CheckCircle2 },
  error: { label: 'Error', icon: AlertTriangle },
};

const FLASH_STEPS: FlashStep[] = [
  'preparing', 'formatting', 'writing-structure',
  'generating-keypair', 'encrypting', 'writing-wallet', 'verifying',
];

export function StartupFlash() {
  // ─── State ───
  const [phase, setPhase] = useState<Phase>('scanning');
  const [device, setDevice] = useState<USBDevice | null>(null);
  const [hasExisting, setHasExisting] = useState(false);
  const [existingPubkey, setExistingPubkey] = useState<string | null>(null);

  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  const [flashStep, setFlashStep] = useState<FlashStep>('idle');
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scanRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const navigate = useNavigate();
  useStartupPage();

  // ─── Redirect to /app if wallet already exists (unless creating additional wallet) ───
  useEffect(() => {
    const isCreatingNew = sessionStorage.getItem('coldstar_creating_new_wallet') === 'true';
    if (hasWallet() && !isCreatingNew) {
      navigate('/app', { replace: true });
    }
  }, [navigate]);

  // ─── Auto-scan for USB devices on mount ───
  const scanForDevices = useCallback(async () => {
    if (phase !== 'scanning') return;
    try {
      dlog.debug('StartupFlash', 'Scanning for USB devices…');
      const found = await detectUSBDevices();
      dlog.debug('StartupFlash', `Scan result: ${found.length} device(s)`);
      if (found.length > 0) {
        const selected = found[0]; // Auto-select first device
        dlog.info('StartupFlash', `Device selected: ${selected.deviceName} (id=${selected.deviceId})`);
        setDevice(selected);
        setPhase('detected');

        // Auto-request permission
        const granted = await requestUSBPermission(selected);
        dlog.info('StartupFlash', `Permission granted: ${granted}`);
        if (granted) {
          // Check for existing wallet
          const existing = await checkExistingWallet(selected);
          if (existing.hasWallet) {
            setHasExisting(true);
            setExistingPubkey(existing.publicKey || null);
          }
          sessionStorage.setItem('coldstar_usb_device', JSON.stringify(selected));
          setPhase('pin-entry');
        } else {
          // Permission denied — keep polling
          setPhase('scanning');
          setDevice(null);
        }
      }
    } catch (err) {
      dlog.error('StartupFlash', 'scanForDevices error', { error: String(err) });
      // Silently retry on next poll
    }
  }, [phase]);

  useEffect(() => {
    // Start polling immediately
    scanForDevices();
    scanRef.current = setInterval(scanForDevices, 2000);
    return () => {
      if (scanRef.current) clearInterval(scanRef.current);
    };
  }, [scanForDevices]);

  // Stop polling once we leave scanning phase
  useEffect(() => {
    if (phase !== 'scanning' && scanRef.current) {
      clearInterval(scanRef.current);
      scanRef.current = null;
    }
  }, [phase]);

  // ─── Flash progress callback ───
  const handleProgressUpdate = useCallback((update: FlashProgress) => {
    dlog.info('StartupFlash', `Progress: [${update.step}] ${update.progress}% — ${update.message}${update.error ? ' ERROR: ' + update.error : ''}`);
    setFlashStep(update.step);
    setProgress(update.progress);
    setStatusMessage(update.message);
    if (update.error) {
      setError(update.error);
      setPhase('error');
    }
  }, []);

  // ─── Unlock existing wallet on USB ───
  const handleUnlockExisting = async () => {
    if (!device) return;

    if (pin.length < 6) {
      setPinError('PIN must be at least 6 digits');
      return;
    }
    setPinError(null);

    try {
      dlog.info('StartupFlash', 'handleUnlockExisting — verifying PIN against USB wallet');
      const pubkey = await verifyUSBWalletPin(device, pin);
      dlog.info('StartupFlash', `PIN verified — pubkey: ${pubkey.slice(0, 8)}…`);

      // Register this wallet locally and store the PIN
      await registerUSBWallet(pubkey, 'Hardware Wallet', pin);
      setPublicKey(pubkey);
      sessionStorage.setItem('coldstar_flash_pubkey', pubkey);
      sessionStorage.setItem('coldstar_flash_pin', pin);
      sessionStorage.removeItem('coldstar_creating_new_wallet');
      setPhase('complete');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Decryption failed';
      dlog.error('StartupFlash', `Unlock failed: ${msg}`);
      setPinError('Wrong PIN — could not decrypt wallet');
    }
  };

  // ─── Start flash ───
  const handleStartFlash = async () => {
    if (!device) return;

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
    setPhase('flashing');
    setError(null);

    dlog.info('StartupFlash', 'handleStartFlash — beginning flash');
    const result = await flashColdWallet(device, pin, 'Coldstar Wallet', handleProgressUpdate);
    dlog.info('StartupFlash', `Flash result: success=${result.success}${result.error ? ', error=' + result.error : ''}`);

    if (result.success) {
      setPublicKey(result.publicKey || null);
      if (result.publicKey) {
        sessionStorage.setItem('coldstar_flash_pubkey', result.publicKey);
        // Register this hardware wallet in the persistent registry
        addToWalletRegistry({
          publicKey: result.publicKey,
          label: 'Hardware Wallet',
          createdAt: Date.now(),
          network: 'devnet',
        });
      }
      // Clear the "creating new wallet" flag
      sessionStorage.removeItem('coldstar_creating_new_wallet');
      // Store flash PIN so PinSetup can reuse it (no double-prompt)
      sessionStorage.setItem('coldstar_flash_pin', pin);
      await ejectUSB(device);
      setPhase('complete');
    }
  };

  // ─── Retry after error ───
  const handleRetry = () => {
    setPhase('scanning');
    setDevice(null);
    setFlashStep('idle');
    setProgress(0);
    setError(null);
    setPin('');
    setPinConfirm('');
    setPinError(null);
    setHasExisting(false);
    setExistingPubkey(null);
  };

  const currentStepIndex = FLASH_STEPS.indexOf(flashStep);

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-between p-6 pb-12 pt-16">
      <div className="flex-1 flex flex-col items-center justify-center max-w-md w-full">
        <AnimatePresence mode="wait">
          {/* ═══════════════════════════════════════════════
              PHASE: SCANNING — waiting for USB
          ═══════════════════════════════════════════════ */}
          {phase === 'scanning' && (
            <motion.div
              key="scanning"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, y: -20 }}
              className="flex flex-col items-center w-full"
            >
              {/* Logo */}
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.5 }}
                className="mb-8"
              >
                <img src={logoImg} alt="Coldstar" className="h-20" />
              </motion.div>

              {/* Pulsing USB icon */}
              <motion.div
                className="w-32 h-32 rounded-3xl bg-white/5 border-2 border-dashed border-white/20 flex items-center justify-center mb-10"
                animate={{ borderColor: ['rgba(255,255,255,0.2)', 'rgba(255,255,255,0.4)', 'rgba(255,255,255,0.2)'] }}
                transition={{ duration: 2, repeat: Infinity }}
              >
                <motion.div
                  animate={{ y: [0, -4, 0] }}
                  transition={{ duration: 1.5, repeat: Infinity }}
                >
                  <Usb className="w-14 h-14 text-white/40" />
                </motion.div>
              </motion.div>

              <h1 className="text-3xl font-semibold text-white mb-3 text-center">
                Coldstar
              </h1>
              <p className="text-base text-white/50 leading-relaxed text-center mb-8">
                Waiting for USB drive...
              </p>

              {/* Scanning indicator */}
              <div className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-2xl px-5 py-3">
                <motion.div
                  className="w-2 h-2 rounded-full bg-blue-400"
                  animate={{ scale: [1, 1.4, 1], opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 1.2, repeat: Infinity }}
                />
                <span className="text-sm text-white/60">Scanning for USB devices</span>
              </div>

              {/* Tips */}
              <div className="mt-8 space-y-2 w-full">
                <div className="flex items-center gap-3 px-4 py-2">
                  <WifiOff className="w-4 h-4 text-white/30 flex-shrink-0" />
                  <span className="text-xs text-white/40">
                    Connect a USB drive via OTG to create your cold wallet
                  </span>
                </div>
                <div className="flex items-center gap-3 px-4 py-2">
                  <Shield className="w-4 h-4 text-white/30 flex-shrink-0" />
                  <span className="text-xs text-white/40">
                    Use a dedicated drive — all data will be erased
                  </span>
                </div>
              </div>
            </motion.div>
          )}

          {/* ═══════════════════════════════════════════════
              PHASE: DETECTED — briefly showing device info
          ═══════════════════════════════════════════════ */}
          {phase === 'detected' && device && (
            <motion.div
              key="detected"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, y: -20 }}
              className="flex flex-col items-center w-full"
            >
              <motion.div
                className="w-32 h-32 rounded-3xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 border-2 border-blue-500/40 flex items-center justify-center mb-10"
                animate={{ scale: [1, 1.05, 1] }}
                transition={{ duration: 1, repeat: Infinity }}
              >
                <Usb className="w-14 h-14 text-blue-400" />
              </motion.div>

              <h1 className="text-2xl font-semibold text-white mb-2 text-center">
                USB Drive Detected
              </h1>
              <p className="text-sm text-white/50 mb-4 text-center">
                {device.productName || device.deviceName}
                {device.formattedSize !== '0 B' ? ` · ${device.formattedSize}` : ''}
              </p>

              <div className="flex items-center gap-2 text-blue-400">
                <motion.div
                  className="w-2 h-2 rounded-full bg-blue-400"
                  animate={{ scale: [1, 1.3, 1], opacity: [1, 0.6, 1] }}
                  transition={{ duration: 0.8, repeat: Infinity }}
                />
                <span className="text-sm">Requesting access...</span>
              </div>
            </motion.div>
          )}

          {/* ═══════════════════════════════════════════════
              PHASE: PIN ENTRY
          ═══════════════════════════════════════════════ */}
          {phase === 'pin-entry' && device && (
            <motion.div
              key="pin-entry"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="flex flex-col items-center w-full"
            >
              {/* Device chip */}
              <div className="flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/30 rounded-full px-4 py-2 mb-8">
                <div className="w-2 h-2 rounded-full bg-emerald-400" />
                <span className="text-xs text-emerald-400 font-medium">
                  {device.productName || 'USB Drive'} connected
                </span>
              </div>

              <div className="w-20 h-20 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mb-8">
                <Lock className="w-10 h-10 text-white/50" />
              </div>

              {hasExisting ? (
                /* ── Existing wallet: single PIN entry to unlock ── */
                <>
                  <h1 className="text-2xl font-semibold text-white mb-2 text-center">
                    Unlock Wallet
                  </h1>
                  <p className="text-sm text-white/50 leading-relaxed text-center mb-6 max-w-xs">
                    A wallet was found on this drive. Enter the PIN used to encrypt it.
                  </p>

                  {/* Wallet address badge */}
                  {existingPubkey && (
                    <div className="w-full bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-4 mb-6">
                      <p className="text-xs text-emerald-400/70 mb-1">Wallet Address</p>
                      <p className="text-xs text-white font-mono">
                        {existingPubkey.slice(0, 8)}...{existingPubkey.slice(-8)}
                      </p>
                    </div>
                  )}

                  {/* Single PIN input */}
                  <div className="w-full space-y-4 mb-6">
                    <div>
                      <label className="text-sm text-white/60 mb-2 block">
                        Wallet PIN
                      </label>
                      <input
                        type="password"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={pin}
                        onChange={(e) => {
                          setPin(e.target.value.replace(/\D/g, ''));
                          setPinError(null);
                        }}
                        placeholder="Enter PIN"
                        maxLength={12}
                        className="w-full h-14 rounded-2xl bg-white/5 border border-white/10 text-white text-center text-xl font-mono tracking-[0.5em] px-4 focus:outline-none focus:border-white/30"
                      />
                    </div>
                    {pinError && (
                      <p className="text-red-400 text-sm text-center">{pinError}</p>
                    )}
                  </div>

                  <div className="bg-white/5 border border-white/10 rounded-2xl p-4 w-full mb-4">
                    <p className="text-xs text-white/50 leading-relaxed">
                      <strong className="text-emerald-400">Existing Wallet: </strong>
                      Your PIN will be used to decrypt and verify the wallet on this drive.
                    </p>
                  </div>

                  {/* Option to flash new wallet instead */}
                  <button
                    onClick={() => { setHasExisting(false); setPin(''); setPinError(null); }}
                    className="text-xs text-white/40 underline mt-2"
                  >
                    Erase and create a new wallet instead
                  </button>
                </>
              ) : (
                /* ── New wallet: PIN create + confirm ── */
                <>
                  <h1 className="text-2xl font-semibold text-white mb-2 text-center">
                    Set Wallet PIN
                  </h1>
                  <p className="text-sm text-white/50 leading-relaxed text-center mb-8 max-w-xs">
                    This PIN encrypts your keys on the USB drive
                  </p>

                  {/* PIN inputs */}
                  <div className="w-full space-y-4 mb-6">
                    <div>
                      <label className="text-sm text-white/60 mb-2 block">
                        Wallet PIN (min 6 digits)
                      </label>
                      <input
                        type="password"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={pin}
                        onChange={(e) => {
                          setPin(e.target.value.replace(/\D/g, ''));
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
                          setPinConfirm(e.target.value.replace(/\D/g, ''));
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
                  </div>

                  <div className="bg-white/5 border border-white/10 rounded-2xl p-4 w-full mb-4">
                    <p className="text-xs text-white/50 leading-relaxed">
                      <strong className="text-amber-400">Security: </strong>
                      Your PIN derives an AES-256 key via Argon2id (64 MB memory-hard, 3 iterations).
                      The private key is generated and encrypted entirely in secure Rust memory.
                    </p>
                  </div>
                </>
              )}
            </motion.div>
          )}

          {/* ═══════════════════════════════════════════════
              PHASE: FLASHING
          ═══════════════════════════════════════════════ */}
          {phase === 'flashing' && (
            <motion.div
              key="flashing"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center w-full"
            >
              {/* Pulsing shield — tile stays static (a rotating rounded rect
                  reads as a tumbling blob, especially at low frame rates) */}
              <div className="mb-10 w-28 h-28 rounded-3xl bg-gradient-to-br from-white/10 to-white/5 flex items-center justify-center border-4 border-white/20">
                <motion.div
                  animate={{ scale: [1, 1.12, 1], opacity: [0.6, 1, 0.6] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
                >
                  <Shield className="w-12 h-12 text-white/60" />
                </motion.div>
              </div>

              <h1 className="text-2xl font-semibold text-white mb-2 text-center">
                Flashing Cold Wallet
              </h1>
              <p className="text-sm text-white/50 mb-6 text-center">
                {statusMessage || 'Starting...'}
              </p>

              {/* Progress bar */}
              <div className="w-full space-y-2 mb-8">
                <div className="relative w-full h-2 bg-white/10 rounded-full overflow-hidden">
                  <motion.div
                    className="absolute inset-y-0 left-0 bg-gradient-to-r from-white to-gray-300 rounded-full"
                    animate={{ width: `${progress}%` }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-white/50 text-xs">{statusMessage}</span>
                  <span className="text-white font-medium text-xs">{Math.round(progress)}%</span>
                </div>
              </div>

              {/* Step list */}
              <div className="space-y-1.5 w-full">
                {FLASH_STEPS.map((step, i) => {
                  const info = STEP_INFO[step];
                  const isActive = step === flashStep;
                  const isDone = currentStepIndex > i;
                  const Icon = info.icon;

                  return (
                    <div
                      key={step}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-300 ${
                        isActive
                          ? 'bg-white/10 border border-white/20'
                          : isDone
                          ? 'bg-white/[0.03] border border-transparent'
                          : 'border border-transparent'
                      }`}
                    >
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center ${
                        isDone ? 'bg-emerald-500/20' :
                        isActive ? 'bg-white/20' : 'bg-white/5'
                      }`}>
                        {isDone ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Icon className={`w-2.5 h-2.5 ${
                            isActive ? 'text-white' : 'text-white/20'
                          }`} />
                        )}
                      </div>
                      <span className={`text-xs ${
                        isActive ? 'text-white font-medium' :
                        isDone ? 'text-emerald-400/60' : 'text-white/25'
                      }`}>
                        {info.label}
                      </span>
                      {isActive && (
                        <motion.div
                          className="ml-auto w-1.5 h-1.5 rounded-full bg-white"
                          animate={{ opacity: [1, 0.3, 1] }}
                          transition={{ duration: 1, repeat: Infinity }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}

          {/* ═══════════════════════════════════════════════
              PHASE: COMPLETE
          ═══════════════════════════════════════════════ */}
          {phase === 'complete' && (
            <motion.div
              key="complete"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center w-full"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: [0, 1.2, 1] }}
                transition={{ duration: 0.6 }}
                className="w-28 h-28 rounded-3xl bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center shadow-2xl shadow-emerald-500/50 mb-8"
              >
                <CheckCircle2 className="w-14 h-14 text-white" />
              </motion.div>

              <h1 className="text-2xl font-semibold text-white mb-2 text-center">
                Cold Wallet Created!
              </h1>
              <p className="text-sm text-white/50 mb-6 text-center">
                Your wallet is encrypted and written to USB
              </p>

              {/* Public key card */}
              {publicKey && (
                <div className="w-full bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-4 mb-4">
                  <p className="text-xs text-emerald-400/70 mb-1">Wallet Address</p>
                  <p className="text-xs text-white font-mono break-all leading-relaxed">
                    {publicKey}
                  </p>
                </div>
              )}

              {/* Directory structure */}
              <div className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 mb-4 space-y-1">
                <p className="text-xs text-amber-400 font-medium mb-2">USB Directory</p>
                <div className="font-mono text-xs text-white/50 space-y-0.5">
                  <p>📁 wallet/</p>
                  <p>  ├── 🔒 keypair.json <span className="text-emerald-400/60">(encrypted)</span></p>
                  <p>  └── 📄 pubkey.txt</p>
                  <p>📁 inbox/</p>
                  <p>📁 outbox/</p>
                  <p>📁 .coldstar/backup/</p>
                </div>
              </div>

              <div className="w-full bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4">
                <p className="text-xs text-amber-400 leading-relaxed">
                  <strong>Important:</strong> Remove the USB drive safely. Store it in a secure
                  location. Never connect to internet-connected computers for signing.
                </p>
              </div>
            </motion.div>
          )}

          {/* ═══════════════════════════════════════════════
              PHASE: ERROR
          ═══════════════════════════════════════════════ */}
          {phase === 'error' && (
            <motion.div
              key="error"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center w-full"
            >
              <div className="w-28 h-28 rounded-3xl bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center shadow-2xl shadow-red-500/50 mb-8">
                <AlertTriangle className="w-14 h-14 text-white" />
              </div>

              <h1 className="text-2xl font-semibold text-white mb-2 text-center">
                Flash Failed
              </h1>
              <p className="text-sm text-red-400/80 text-center mb-6">
                {error || 'An unexpected error occurred'}
              </p>

              <div className="w-full bg-red-500/10 border border-red-500/30 rounded-2xl p-4">
                <p className="text-xs text-red-400/70 leading-relaxed">
                  Make sure the USB drive is properly connected and try again.
                  If the issue persists, try a different USB drive.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ─── Bottom actions ─── */}
      <div className="w-full max-w-md">
        {phase === 'pin-entry' && hasExisting && (
          <SwipeButton onComplete={handleUnlockExisting} text="Swipe to unlock wallet" />
        )}
        {phase === 'pin-entry' && !hasExisting && (
          <SwipeButton onComplete={handleStartFlash} text="Swipe to flash cold wallet" />
        )}
        {phase === 'complete' && (
          <button
            onClick={() => navigate('/onboarding/pin-setup')}
            className="w-full h-14 rounded-2xl bg-white text-black font-bold text-base shadow-xl active:scale-95 transition-transform"
          >
            Continue
          </button>
        )}
        {phase === 'error' && (
          <button
            onClick={handleRetry}
            className="w-full h-14 rounded-2xl bg-white/10 text-white font-semibold text-base active:scale-95 transition-transform"
          >
            Try Again
          </button>
        )}
      </div>
    </div>
  );
}
