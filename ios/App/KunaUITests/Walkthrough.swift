import XCTest

/// Walks through the app in the simulator against the fixture `scripts/ios-sim.sh` sets up
/// (a throwaway sshd with fake agents), and saves a picture of every screen on the way.
/// It is the way to look at the app without a phone; it is not run on a real device.
final class Walkthrough: XCTestCase {
  let app = XCUIApplication()
  let shots = ProcessInfo.processInfo.environment["KUNA_SHOTS"] ?? NSTemporaryDirectory()
  var count = 0

  override func setUp() {
    continueAfterFailure = true
  }

  func shot(_ name: String) {
    count += 1
    let file = String(format: "%@/%02d-%@.png", shots, count, name)
    try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: file))
  }

  @discardableResult
  func wait(_ element: XCUIElement, _ seconds: TimeInterval = 20, _ what: String = "") -> Bool {
    let there = element.waitForExistence(timeout: seconds)
    XCTAssertTrue(there, "did not show up: \(what.isEmpty ? element.description : what)")
    return there
  }

  func testWalkthrough() throws {
    let env = ProcessInfo.processInfo.environment
    app.launchArguments = ["-lock", "NO"]
    if let file = env["KUNA_IMPORT"] { app.launchArguments += ["-kunaImport", file] }
    app.launch()

    // home: the project, its folder, the agents the fixture started
    let agent = app.buttons["agent-aaaa1111"]
    wait(agent, 40, "the fixture's agent on the home screen")
    sleep(2)
    shot("home")

    // an agent's conversation
    agent.tap()
    wait(app.staticTexts["The fit converged."], 30, "the agent's reply")
    sleep(1)
    shot("chat")

    // write to it
    let message = app.textFields["message"].exists ? app.textFields["message"] : app.textViews["message"]
    if wait(message, 10, "the message box") {
      message.tap()
      message.typeText("Thanks, now the control region")
      shot("chat-typing")
      app.buttons["send"].tap()
      wait(app.staticTexts["You said: Thanks, now the control region"], 30, "the fake agent's answer to what was sent")
      shot("chat-answered")
    }

    // its terminal
    app.buttons["open-terminal"].tap()
    wait(app.buttons["terminal-done"], 10, "the terminal")
    sleep(4)
    shot("terminal")
    app.buttons["terminal-done"].tap()
    sleep(1)

    // plots and files
    app.buttons["agent-more"].tap()
    if wait(app.buttons["Plots and files"], 5) {
      app.buttons["Plots and files"].tap()
      sleep(5)
      shot("plots")
      let first = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'media-'")).firstMatch
      if first.waitForExistence(timeout: 10) {
        first.tap()
        sleep(4)
        shot("viewer")
        if app.buttons["viewer-done"].exists { app.buttons["viewer-done"].tap() }
      }
      app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    // review
    app.buttons["agent-more"].tap()
    if wait(app.buttons["Review changes"], 5) {
      app.buttons["Review changes"].tap()
      sleep(6)
      shot("review")
      let file = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'change-'")).firstMatch
      if file.waitForExistence(timeout: 10) {
        file.tap()
        sleep(5)
        shot("diff")
        app.navigationBars.buttons.element(boundBy: 0).tap()
      }
      app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    // back home; a new agent in the folder
    app.navigationBars.buttons.element(boundBy: 0).tap()
    let add = app.buttons["New agent in work"]
    if wait(add, 10, "the folder's + button") {
      add.tap()
      let prompt = app.textFields["new-agent-prompt"].exists ? app.textFields["new-agent-prompt"] : app.textViews["new-agent-prompt"]
      if wait(prompt, 10, "the new agent's prompt") {
        prompt.tap()
        prompt.typeText("Plot the control region")
        shot("new-agent")
        app.buttons["new-agent-start"].tap()
        sleep(6)
        shot("new-agent-started")
        if app.buttons["terminal-done"].exists { app.buttons["terminal-done"].tap() }
        sleep(2)
        shot("new-agent-chat")
        app.navigationBars.buttons.element(boundBy: 0).tap()
      }
    }
    sleep(2)
    shot("home-after")

    // settings and a host
    app.buttons["Settings"].tap()
    sleep(1)
    shot("settings")
    if app.buttons["Done"].exists { app.buttons["Done"].tap() }
  }
}
