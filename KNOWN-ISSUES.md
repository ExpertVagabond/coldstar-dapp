# Known issues

## RESOLVED / RECLASSIFIED

- **Main-screen "double-render" after onboarding — NOT an app bug (2026-07-31).**
  The overlapping duplicated panels seen on the Android emulator are WebView
  surface/tile compositing corruption in the emulator itself. Evidence: with the
  screen visibly corrupted, CDP `Runtime.evaluate` DOM queries show exactly ONE
  of every element (`Total Portfolio` ×1, `Disconnected` ×1, one #root, 165
  nodes) under BOTH `-gpu auto` (gfxstream) and `-gpu swiftshader_indirect` —
  two different corruption patterns, same clean DOM. Onboarding screens render
  fine in the same sessions. Expectation: unaffected on real hardware (real GPU
  drivers); confirm during physical-device testing (queue: physical-device-tests).

- **Biometric-unavailable lockout — FIXED (2026-07-31).** PinUnlock had no
  fallback: any device without usable biometrics was permanently locked out of
  the app UI. Now falls back to wallet-PIN unlock verified by decrypting from
  the USB drive (same trust boundary as signing). Verified on emulator:
  biometrics unavailable → PIN input shown → correct PIN + drive → unlocked.
