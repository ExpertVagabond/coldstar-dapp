import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router';
import { motion } from 'motion/react';
import {
  Fingerprint, Usb, CheckCircle2, AlertTriangle, Shield, HardDrive,
  FileCheck, ArrowLeft, ArrowRightLeft, Lock,
} from 'lucide-react';
import { SwipeButton } from '../shared/SwipeButton';
import {
  detectUSBDevices, readAllWalletFiles, writeWalletSnapshot, ejectUSB,
} from '../../../services/usb-flash';
import type { USBDevice, USBWalletSnapshot, BackupProgress, BackupStep } from '../../../services/usb-flash';
import { verifyPinFromKeypairJson } from '../../../services/wallet';
import { isBiometricAvailable, authenticateWithBiometric } from '../../../services/biometric';
import { getWalletPassphrase } from '../../../services/wallet';
import { hapticSuccess, hapticError } from '../../../utils/mobile';

type Stage =
  | 'biometric'
  | 'plug-source'
  | 'reading'
  | 'swap-usb'
  | 'pin-verify'
  | 'writing'
  | 'complete';

const WRITE_STEPS: BackupStep[] = [
  'preparing-target',
  'formatting',
  'writing-structure',
  'writing-wallet',
  'verifying',
];

const STEP_LABELS: Record<BackupStep, { label: string; icon: typeof Shield }> = {
  'idle': { label: 'Ready', icon: Shield },
  'reading-source': { label: 'Reading source wallet', icon: HardDrive },
  'waiting-for-target': { label: 'Waiting for target USB', icon: Usb },
  'preparing-target': { label: 'Preparing target disk', icon: HardDrive },
  'formatting': { label: 'Formatting (FAT32)', icon: HardDrive },
  'writing-structure': { label: 'Creating wallet dirs', icon: HardDrive },
  'writing-wallet': { label: 'Writing wallet files', icon: Lock },
  'verifying': { label: 'Verifying integrity', icon: FileCheck },
  'complete': { label: 'Complete!', icon: CheckCircle2 },
  'error': { label: 'Error', icon: AlertTriangle },
};

export function BackupWallet() {
  const navigate = useNavigate();

  // Flow stage
  const [stage, setStage] = useState<Stage>('biometric');

  // Biometric
  const [bioError, setBioError] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  // USB detection
  const [sourceDevice, setSourceDevice] = useState<USBDevice | null>(null);
  const [targetDevice, setTargetDevice] = useState<USBDevice | null>(null);
  const [detecting, setDetecting] = useState(false);

  // Snapshot (in-memory only — never persisted)
  const snapshotRef = useRef<USBWalletSnapshot | null>(null);
  const [snapshotPubkey, setSnapshotPubkey] = useState<string | null>(null);

  // Reading state
  const [readError, setReadError] = useState<string | null>(null);

  // PIN verification
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinVerifying, setPinVerifying] = useState(false);

  // Write progress
  const [writeStep, setWriteStep] = useState<BackupStep>('idle');
  const [writeProgress, setWriteProgress] = useState(0);
  const [writeMessage, setWriteMessage] = useState('');
  const [writeError, setWriteError] = useState<string | null>(null);

  // Cleanup snapshot from memory on unmount
  useEffect(() => {
    return () => {
      snapshotRef.current = null;
    };
  }, []);

  // ─── Stage 1: Biometric ───

  const triggerBiometric = useCallback(async () => {
    if (isAuthenticating) return;
    setIsAuthenticating(true);
    setBioError('');

    try {
      const available = await isBiometricAvailable();
      if (!available) {
        // Fallback: if biometric not available, check passphrase exists
        const passphrase = getWalletPassphrase();
        if (passphrase) {
          hapticSuccess();
          setStage('plug-source');
        } else {
          setBioError('No wallet passphrase found');
        }
        setIsAuthenticating(false);
        return;
      }

      const success = await authenticateWithBiometric();
      if (success) {
        hapticSuccess();
        setStage('plug-source');
      } else {
        hapticError();
        setBioError('Authentication failed. Tap to try again.');
      }
    } catch {
      hapticError();
      setBioError('Authentication failed. Tap to try again.');
    } finally {
      setIsAuthenticating(false);
    }
  }, [isAuthenticating]);

  // Auto-trigger biometric on mount
  useEffect(() => {
    if (stage === 'biometric') {
      triggerBiometric();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Stage 2: Detect source USB ───

  useEffect(() => {
    if (stage !== 'plug-source' && stage !== 'swap-usb') return;

    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      setDetecting(true);
      const devices = await detectUSBDevices();
      if (cancelled) return;
      setDetecting(false);

      if (devices.length > 0) {
        if (stage === 'plug-source') {
          setSourceDevice(devices[0]);
        } else if (stage === 'swap-usb') {
          // Accept any detected device as the target
          setTargetDevice(devices[0]);
        }
      } else {
        if (stage === 'plug-source') setSourceDevice(null);
        if (stage === 'swap-usb') setTargetDevice(null);
      }
    };

    poll();
    const interval = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [stage]);

  // ─── Stage 3: Read from source ───

  const handleReadSource = useCallback(async () => {
    if (!sourceDevice) return;
    setStage('reading');
    setReadError(null);

    const snapshot = await readAllWalletFiles(sourceDevice);
    if (!snapshot) {
      setReadError('No wallet found on USB drive. Make sure you plugged in the correct device.');
      setStage('plug-source');
      return;
    }

    snapshotRef.current = snapshot;
    setSnapshotPubkey(snapshot.pubkeyTxt);
    hapticSuccess();
    setStage('swap-usb');
  }, [sourceDevice]);

  // ─── Stage 5: PIN verification ───

  const handlePinVerify = useCallback(async () => {
    if (pin.length < 6) {
      setPinError('PIN must be at least 6 digits');
      return;
    }
    if (!snapshotRef.current) {
      setPinError('No wallet data in memory — please restart backup');
      return;
    }

    setPinVerifying(true);
    setPinError(null);

    try {
      await verifyPinFromKeypairJson(snapshotRef.current.keypairJson, pin);
      hapticSuccess();
      setStage('writing');
      handleWrite();
    } catch {
      hapticError();
      setPinError('Wrong PIN. Please try again.');
    } finally {
      setPinVerifying(false);
    }
  }, [pin]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Stage 6: Write to target ───

  const handleProgressUpdate = useCallback((update: BackupProgress) => {
    setWriteStep(update.step);
    setWriteProgress(update.progress);
    setWriteMessage(update.message);
    if (update.error) setWriteError(update.error);
  }, []);

  const handleWrite = useCallback(async () => {
    if (!targetDevice || !snapshotRef.current) return;
    setWriteError(null);
    setWriteStep('preparing-target');

    const success = await writeWalletSnapshot(targetDevice, snapshotRef.current, handleProgressUpdate);
    if (success) {
      hapticSuccess();
      // Clear sensitive data from memory now that write is verified
      snapshotRef.current = null;
      setStage('complete');
      await ejectUSB(targetDevice);
    }
  }, [targetDevice, handleProgressUpdate]);

  const handleGoHome = () => navigate('/app');

  const currentWriteStepIndex = WRITE_STEPS.indexOf(writeStep);

  // ─── Render ───

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-between p-6 pb-12 pt-16">
      <div className="flex-1 flex flex-col items-center justify-center max-w-md w-full">

        {/* Header icon — tile never rotates (a spinning rounded rect reads as
            a tumbling blob); active states pulse instead */}
        <motion.div
          animate={
            stage === 'complete'
              ? { scale: [1, 1.2, 1] }
              : stage === 'reading' || stage === 'writing'
              ? { scale: [1, 1.06, 1], opacity: [0.85, 1, 0.85] }
              : {}
          }
          transition={
            stage === 'complete'
              ? { scale: { duration: 0.5 } }
              : { duration: 1.6, repeat: Infinity, ease: 'easeInOut' }
          }
          className="mb-12"
        >
          {stage === 'complete' ? (
            <div className="w-32 h-32 rounded-3xl bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center shadow-2xl shadow-emerald-500/50">
              <CheckCircle2 className="w-16 h-16 text-white" />
            </div>
          ) : writeError ? (
            <div className="w-32 h-32 rounded-3xl bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center shadow-2xl shadow-red-500/50">
              <AlertTriangle className="w-16 h-16 text-white" />
            </div>
          ) : stage === 'biometric' ? (
            <div className="w-32 h-32 rounded-3xl bg-gradient-to-br from-white/10 to-white/5 flex items-center justify-center border-4 border-white/20">
              <Fingerprint className="w-16 h-16 text-white/60" />
            </div>
          ) : stage === 'swap-usb' ? (
            <div className="w-32 h-32 rounded-3xl bg-gradient-to-br from-amber-500/20 to-amber-600/10 flex items-center justify-center border-4 border-amber-400/30">
              <ArrowRightLeft className="w-14 h-14 text-amber-400" />
            </div>
          ) : stage === 'pin-verify' ? (
            <div className="w-32 h-32 rounded-3xl bg-gradient-to-br from-white/10 to-white/5 flex items-center justify-center border-4 border-white/20">
              <Lock className="w-14 h-14 text-white/60" />
            </div>
          ) : (
            <div className="w-32 h-32 rounded-3xl bg-gradient-to-br from-white/10 to-white/5 flex items-center justify-center border-4 border-white/20">
              <div className="w-20 h-20 rounded-2xl bg-white/10 border-2 border-white/30 flex items-center justify-center">
                <Shield className="w-10 h-10 text-white/60" />
              </div>
            </div>
          )}
        </motion.div>

        {/* Title + Description */}
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.5 }}
          className="text-center mb-8 w-full"
        >
          <h1 className="text-3xl font-semibold text-white mb-4">
            {stage === 'biometric' ? 'Authenticate' :
             stage === 'plug-source' ? 'Plug In Source USB' :
             stage === 'reading' ? 'Reading Wallet...' :
             stage === 'swap-usb' ? 'Swap USB Drive' :
             stage === 'pin-verify' ? 'Verify Wallet PIN' :
             stage === 'writing' && writeError ? 'Backup Failed' :
             stage === 'writing' ? 'Writing Backup...' :
             'Backup Complete!'}
          </h1>
          <p className="text-base text-white/60 leading-relaxed">
            {stage === 'biometric'
              ? 'Scan your fingerprint to authorise this backup'
              : stage === 'plug-source'
              ? 'Connect the USB drive containing the wallet you want to backup'
              : stage === 'reading'
              ? 'Reading wallet files from USB drive...'
              : stage === 'swap-usb'
              ? 'Unplug the source USB and plug in a fresh USB drive for the backup'
              : stage === 'pin-verify'
              ? 'Enter the PIN for this wallet to confirm you are the owner'
              : stage === 'writing' && writeError
              ? writeError
              : stage === 'writing'
              ? writeMessage || 'Writing to target USB...'
              : 'Your wallet has been successfully duplicated to the new USB drive'}
          </p>
        </motion.div>

        {/* ─── Stage: Biometric ─── */}
        {stage === 'biometric' && (
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="w-full flex flex-col items-center"
          >
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

            {!isAuthenticating && !bioError && (
              <p className="text-xs text-white/40 text-center">Tap the fingerprint icon to authenticate</p>
            )}
            {bioError && (
              <motion.p initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="text-sm text-red-400 text-center">
                {bioError}
              </motion.p>
            )}
          </motion.div>
        )}

        {/* ─── Stage: Plug in source ─── */}
        {stage === 'plug-source' && (
          <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="w-full space-y-4">
            {readError && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4">
                <p className="text-sm text-red-400 text-center">{readError}</p>
              </div>
            )}

            {sourceDevice ? (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center">
                    <Usb className="w-5 h-5 text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-white font-medium text-sm">{sourceDevice.productName || 'USB Drive'}</p>
                    <p className="text-white/40 text-xs">{sourceDevice.formattedSize} &middot; Connected</p>
                  </div>
                  <div className="ml-auto w-3 h-3 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                </div>
              </div>
            ) : (
              <div className="bg-white/5 border border-white/10 rounded-2xl p-6 flex flex-col items-center gap-3">
                <motion.div
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 2, repeat: Infinity }}
                >
                  <Usb className="w-8 h-8 text-white/30" />
                </motion.div>
                <p className="text-sm text-white/40">
                  {detecting ? 'Scanning for USB devices...' : 'Waiting for USB drive...'}
                </p>
              </div>
            )}
          </motion.div>
        )}

        {/* ─── Stage: Reading ─── */}
        {stage === 'reading' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="w-full">
            <div className="relative w-full h-2 bg-white/10 rounded-full overflow-hidden">
              <motion.div
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-white to-gray-300"
                animate={{ width: ['0%', '100%'] }}
                transition={{ duration: 2, ease: 'easeInOut' }}
              />
            </div>
          </motion.div>
        )}

        {/* ─── Stage: Swap USB ─── */}
        {stage === 'swap-usb' && (
          <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="w-full space-y-4">
            {snapshotPubkey && (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-4">
                <p className="text-xs text-white/40 mb-1">Source Wallet Address</p>
                <p className="text-xs text-white font-mono break-all leading-relaxed">{snapshotPubkey}</p>
              </div>
            )}

            <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4">
              <p className="text-xs text-amber-400 leading-relaxed">
                <strong>Important:</strong> Safely remove the source USB drive, then plug in a fresh 
                USB drive to receive the backup copy.
              </p>
            </div>

            {targetDevice ? (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center">
                    <Usb className="w-5 h-5 text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-white font-medium text-sm">{targetDevice.productName || 'USB Drive'}</p>
                    <p className="text-white/40 text-xs">{targetDevice.formattedSize} &middot; Target ready</p>
                  </div>
                  <div className="ml-auto w-3 h-3 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                </div>
              </div>
            ) : (
              <div className="bg-white/5 border border-white/10 rounded-2xl p-6 flex flex-col items-center gap-3">
                <motion.div
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 2, repeat: Infinity }}
                >
                  <Usb className="w-8 h-8 text-white/30" />
                </motion.div>
                <p className="text-sm text-white/40">
                  {detecting ? 'Scanning for target USB...' : 'Waiting for fresh USB drive...'}
                </p>
              </div>
            )}
          </motion.div>
        )}

        {/* ─── Stage: PIN Verification ─── */}
        {stage === 'pin-verify' && (
          <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="w-full space-y-4 mb-8">
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
                autoFocus
              />
            </div>
            {pinError && (
              <p className="text-red-400 text-sm text-center">{pinError}</p>
            )}

            <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
              <p className="text-xs text-white/50 leading-relaxed">
                <strong className="text-amber-400">Security: </strong>
                Your PIN will be used to decrypt the wallet and verify you are the owner 
                of the private keys before they are duplicated to the new USB drive.
              </p>
            </div>
          </motion.div>
        )}

        {/* ─── Stage: Writing — progress bar ─── */}
        {stage === 'writing' && !writeError && (
          <div className="w-full space-y-3 mb-8">
            <div className="relative w-full h-2 bg-white/10 rounded-full overflow-hidden">
              <motion.div
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-white to-gray-300"
                initial={{ width: 0 }}
                animate={{ width: `${writeProgress}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-white/60">{writeMessage}</span>
              <span className="text-white font-medium">{Math.round(writeProgress)}%</span>
            </div>
          </div>
        )}

        {/* ─── Stage: Writing — step indicators ─── */}
        {stage === 'writing' && !writeError && writeStep !== 'complete' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-2 w-full">
            {WRITE_STEPS.map((step, i) => {
              const info = STEP_LABELS[step];
              const isActive = step === writeStep;
              const isDone = currentWriteStepIndex > i;
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
                    isDone ? 'bg-emerald-500/20' : isActive ? 'bg-white/20' : 'bg-white/5'
                  }`}>
                    {isDone ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <Icon className={`w-3 h-3 ${isActive ? 'text-white' : 'text-white/30'}`} />
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

        {/* ─── Stage: Writing — error ─── */}
        {stage === 'writing' && writeError && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full bg-red-500/10 border border-red-500/30 rounded-2xl p-4">
            <p className="text-sm text-red-400 text-center">{writeError}</p>
          </motion.div>
        )}

        {/* ─── Stage: Complete ─── */}
        {stage === 'complete' && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full space-y-4">
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-4">
              <p className="text-sm text-emerald-400 text-center mb-3">
                Cold wallet duplicated and verified on backup USB!
              </p>
              {snapshotPubkey && (
                <div className="bg-black/30 rounded-xl p-3">
                  <p className="text-xs text-white/40 mb-1">Wallet Address</p>
                  <p className="text-xs text-white font-mono break-all leading-relaxed">{snapshotPubkey}</p>
                </div>
              )}
            </div>

            <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4">
              <p className="text-xs text-amber-400 leading-relaxed">
                <strong>Important:</strong> Remove the backup USB drive safely. Store it in a separate 
                secure location from your original. Both drives share the same PIN.
              </p>
            </div>
          </motion.div>
        )}
      </div>

      {/* ─── Bottom actions ─── */}
      <div className="w-full max-w-md">
        {stage === 'biometric' && (
          <button
            onClick={() => navigate('/app')}
            className="w-full h-14 rounded-2xl bg-white/10 text-white font-semibold text-base flex items-center justify-center gap-2 active:scale-95 transition-transform"
          >
            <ArrowLeft className="w-5 h-5" />
            Cancel
          </button>
        )}

        {stage === 'plug-source' && sourceDevice && (
          <SwipeButton onComplete={handleReadSource} text="Swipe to read wallet" />
        )}

        {stage === 'swap-usb' && targetDevice && (
          <button
            onClick={() => setStage('pin-verify')}
            className="w-full h-14 rounded-2xl bg-white text-black font-bold text-base shadow-xl active:scale-95 transition-transform"
          >
            Continue
          </button>
        )}

        {stage === 'pin-verify' && (
          <SwipeButton
            onComplete={handlePinVerify}
            text={pinVerifying ? 'Verifying...' : 'Swipe to verify & write backup'}
            disabled={pin.length < 6 || pinVerifying}
          />
        )}

        {stage === 'writing' && writeError && (
          <button
            onClick={() => {
              setWriteError(null);
              setWriteStep('idle');
              setWriteProgress(0);
              setStage('pin-verify');
              setPin('');
            }}
            className="w-full h-14 rounded-2xl bg-white/10 text-white font-semibold text-base active:scale-95 transition-transform"
          >
            Try Again
          </button>
        )}

        {stage === 'complete' && (
          <button
            onClick={handleGoHome}
            className="w-full h-14 rounded-2xl bg-white text-black font-bold text-base shadow-xl active:scale-95 transition-transform"
          >
            Done
          </button>
        )}
      </div>
    </div>
  );
}
