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
    // its start: the task, the thinking, each tool in the colour of its work
    app.swipeDown()
    app.swipeDown()
    sleep(1)
    shot("chat-top")

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
        for i in 2...4 {
          app.swipeLeft()
          sleep(4)
          shot("viewer-\(i)")
        }
        if app.buttons["viewer-done"].exists { app.buttons["viewer-done"].tap() }
      }
      app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    // review: the branch against its base as a pull request shows it, the two branch lists, the
    // uncommitted changes, a diff, a comment on a line, the other lists, the folder, and the comment sent
    app.buttons["agent-more"].tap()
    if wait(app.buttons["Review changes"], 5) {
      app.buttons["Review changes"].tap()
      let file = app.buttons["change-fit.py"]
      if wait(file, 20, "the file the branch changed") {
        shot("review-changes")
        app.buttons["ref-base"].tap()
        if wait(app.buttons["ref-main"], 10, "the base's branch list") {
          shot("review-base")
          app.buttons["Cancel"].tap()
        }
        app.buttons["ref-head"].tap()
        if wait(app.buttons["ref-Working tree"], 10, "the head's branch list") {
          shot("review-head")
          app.buttons["ref-Working tree"].tap()
          wait(app.buttons["change-config.yaml"], 20, "the working tree's changes against the base")
          shot("review-worktree")
        }
      }
      app.buttons["Uncommitted"].tap()
      if wait(file, 20, "the changed file among the uncommitted changes") {
        shot("review-uncommitted")
        file.tap()
        let line = app.webViews.staticTexts.containing(NSPredicate(format: "label CONTAINS 'result.check()'")).firstMatch
        if wait(line, 20, "the diff's added line") {
          sleep(1)
          shot("diff")
          line.tap()
          let comment = app.textFields["comment-text"].exists ? app.textFields["comment-text"] : app.textViews["comment-text"]
          if wait(comment, 10, "the comment box") {
            comment.typeText("Check the status before returning")
            app.buttons["comment-save"].tap()
            sleep(2)
            shot("diff-commented")
          }
        } else {
          shot("diff-missing")
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(3)
        shot("diff-landscape")
        XCUIDevice.shared.orientation = .portrait
        sleep(2)
        app.buttons["diff-done"].tap()
      }
      for tab in ["Files", "Commits"] {
        app.buttons[tab].tap()
        sleep(4)
        shot("review-\(tab.lowercased())")
      }
      app.buttons["review-folder"].tap()
      if wait(app.buttons["dir-plots"], 20, "the agent's folder") {
        shot("review-folder")
        app.navigationBars.buttons.element(boundBy: 0).tap()
      }
      if app.buttons["send-comments"].exists {
        app.buttons["send-comments"].tap()
        wait(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Review comments on'")).firstMatch, 30, "the review comments in the conversation")
        sleep(2)
        shot("chat-after-review")
      } else {
        app.navigationBars.buttons.element(boundBy: 0).tap()
      }
    }

    // back home; a folder's files from there: a folder in it, a picture, a file as text, a download
    app.navigationBars.buttons.element(boundBy: 0).tap()
    if wait(app.buttons["Files of work"], 10, "the folder's files button") {
      app.buttons["Files of work"].tap()
      if wait(app.buttons["file-fit.py"], 20, "the folder's files") {
        shot("folder")
        app.buttons["file-fit.py"].tap()
        sleep(4)
        shot("folder-text")
        app.buttons["viewer-done"].tap()
        app.buttons["dir-plots"].tap()
        if wait(app.buttons["file-mass.png"], 20, "the plots folder") {
          app.buttons["file-mass.png"].tap()
          sleep(4)
          shot("folder-picture")
          app.buttons["viewer-download"].tap()
          sleep(4)
          shot("folder-download")
          if app.buttons["Cancel"].waitForExistence(timeout: 5) { app.buttons["Cancel"].tap() }
          sleep(1)
          app.buttons["viewer-done"].tap()
        }
        app.navigationBars.buttons.element(boundBy: 0).tap()
      }
      app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    // an agent stopped by a usage limit: Claude Code's own words, in their own colours
    let limited = app.buttons["agent-eeee5555"]
    if limited.waitForExistence(timeout: 5) {
      limited.tap()
      wait(app.descendants(matching: .any)["chat-limit"], 30, "the usage limit in the conversation")
      sleep(1)
      shot("chat-limit")
      app.navigationBars.buttons.element(boundBy: 0).tap()
    }
    let add = app.buttons["New in work"]
    if wait(add, 10, "the folder's + button") {
      add.tap()
      shot("new-menu")
      app.buttons["New agent"].tap()
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
    // a terminal in the same folder: the shell, on its own screen
    if wait(add, 10, "the folder's + button, back home") {
      add.tap()
      app.buttons["New terminal"].tap()
      if wait(app.buttons["terminal-done"], 15, "the new terminal") {
        sleep(2)
        shot("new-terminal")
        app.buttons["terminal-done"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
      }
    }
    sleep(2)
    shot("home-after")

    // a project's form, with the Mac's icons to pick from
    let edit = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Edit '")).firstMatch
    if wait(edit, 5, "a project's edit button") {
      edit.tap()
      sleep(1)
      app.swipeUp()
      app.swipeUp()
      shot("project-icons")
      if app.buttons["Cancel"].exists { app.buttons["Cancel"].tap() }
    }

    // settings and a host
    app.buttons["Settings"].tap()
    sleep(1)
    shot("settings")
    if app.buttons["Done"].exists { app.buttons["Done"].tap() }
  }
}
