import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Copy, Share2, Check } from 'lucide-react';
import { useNavigate } from 'react-router';

import QRCode from 'qrcode';
import { useWallet } from '../../../contexts/WalletContext';

export function Receive() {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const { publicKey } = useWallet();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const walletAddress = publicKey || '';

  // Generate real QR code
  useEffect(() => {
    if (walletAddress && canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, walletAddress, {
        width: 280,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      });
    }
  }, [walletAddress]);

  const handleCopy = () => {
    navigator.clipboard.writeText(walletAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-black flex flex-col pt-12">
      <div className="border-b border-white/10 px-[12px] py-[15px]">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/app')}
            className="p-2 hover:bg-white/5 rounded-lg transition-colors active:scale-95"
          >
            <ArrowLeft className="w-6 h-6 text-white" />
          </button>
          <h1 className="text-xl font-semibold text-white">Receive</h1>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <div className="max-w-md w-full">
          <div className="text-center mb-8">
            <h2 className="text-2xl font-semibold text-white mb-2">
              Your Wallet Address
            </h2>
            <p className="text-base text-white/60">
              Share this address to receive crypto
            </p>
          </div>

          {/* Real QR Code */}
          <div className="bg-white rounded-3xl p-8 mb-6 shadow-2xl flex items-center justify-center">
            <canvas ref={canvasRef} className="rounded-2xl" />
          </div>

          {/* Address Display */}
          <div className="bg-white/5 border border-white/10 rounded-2xl p-4 mb-4">
            <div className="text-xs text-white/60 mb-2">Wallet Address</div>
            <div className="font-mono text-sm text-white break-all leading-relaxed">
              {walletAddress}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={handleCopy}
              className="h-14 rounded-2xl bg-white text-black font-semibold flex items-center justify-center gap-2 active:scale-95 transition-transform"
            >
              {copied ? (
                <>
                  <Check className="w-5 h-5" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="w-5 h-5" />
                  Copy
                </>
              )}
            </button>
            <button className="h-14 rounded-2xl bg-white/5 border border-white/10 text-white font-semibold flex items-center justify-center gap-2 hover:bg-white/10 active:scale-95 transition-all">
              <Share2 className="w-5 h-5" />
              Share
            </button>
          </div>

          {/* Info */}
          <div className="mt-6 bg-blue-500/10 border border-blue-500/30 rounded-2xl p-4">
            <p className="text-sm text-blue-400 text-center">
              Only send Solana assets to this address. Sending other chains may result in loss of funds.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}