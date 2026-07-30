import { useState, useRef, useEffect } from 'react';
import { motion, useMotionValue, useTransform, PanInfo } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import { hapticLight, hapticSuccess } from '../../../utils/mobile';

interface SwipeButtonProps {
  onComplete: () => void;
  text?: string;
  disabled?: boolean;
  variant?: 'primary' | 'sign';
}

export function SwipeButton({ 
  onComplete, 
  text = 'Swipe to confirm',
  disabled = false,
  variant = 'primary'
}: SwipeButtonProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const maxDrag = useRef(0);

  useEffect(() => {
    if (containerRef.current) {
      maxDrag.current = containerRef.current.offsetWidth - 64;
    }
  }, []);

  const background = useTransform(
    x,
    [0, maxDrag.current],
    variant === 'sign' 
      ? ['rgba(0, 0, 0, 0)', 'rgba(16, 185, 129, 0.1)']
      : ['rgba(0, 0, 0, 0)', 'rgba(255, 255, 255, 0.1)']
  );

  const handleDragStart = () => {
    setIsDragging(true);
    hapticLight();
  };

  const handleDragEnd = (event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    setIsDragging(false);
    
    const currentX = x.get();
    
    if (currentX >= maxDrag.current * 0.8) {
      x.set(maxDrag.current);
      setIsComplete(true);
      hapticSuccess();
      setTimeout(() => {
        onComplete();
      }, 300);
    } else {
      x.set(0);
      hapticLight();
    }
  };

  const baseClasses = variant === 'sign'
    ? 'bg-gradient-to-r from-emerald-500 to-green-500'
    : 'bg-gradient-to-r from-white to-gray-100';

  return (
    <div
      ref={containerRef}
      className={`relative h-14 rounded-2xl overflow-hidden ${
        disabled ? 'opacity-50 cursor-not-allowed' : ''
      }`}
      style={{
        background: variant === 'sign' 
          ? 'linear-gradient(90deg, rgba(16, 185, 129, 0.1) 0%, rgba(5, 150, 105, 0.1) 100%)'
          : 'linear-gradient(90deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.02) 100%)',
        border: variant === 'sign' 
          ? '1px solid rgba(16, 185, 129, 0.3)'
          : '1px solid rgba(255, 255, 255, 0.1)'
      }}
    >
      <motion.div
        className="absolute inset-0 pointer-events-none"
        style={{ background }}
      />
      
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span className={`font-medium ${
          variant === 'sign' ? 'text-emerald-400' : 'text-white/60'
        }`} style={{ fontSize: '16.1px' }}>
          {isComplete ? 'Confirmed' : text}
        </span>
      </div>

      <motion.div
        drag="x"
        dragConstraints={{ left: 0, right: maxDrag.current }}
        dragElastic={0}
        dragMomentum={false}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        // touchAction none: without it iOS WebKit can claim horizontal touch
        // drags for scrolling before pointermove reaches framer-motion
        style={{ x, touchAction: 'none' }}
        className={`absolute left-1 top-1 w-12 h-12 rounded-xl ${baseClasses} shadow-lg flex items-center justify-center cursor-grab active:cursor-grabbing ${
          disabled ? 'pointer-events-none' : ''
        }`}
        whileTap={{ scale: 0.95 }}
      >
        <ChevronRight className={`w-6 h-6 ${
          variant === 'sign' ? 'text-white' : 'text-black'
        }`} />
      </motion.div>
    </div>
  );
}