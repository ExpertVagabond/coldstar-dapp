package com.coldstar.wallet;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.coldstar.plugins.ColdstarUSBPlugin;
import com.coldstar.plugins.BiometricAuthPlugin;
import com.coldstar.plugins.SecureStorePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ColdstarUSBPlugin.class);
        registerPlugin(BiometricAuthPlugin.class);
        registerPlugin(SecureStorePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
