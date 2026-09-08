// AppViewController.swift — registers the app-local Capacitor plugins.
//
// Capacitor does NOT auto-register plugins that live in the app target; without
// this, `ColdstarStorage`/`BiometricAuth` are undefined in JS and every call
// fails silently. Main.storyboard's view controller must point at this class.

import UIKit
import Capacitor

class AppViewController: CAPBridgeViewController {

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ColdstarStoragePlugin())
        bridge?.registerPluginInstance(BiometricAuthPlugin())
        bridge?.registerPluginInstance(SecureStorePlugin())
    }
}
