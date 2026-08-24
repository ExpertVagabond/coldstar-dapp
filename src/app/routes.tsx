import { createBrowserRouter } from 'react-router';
import { StartupFlash } from './components/onboarding/StartupFlash';
import { USBConnect } from './components/onboarding/USBConnect';
import { FirmwareFlash } from './components/onboarding/FirmwareFlash';
import { PinSetup } from './components/onboarding/PinSetup';
import { Success } from './components/onboarding/Success';
import { BackupWallet } from './components/onboarding/BackupWallet';
import { Home } from './components/main/Home';
import { History } from './components/main/History';
import { Stake } from './components/main/Stake';
import { Explore } from './components/main/Explore';
import { Quests } from './components/main/Quests';
import { RWA } from './components/main/RWA';
import { AssetDetail } from './components/main/AssetDetail';
import { Send } from './components/transaction/Send';
import { Receive } from './components/transaction/Receive';
import { Swap } from './components/transaction/Swap';
import { BulkSend } from './components/transaction/BulkSend';

export const router = createBrowserRouter([
  {
    path: '/',
    Component: StartupFlash,
  },
  {
    path: '/onboarding/usb-connect',
    Component: USBConnect,
  },
  {
    path: '/onboarding/firmware',
    Component: FirmwareFlash,
  },
  {
    path: '/onboarding/pin-setup',
    Component: PinSetup,
  },
  {
    path: '/onboarding/success',
    Component: Success,
  },
  {
    path: '/onboarding/backup',
    Component: BackupWallet,
  },
  {
    path: '/app',
    Component: Home,
  },
  {
    path: '/app/rwa',
    Component: RWA,
  },
  {
    path: '/app/history',
    Component: History,
  },
  {
    path: '/app/stake',
    Component: Stake,
  },
  {
    path: '/app/explore',
    Component: Explore,
  },
  {
    path: '/app/quests',
    Component: Quests,
  },
  {
    path: '/app/asset/:id',
    Component: AssetDetail,
  },
  {
    path: '/app/send',
    Component: Send,
  },
  {
    path: '/app/receive',
    Component: Receive,
  },
  {
    path: '/app/swap',
    Component: Swap,
  },
  {
    path: '/app/bulk-send',
    Component: BulkSend,
  },
]);