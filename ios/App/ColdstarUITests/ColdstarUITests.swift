// ColdstarUITests.swift — end-to-end walkthrough of the iOS wallet-creation flow.
//
// Drives the REAL app UI headless on the simulator: Choose USB Drive → Files
// picker (system remote view) → PIN entry (WKWebView fields) → swipe-to-flash →
// "Cold Wallet Created!". Run with `xcodebuild test` while `simctl io
// recordVideo` rolls to produce the iOS demo video.

import XCTest

final class ColdstarUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testCreateColdWalletEndToEnd() throws {
        let app = XCUIApplication()
        app.launch()

        // ── 1. Home: either fresh (Choose USB Drive) or returning user
        //     (saved drive → auto-advance straight to PIN entry) ──
        let choose = app.webViews.buttons.containing(
            NSPredicate(format: "label CONTAINS[c] 'Choose USB Drive'")).firstMatch
        let pinProbe = app.webViews.secureTextFields.firstMatch
        let deadline = Date().addingTimeInterval(40)
        while Date() < deadline {
            if pinProbe.exists || choose.exists { break }
            sleep(1)
        }
        // A saved drive auto-advances home → PIN a beat after render; settle,
        // then decide based on the final state.
        sleep(4)
        let needsPicker = !pinProbe.exists && choose.exists
        XCTAssertTrue(pinProbe.exists || choose.exists, "Neither Choose button nor PIN screen appeared")

        if needsPicker {
        choose.tap()

        // ── 2. Files picker: opens on Recents (Open disabled). Navigate
        //     Browse → On My iPhone, then Open the location root. ──
        let openButton = app.buttons["Open"]
        XCTAssertTrue(openButton.waitForExistence(timeout: 15), "Picker did not open")

        let browseTab = app.buttons.matching(identifier: "Browse").firstMatch
        if browseTab.waitForExistence(timeout: 5) {
            browseTab.tap()
            sleep(2)
            if !app.staticTexts["On My iPhone"].exists {
                browseTab.tap() // second tap pops to the locations list
                sleep(2)
            }
        }
        let onMyPhone = app.staticTexts.matching(identifier: "On My iPhone").firstMatch
        if onMyPhone.waitForExistence(timeout: 6) {
            onMyPhone.tap()
            sleep(2)
        }

        if !openButton.isEnabled {
            // Root not directly openable — create a folder and open inside it
            let more = app.buttons["OverflowBarButtonItem"]
            if more.waitForExistence(timeout: 4) {
                more.tap()
                sleep(1)
                let newFolder = app.buttons["New Folder"].exists
                    ? app.buttons["New Folder"] : app.staticTexts["New Folder"]
                if newFolder.waitForExistence(timeout: 4) {
                    newFolder.tap()
                    sleep(2)
                    app.typeText("COLDSTAR")
                    let done = app.buttons["Done"]
                    if done.waitForExistence(timeout: 3) { done.tap() }
                    sleep(2)
                    let folder = app.staticTexts["COLDSTAR"]
                    if folder.waitForExistence(timeout: 5) { folder.tap(); sleep(2) }
                }
            }
        }
        print("==PICKER STATE BEFORE OPEN==")
        print(app.debugDescription)
        XCTAssertTrue(openButton.isEnabled, "Open button still disabled in picker")
        openButton.tap()
        } // end needsPicker

        // ── 3. PIN entry (WKWebView secure fields) ──
        let pinFields = app.webViews.secureTextFields
        XCTAssertTrue(pinFields.firstMatch.waitForExistence(timeout: 20), "PIN field not found")
        sleep(2)
        pinFields.element(boundBy: 0).tap()
        sleep(1)
        pinFields.element(boundBy: 0).typeText("482913")
        sleep(1)
        pinFields.element(boundBy: 1).tap()
        sleep(1)
        pinFields.element(boundBy: 1).typeText("482913")
        sleep(1)
        // Dismiss keyboard so the slider is visible
        if app.toolbars.buttons["Done"].exists {
            app.toolbars.buttons["Done"].tap()
        } else {
            app.webViews.staticTexts["Set Wallet PIN"].firstMatch.tap()
        }
        sleep(2)

        // ── 4. Swipe-to-flash: drag from the slider knob (left edge of the
        //     'Swipe to flash' element) to its right edge ──
        print("==PIN SCREEN BEFORE SWIPE==")
        print(app.debugDescription)

        let sliderText = app.webViews.staticTexts.containing(
            NSPredicate(format: "label CONTAINS[c] 'Swipe to flash'")).firstMatch
        XCTAssertTrue(sliderText.waitForExistence(timeout: 10), "Slider not found")
        let frame = sliderText.frame
        print("==SLIDER TEXT FRAME== \(frame)")

        // The knob sits left of the centered label. The slider lives near the
        // screen bottom — inside the home-indicator gesture zone — so touch the
        // UPPER half of the knob and retry with varying offsets if the system
        // steals the gesture.
        let window = app.windows.firstMatch
        let winFrame = window.frame
        let flashing = app.webViews.staticTexts.containing(
            NSPredicate(format: "label CONTAINS[c] 'Flashing'")).firstMatch
        let createdProbe = app.webViews.staticTexts.containing(
            NSPredicate(format: "label CONTAINS[c] 'Cold Wallet Created'")).firstMatch

        for yOffset in [CGFloat(-18), -10, 0] {
            let y = frame.midY + yOffset
            let start = window.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: max(frame.minX - 55, 30), dy: y))
            let end = window.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: winFrame.maxX - 15, dy: y))
            start.press(forDuration: 0.1, thenDragTo: end, withVelocity: 150, thenHoldForDuration: 0.5)
            sleep(6)
            if flashing.exists || createdProbe.exists { break }
            print("==SWIPE ATTEMPT AT yOffset \(yOffset) DID NOT TRIGGER==")
        }
        print("==AFTER SWIPE==")
        print(app.debugDescription)

        // ── 5. Success ──
        let created = app.webViews.staticTexts.containing(
            NSPredicate(format: "label CONTAINS[c] 'Cold Wallet Created'")).firstMatch
        XCTAssertTrue(created.waitForExistence(timeout: 90), "Cold Wallet Created screen not reached")
        sleep(3)

        // Continue → "You're All Set"
        let cont = app.webViews.buttons["Continue"]
        if cont.waitForExistence(timeout: 5) {
            cont.tap()
            _ = app.webViews.staticTexts.containing(
                NSPredicate(format: "label CONTAINS[c] 'All Set'")).firstMatch
                .waitForExistence(timeout: 15)
            sleep(3)
        }
    }
}
