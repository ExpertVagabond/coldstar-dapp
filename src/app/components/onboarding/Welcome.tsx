
import { useNavigate } from 'react-router';
import { motion } from 'motion/react';
import logoImg from '../../../imports/Connected-1.png';
import { useStartupPage } from '../../../utils/useStartupPage';

export function Welcome() {
  const navigate = useNavigate();
  useStartupPage();

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-between p-6 pb-12 pt-16">
      <div className="flex-1 flex flex-col items-center justify-center max-w-md w-full">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.5 }}
          className="mb-12"
        >
          <img src={logoImg} alt="Coldstar" className="h-24" />
        </motion.div>

        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.5 }}
          className="text-center mb-8"
        >
          <h1 className="text-4xl font-semibold text-white mb-4">
            Coldstar
          </h1>
          <p className="text-lg text-white/60 leading-relaxed">
            Hardware-assisted security for your Solana assets
          </p>
        </motion.div>

        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.4, duration: 0.5 }}
          className="space-y-4 w-full"
        >
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-sm font-semibold text-white">1</span>
            </div>
            <div>
              <h3 className="text-white font-medium mb-1">Security First</h3>
              <p className="text-sm text-white/50">
                Your keys never leave your hardware device
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-sm font-semibold text-white">2</span>
            </div>
            <div>
              <h3 className="text-white font-medium mb-1">Simple & Fast</h3>
              <p className="text-sm text-white/50">
                Swipe to sign transactions in seconds
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-sm font-semibold text-white">3</span>
            </div>
            <div>
              <h3 className="text-white font-medium mb-1">Full Control</h3>
              <p className="text-sm text-white/50">
                Self-custody with hardware protection
              </p>
            </div>
          </div>
        </motion.div>
      </div>

      <motion.button
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.6, duration: 0.5 }}
        onClick={() => navigate('/onboarding/usb-connect')}
        className="w-full max-w-md h-14 rounded-2xl bg-white text-black font-semibold text-base shadow-xl active:scale-95 transition-transform"
      >
        Set up Coldstar
      </motion.button>
    </div>
  );
}