import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.coldstar.app',
  appName: 'Coldstar',
  webDir: 'dist',
  // WebView background — without this the view is WHITE between splash-hide
  // and first paint (the flash visible in the 2026-07-27 demo videos)
  backgroundColor: '#000000',
  server: {
    androidScheme: 'https'
  },
  ios: {
    contentInset: 'automatic',
    scheme: 'Coldstar'
  },
  plugins: {
    CapacitorHttp: {
      enabled: true
    },
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: '#000000',
      showSpinner: false,
      androidSpinnerStyle: 'large',
      iosSpinnerStyle: 'small',
      splashFullScreen: true,
      splashImmersive: true
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#000000'
    }
  }
};

export default config;
