import { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { hapticError, hapticSuccess } from '../../../utils/mobile';
import { NumericKeypad } from './NumericKeypad';

interface PinInputProps {
  length?: number;
  onComplete: (pin: string) => void;
  error?: boolean;
  onErrorAnimationEnd?: () => void;
  showBiometric?: boolean;
  onBiometric?: () => void;
}

export function PinInput({ 
  length = 6, 
  onComplete, 
  error = false,
  onErrorAnimationEnd,
  showBiometric = false,
  onBiometric
}: PinInputProps) {
  const [pin, setPin] = useState<string[]>(Array(length).fill(''));

  useEffect(() => {
    if (error) {
      hapticError();
    }
  }, [error]);

  const handleNumberPress = (num: string) => {
    const emptyIndex = pin.findIndex(digit => digit === '');
    if (emptyIndex !== -1) {
      const newPin = [...pin];
      newPin[emptyIndex] = num;
      setPin(newPin);

      // Check if complete
      if (newPin.every(digit => digit !== '')) {
        hapticSuccess();
        onComplete(newPin.join(''));
      }
    }
  };

  const handleBackspace = () => {
    const lastFilledIndex = pin.map((digit, i) => digit !== '' ? i : -1).filter(i => i !== -1).pop();
    if (lastFilledIndex !== undefined) {
      const newPin = [...pin];
      newPin[lastFilledIndex] = '';
      setPin(newPin);
    }
  };

  const clearPin = () => {
    setPin(Array(length).fill(''));
    if (onErrorAnimationEnd) {
      onErrorAnimationEnd();
    }
  };

  return (
    <div className="w-full">
      {/* PIN Dots Display */}
      <motion.div
        animate={error ? { x: [-10, 10, -10, 10, 0] } : {}}
        transition={{ duration: 0.4 }}
        onAnimationComplete={() => {
          if (error) {
            clearPin();
          }
        }}
        className="flex items-center justify-center gap-3 mb-12"
      >
        {Array.from({ length }).map((_, index) => (
          <motion.div
            key={index}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: index * 0.05, type: 'spring', stiffness: 300, damping: 20 }}
            className={`w-4 h-4 rounded-full border-2 transition-all ${
              error
                ? 'border-red-500 bg-red-500'
                : pin[index]
                ? 'border-white bg-white'
                : 'border-white/30 bg-transparent'
            }`}
          />
        ))}
      </motion.div>

      {/* Numeric Keypad */}
      <NumericKeypad
        onNumberPress={handleNumberPress}
        onBackspace={handleBackspace}
        onBiometric={onBiometric}
        showBiometric={showBiometric}
      />
    </div>
  );
}