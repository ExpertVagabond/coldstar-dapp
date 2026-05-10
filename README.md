# Coldstar Wallet

> A mobile-first, hardware-assisted self-custody wallet for the Solana ecosystem.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-iOS%20%7C%20Android-lightgrey)](https://capacitorjs.com/)
[![Built on Solana](https://img.shields.io/badge/built%20on-Solana-9945FF)](https://solana.com/)
[![Rust Backend](https://img.shields.io/badge/backend-Rust-orange)](https://www.rust-lang.org/)

Coldstar combines the convenience of a mobile wallet with the security model of a hardware device. Private keys never leave the USB drive — signing happens on-device, and the mobile app coordinates the flow. The result is a self-custody experience that does not require a dedicated hardware wallet form factor.

> **Status:** Active prototype. Suitable for flow testing, UX validation, and product evaluation. Not yet recommended for production asset custody.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Tech Stack](#tech-stack)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Mobile Deployment](#mobile-deployment)
  - [Solana Seeker](#solana-seeker)
  - [General Android](#general-android)
  - [iOS](#ios)
- [Backend — Rust Workspace](#backend--rust-workspace)
- [Security Model](#security-model)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Additional Documentation](#additional-documentation)
- [License](#license)

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│              Coldstar Mobile App            │
│        React 18 + TypeScript + Vite         │
│           Capacitor 8 (iOS / Android)       │
└────────────────────┬────────────────────────┘
                     │ Capacitor Bridge
┌────────────────────▼────────────────────────┐
│            Rust Native Layer                │
│  coldstar-crypto · coldstar-signer          │
│  coldstar-transport · coldstar-rpc          │
│  coldstar-session · coldstar-ffi            │
└────────────────────┬────────────────────────┘
                     │ USB OTG / USB-C
┌────────────────────▼────────────────────────┐
│              USB Flash Drive                │
│      Encrypted key material (AES-GCM)       │
│      Signing happens here — keys never      │
│      leave the device                       │
└─────────────────────────────────────────────┘
```

The frontend communicates with the Rust backend via Capacitor's FFI bridge. All cryptographic operations (key generation, transaction signing, PIN-based decryption) are performed in the Rust layer. The mobile UI handles routing, state, and UX only.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite 6 |
| UI | Tailwind CSS v4, Radix UI, MUI v7, Lucide Icons |
| Routing | React Router v7 |
| Mobile Runtime | Capacitor 8 (iOS & Android) |
| Backend / Crypto | Rust (Cargo workspace) |
| Cryptography | AES-GCM, Argon2, Ed25519, X25519 |
| Solana SDK | `@solana/web3.js` v1, `@solana/spl-token` v0.4 |
| Swaps | Jupiter Aggregator |
| Token Safety | RugCheck API |
| Privacy | Umbra Privacy SDK v4 |
| Transaction Data | Solscan API |

---

## Features

### Onboarding & Access
- USB device detection and guided pairing flow
- New wallet creation with PIN protection
- Existing wallet unlock via USB + PIN
- Biometric unlock (Face ID / Fingerprint) on supported devices

### Wallet
- Portfolio overview with real-time SOL and SPL token balances
- Send tokens — manual address entry, clipboard paste, or QR scan
- Receive — shareable QR code and address copy
- Token swap with Jupiter routing, quote preview, and slippage details
- Transaction history with offline cache support

### Discovery & Insights
- Curated Solana dApp explorer
- Token safety signals during swap (powered by RugCheck)
- Real-world asset (RWA) token view

---

## Prerequisites

| Tool | Minimum Version | Notes |
|---|---|---|
| Node.js | 20+ | LTS recommended |
| npm | 10+ | Included with Node.js |
| Rust + Cargo | 1.78+ | [rustup.rs](https://rustup.rs) |
| Android Studio | Hedgehog+ | For Android builds |
| Xcode | 15+ | macOS only, for iOS builds |
| JDK | 17 | Required by Gradle |

---

## Getting Started

### 1. Clone and install

```bash
git clone https://github.com/devsyrem/coldstar-dapp.git
cd coldstar-dapp
npm install
```

### 2. Start the development server

```bash
npm run dev
```

The app will be available at `http://localhost:5173`.

### 3. Build a production web bundle

```bash
npm run build
```

### 4. Sync to mobile platforms

```bash
# Option A — automated setup script (recommended for first run)
chmod +x setup-mobile.sh
./setup-mobile.sh

# Option B — manual
npm run build
npx cap add android   # first time only
npx cap add ios       # first time only, macOS only
npm run cap:sync
```

---

## Mobile Deployment

### Solana Seeker

Coldstar is optimised for the Solana Seeker device, including tailored UX language and biometric flow integration.

```bash
# Build the web bundle and sync native projects
npm run mobile:build

# Open Android Studio
npm run cap:android
```

1. Select your Seeker device as the deployment target in Android Studio.
2. Run the app.
3. Connect a USB drive via USB-C / OTG adapter.
4. Follow the in-app setup flow to create or unlock your wallet.

### General Android

```bash
npm run mobile:build
npm run cap:android
```

Open Android Studio, select a device or emulator, and run. A physical device is required for USB detection and biometric features.

### iOS

> Requires macOS with Xcode 15 or later.

```bash
npm run mobile:build
npm run cap:ios
```

Open Xcode, select your target device, and build. USB signing flows require a physical device over Lightning or USB-C.

---

## Backend — Rust Workspace

The `backend/` directory contains a Cargo workspace with the following crates:

| Crate | Purpose |
|---|---|
| `coldstar-core` | Shared types, error handling, and domain models |
| `coldstar-crypto` | AES-GCM encryption, Argon2 key derivation, Ed25519/X25519 primitives |
| `coldstar-signer` | Transaction construction and signing against Solana SDK |
| `coldstar-transport` | USB communication protocol and I/O layer |
| `coldstar-session` | Session state management and lifecycle |
| `coldstar-rpc` | Solana RPC client abstraction |
| `coldstar-ffi` | Capacitor FFI bridge — exposes Rust to the mobile layer |

### Common commands

```bash
cd backend

# Type-check all crates
cargo check

# Run all tests
cargo test

# Build release binaries
cargo build --release
```

---

## Security Model

Coldstar is designed around a **keys-never-leave-device** principle:

- **Private keys** are generated and stored exclusively on the USB drive, encrypted with AES-256-GCM.
- **Key derivation** uses Argon2id to derive encryption keys from the user's PIN, making brute-force attacks computationally expensive.
- **Signing** is performed by the Rust layer using Ed25519 (`ed25519-dalek`). The mobile UI receives only the signed transaction bytes — never the raw key material.
- **Session keys** are held in memory only for the duration of an authenticated session and zeroised (`zeroize`) on logout or app backgrounding.
- The mobile app stores **no private key material** in its local storage, keychain, or database.

> **Important:** This prototype has not undergone a formal security audit. Do not use it for significant asset custody until a full audit has been completed and production hardening applied.

---

## Project Structure

```
coldstar-dapp/
├── src/
│   ├── app/
│   │   ├── App.tsx              # Root component and layout
│   │   ├── routes.tsx           # Application routing
│   │   └── components/          # Feature components (auth, wallet, swap, etc.)
│   ├── contexts/
│   │   └── WalletContext.tsx    # Global wallet state
│   ├── services/                # External integrations and data access
│   │   ├── solana.ts            # Solana RPC helpers
│   │   ├── jupiter.ts           # Jupiter swap aggregator
│   │   ├── wallet.ts            # Wallet operations
│   │   ├── transactions.ts      # Transaction fetching and parsing
│   │   ├── biometric.ts         # Biometric auth (Capacitor)
│   │   ├── rugcheck.ts          # Token safety signals
│   │   └── solscan.ts           # Transaction explorer data
│   └── utils/                   # Shared utilities and hooks
├── backend/
│   └── crates/
│       ├── coldstar-core/
│       ├── coldstar-crypto/
│       ├── coldstar-signer/
│       ├── coldstar-transport/
│       ├── coldstar-session/
│       ├── coldstar-rpc/
│       └── coldstar-ffi/
├── android/                     # Capacitor Android project
├── capacitor.config.ts          # Capacitor configuration
├── vite.config.ts               # Vite build configuration
└── package.json
```

---

## Troubleshooting

### USB device not detected

- Ensure the USB drive and OTG adapter both support data transfer (not charge-only).
- Reconnect the device and accept any system permission prompts.
- Try an alternative USB drive.
- On Android, confirm USB debugging or OTG storage is enabled in developer settings.

### Mobile app shows stale content

The web bundle needs to be rebuilt and synced after any frontend change:

```bash
npm run build
npm run cap:sync
```

Then re-run the app from Android Studio or Xcode.

### iOS — CocoaPods dependency error

```bash
cd ios/App
pod repo update
pod install --repo-update
```

If the error persists, delete `Pods/` and `Podfile.lock` and re-run `pod install`.

### Android — Gradle sync failure

Ensure you are running JDK 17 and that `JAVA_HOME` points to it:

```bash
java -version
echo $JAVA_HOME
```

Sync the project in Android Studio via **File → Sync Project with Gradle Files**.

---

## Roadmap

- [ ] Staking — native SOL staking with validator selection
- [ ] Bundle transactions — batch multiple operations in one flow
- [ ] Airdrop tooling — claim and track airdrops
- [ ] Formal security audit and production hardening
- [ ] Deeper Solana Seeker platform integration
- [ ] Multi-account support

---

## Additional Documentation

| Document | Description |
|---|---|
| [MOBILE_BUILD_GUIDE.md](MOBILE_BUILD_GUIDE.md) | Detailed platform build, signing, and deployment steps |
| [FEATURES_BACKEND_SPEC.md](FEATURES_BACKEND_SPEC.md) | API contract and backend feature specification |
| [CONVERSION_SUMMARY.md](CONVERSION_SUMMARY.md) | History of the web-to-mobile conversion |

---

## License

[MIT](LICENSE) © Coldstar
