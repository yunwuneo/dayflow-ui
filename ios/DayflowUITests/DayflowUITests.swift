import XCTest

final class DayflowUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    @MainActor func testArchiveFlows() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.buttons["activity-1"].waitForExistence(timeout: 15))
        snapshot("timeline")
        app.buttons["activity-1"].tap()
        XCTAssertTrue(app.navigationBars["活动详情"].waitForExistence(timeout: 5))
        app.buttons["放大截图"].tap()
        XCTAssertTrue(app.buttons["close-image"].waitForExistence(timeout: 5))
        snapshot("screenshot")
        app.buttons["close-image"].tap()
        snapshot("detail")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["前一天"].tap()
        XCTAssertTrue(app.staticTexts["当天暂无活动记录"].waitForExistence(timeout: 10))
        app.buttons["后一天"].tap()
        XCTAssertTrue(app.buttons["activity-1"].waitForExistence(timeout: 10))
        app.tabBars.buttons["回顾"].tap()
        XCTAssertTrue(app.staticTexts["工作亮点"].waitForExistence(timeout: 5))
        snapshot("daily")
        app.buttons["周统计"].tap()
        XCTAssertTrue(app.staticTexts["专注时长"].waitForExistence(timeout: 5))
        snapshot("weekly")
        app.tabBars.buttons["搜索"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("zzzxxyy")
        XCTAssertTrue(app.staticTexts["没有找到匹配的活动"].waitForExistence(timeout: 10))
        snapshot("empty-search")
        let cancel = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "取消", "Cancel")).firstMatch
        if cancel.exists { cancel.tap() } else { search.typeText("\n") }
        app.tabBars.buttons["设置"].tap()
        XCTAssertTrue(app.staticTexts["MacBook Pro"].waitForExistence(timeout: 5))
        snapshot("settings")
    }

    @MainActor func testLoginAndValidation() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-login", "-AppleLanguages", "(zh-Hans)"]
        app.launch()
        XCTAssertTrue(app.textFields["server-address"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["connect"].isEnabled)
        snapshot("login")
    }

    @MainActor func testLargeTextLayout() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "-AppleLanguages", "(zh-Hans)",
                               "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        XCTAssertTrue(app.buttons["choose-date"].waitForExistence(timeout: 15))
        app.swipeUp()
        XCTAssertTrue(app.buttons["activity-1"].waitForExistence(timeout: 15))
        snapshot("large-text")
    }

    @MainActor private func snapshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
