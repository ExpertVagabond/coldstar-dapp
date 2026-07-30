// BiometricAuthPlugin.swift — iOS counterpart to Android's BiometricAuthPlugin.java
// (PLATFORM-PARITY.md B1). Face ID / Touch ID via LocalAuthentication, exposed to
// JS as `BiometricAuth` with the same surface: isAvailable() and authenticate().
//
// Requires NSFaceIDUsageDescription in Info.plist. Compiles only inside the
// Capacitor iOS project (imports Capacitor).

import Foundation
import LocalAuthentication
import Capacitor

@objc(BiometricAuthPlugin)
public class BiometricAuthPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "BiometricAuthPlugin"
    public let jsName = "BiometricAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
    ]

    @objc func isAvailable(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                                                  error: &error)
        call.resolve(["available": available])
    }

    @objc func authenticate(_ call: CAPPluginCall) {
        // Android shows title/subtitle in its prompt; iOS shows one reason line.
        let reason = call.getString("reason")
            ?? call.getString("subtitle")
            ?? "Unlock Coldstar Wallet"

        let context = LAContext()
        context.localizedCancelTitle = "Cancel"

        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                                        error: &error) else {
            call.reject(error?.localizedDescription ?? "Biometrics not available")
            return
        }

        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                               localizedReason: reason) { success, evalError in
            if success {
                call.resolve()
            } else {
                let nsError = evalError as NSError?
                call.reject(nsError?.localizedDescription ?? "Authentication failed",
                            String(nsError?.code ?? -1))
            }
        }
    }
}
