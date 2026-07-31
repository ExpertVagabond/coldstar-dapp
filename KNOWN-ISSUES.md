# Known issues

- **Main screen double-render after onboarding** (2026-07-31, emulator/Android 15):
  after "You're All Set" → Enter Coldstar, Home briefly shows duplicated
  overlapping cards (Total Portfolio ×2, Assets/NFTs pills ×2, action rows ×2)
  plus red "Disconnected" hardware badges. Likely AnimatePresence double-mount /
  route double-render on first entry. Frame: demo footage 2026-07-31 (venture-ops
  content check frames). Found via demo-gate review; repo issues are disabled, so
  tracked here.
