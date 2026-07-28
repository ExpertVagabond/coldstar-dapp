import React from 'react';
import ReactDOM from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import App from './app/App';
import './styles/index.css';

// Status bar must be set at runtime — the capacitor.config StatusBar block
// alone doesn't apply it, which left a white bar over the dark UI in the demo.
// Style.Dark = dark background semantics -> light text/icons.
if (Capacitor.isNativePlatform()) {
  StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
  if (Capacitor.getPlatform() === 'android') {
    StatusBar.setBackgroundColor({ color: '#000000' }).catch(() => {});
  }
}

// Prevent zoom on double-tap for mobile
let lastTouchEnd = 0;
document.addEventListener('touchend', (event) => {
  const now = Date.now();
  if (now - lastTouchEnd <= 300) {
    event.preventDefault();
  }
  lastTouchEnd = now;
}, false);

// Pull-to-refresh is prevented via CSS (overscroll-behavior: none)
// and handled at the component level by PullToRefresh.tsx

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
