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

  /// A line for `timings.txt` beside the pictures, which `scripts/ios-sim.sh` prints.
  func note(_ line: String) {
    let file = URL(fileURLWithPath: "\(shots)/timings.txt")
    let had = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
    try? (had + line + "\n").write(to: file, atomically: true, encoding: .utf8)
  }

  @discardableResult
  func wait(_ element: XCUIElement, _ seconds: TimeInterval = 20, _ what: String = "") -> Bool {
    let there = element.waitForExistence(timeout: seconds)
    XCTAssertTrue(there, "did not show up: \(what.isEmpty ? element.description : what)")
    return there
  }

  /// A text of the conversation: it is selectable, so a text view and not a label.
  func said(_ text: String) -> XCUIElement {
    app.textViews.matching(NSPredicate(format: "value CONTAINS %@", text)).firstMatch
  }

  /// A terminal on screen leaves the app idle for XCUITest: every step there is quick.
  func testTerminalIsQuick() throws {
    app.launchArguments = ["-lock", "NO", "-kunaStill", "YES"]
    if let file = ProcessInfo.processInfo.environment["KUNA_IMPORT"] { app.launchArguments += ["-kunaImport", file] }
    app.launch()
    wait(app.buttons["agent-aaaa1111"], 40, "the fixture's agent")
    app.buttons["agent-aaaa1111"].tap()
    wait(app.buttons["open-terminal"], 20, "the agent's screen")
    app.buttons["open-terminal"].tap()
    wait(app.buttons["key-Control"], 10, "the terminal")
    let start = Date()
    for _ in 0..<2 { app.buttons["key-Control"].tap() }
    let took = Date().timeIntervalSince(start)
    print("kuna: two taps on a terminal screen took \(Int(took)) s")
    XCTAssertLessThan(took, 30, "XCUITest waited for the terminal screen to be idle")
  }

  /// Calls in a row as one row that unfolds, and how long the context is, in the conversation and the terminal.
  func testChatRows() throws {
    app.launchArguments = ["-lock", "NO", "-opensTerminal", "NO", "-kunaStill", "YES"]
    if let file = ProcessInfo.processInfo.environment["KUNA_IMPORT"] { app.launchArguments += ["-kunaImport", file] }
    app.launch()
    let labelled = { (text: String) in self.app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch }
    wait(app.buttons["agent-aaaa1111"], 40, "the fixture's agent")
    app.buttons["agent-aaaa1111"].tap()
    wait(said("The fit converged."), 30, "the agent's reply")
    app.swipeDown()
    sleep(1)
    // the fixture's three shell commands, the last failed: one row, the failed one still in view
    let folded = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Ran 3 shell commands · 1 failed")).firstMatch
    wait(folded, 10, "the three shell commands as one row")
    XCTAssertTrue(labelled("Run the tests").exists, "the failed command is not shown on the folded row")
    XCTAssertFalse(labelled("Draw the mass plot").exists, "a command that went well is shown while folded")
    shot("chat-rows-folded")
    folded.tap()
    wait(labelled("Draw the mass plot"), 5, "the commands, unfolded")
    XCTAssertTrue(labelled("Run the fit in the signal region").exists)
    shot("chat-rows-unfolded")
    // how long the context is: tokens out of the window, not a percentage
    let context = app.descendants(matching: .any)["context"]
    if wait(context, 10, "the context's length in the conversation") {
      XCTAssertTrue(context.label.contains("66k / 200k"), "the context reads \(context.label)")
    }
    shot("chat-rows-context")
    app.buttons["open-terminal"].tap()
    wait(app.buttons["key-Control"], 10, "the terminal")
    let there = app.descendants(matching: .any)["context"]
    if wait(there, 10, "the context's length over the terminal's keys") {
      XCTAssertTrue(there.label.contains("66k / 200k"), "the terminal's context reads \(there.label)")
    }
    sleep(1)
    shot("terminal-context")
  }

  /// The list of models: how long from the tap to rows to tap, and to the list read off the agent's
  /// screen (its effort row comes with that), cold, warm, and back on the agent's screen; a model and
  /// an effort picked, and a model tapped before the screen's list was there.
  func testModels() throws {
    app.launchArguments = ["-lock", "NO", "-opensTerminal", "NO", "-kunaStill", "YES"]
    if let file = ProcessInfo.processInfo.environment["KUNA_IMPORT"] { app.launchArguments += ["-kunaImport", file] }
    app.launch()
    let agent = app.buttons["agent-aaaa1111"]
    wait(agent, 40, "the fixture's agent")
    func open() {
      agent.tap()
      wait(said("The fit converged."), 30, "the agent's reply")
      wait(app.buttons["model-menu"], 20, "the model in the status line")
    }
    /// tap the model; seconds to the first row and to the screen's list
    func round(_ name: String) -> (rows: Double, live: Double) {
      let start = Date()
      app.buttons["model-menu"].tap()
      wait(app.buttons["model-option-1"], 30, "a model to tap (\(name))")
      let rows = Date().timeIntervalSince(start)
      shot("models-\(name)-rows")
      wait(app.buttons["effort-more"], 30, "the list read off the screen (\(name))")
      let live = Date().timeIntervalSince(start)
      shot("models-\(name)-live")
      note(String(format: "models %@: rows after %.2f s, the screen's list after %.2f s", name, rows, live))
      return (rows, live)
    }
    func dismiss() {
      app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
      sleep(1)
    }
    open()
    // the first time: the terminal is opened and /model typed
    _ = round("cold")
    app.buttons["effort-more"].tap()
    sleep(1)
    shot("models-effort")
    app.buttons["model-option-2"].tap()
    sleep(2)
    if app.buttons["model-option-2"].exists { XCTFail("the list of models stayed up after a model was picked") }
    shot("models-picked")
    // again with the terminal open; put away with Esc
    let warm = round("warm")
    dismiss()
    if app.buttons["effort-more"].exists { XCTFail("the list of models stayed up after it was put away") }
    // back on the agent's screen: its terminal was closed; a model tapped at once is picked once the screen has the list
    app.navigationBars.buttons.element(boundBy: 0).tap()
    sleep(1)
    open()
    let start = Date()
    app.buttons["model-menu"].tap()
    wait(app.buttons["model-option-3"], 30, "a model to tap (again)")
    let rows = Date().timeIntervalSince(start)
    shot("models-again-rows")
    app.buttons["model-option-3"].tap()
    let gone = NSPredicate(format: "exists == false")
    expectation(for: gone, evaluatedWith: app.buttons["model-option-3"])
    waitForExpectations(timeout: 30)
    note(String(format: "models again: rows after %.2f s, picked and closed after %.2f s", rows, Date().timeIntervalSince(start)))
    sleep(1)
    shot("models-again-picked")
    // a Claude Code background session: its screen is `claude attach` (the fixture's takes 3 s to
    // start), /model typed into it; meanwhile the list read before on this host is there to tap
    app.navigationBars.buttons.element(boundBy: 0).tap()
    let background = app.buttons["agent-cc-ffff6666"]
    if wait(background, 20, "the background session") {
      background.tap()
      wait(said("The scan is done"), 30, "the background session's conversation")
      if wait(app.buttons["model-menu"], 20, "the background session's model") {
        let start = Date()
        app.buttons["model-menu"].tap()
        wait(app.buttons["model-option-2"], 30, "the remembered list (background)")
        let remembered = Date().timeIntervalSince(start)
        shot("models-background-remembered")
        if app.buttons["effort-more"].exists { XCTFail("the screen's list was there already: the remembered one was not tried") }
        app.buttons["model-option-2"].tap()
        sleep(1)
        shot("models-background-waiting")
        expectation(for: gone, evaluatedWith: app.buttons["model-option-2"])
        waitForExpectations(timeout: 30)
        note(String(format: "models background: remembered rows after %.2f s, a remembered row picked and the list closed after %.2f s", remembered, Date().timeIntervalSince(start)))
        XCTAssertLessThan(remembered, 3, "no rows to tap at once in the background session")
        // its screen open now: the effort, and a model
        _ = round("background-warm")
        app.buttons["effort-more"].tap()
        sleep(1)
        app.buttons["model-option-3"].tap()
        sleep(2)
        if app.buttons["model-option-3"].exists { XCTFail("the background session's list stayed up after a model was picked") }
        shot("models-background-picked")
      }
    }
    // (XCUITest's own steps take about a second each: the app's log has the times without them)
    XCTAssertLessThan(rows, 3, "no rows to tap at once, with the list read before on this host")
    XCTAssertLessThan(warm.live, 5, "the list took long with the terminal open")
  }

  func testWalkthrough() throws {
    let env = ProcessInfo.processInfo.environment
    app.launchArguments = ["-lock", "NO", "-kunaStill", "YES"]
    if let file = env["KUNA_IMPORT"] { app.launchArguments += ["-kunaImport", file] }
    app.launch()

    // home: the project, its folder, the agents the fixture started
    let agent = app.buttons["agent-aaaa1111"]
    wait(agent, 40, "the fixture's agent on the home screen")
    sleep(2)
    shot("home")

    // an agent's conversation
    agent.tap()
    wait(said("The fit converged."), 30, "the agent's reply")
    sleep(1)
    shot("chat")
    // the tabs are for the three lists: not here
    if app.tabBars.buttons["Folders"].exists, app.tabBars.buttons["Folders"].isHittable { XCTFail("the tab bar is shown inside an agent's conversation") }
    // a long press takes a word, to stretch over any part of the text
    said("The fit converged.").press(forDuration: 1.2)
    sleep(1)
    shot("chat-select")
    app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
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
      wait(said("You said: Thanks, now the control region"), 30, "the fake agent's answer to what was sent")
      shot("chat-answered")
      // a slash offers Claude Code's commands; /model opens its panel, read off the agent's screen, to tap
      message.tap()
      message.typeText("/mod")
      if wait(app.buttons["slash-/model"], 10, "the commands offered for /mod") {
        shot("chat-slash")
        app.buttons["slash-/model"].tap()
        app.buttons["send"].tap()
        if wait(app.buttons["panel-option-2"], 40, "the model panel's rows") {
          // the keyboard's own button puts it away
          if app.buttons["keyboard"].exists { app.buttons["keyboard"].tap() }
          sleep(1)
          shot("chat-panel")
          app.buttons["panel-option-2"].tap()
          sleep(3)
          shot("chat-panel-picked")
        }
      }
      // the model's name lists the models by name, as Claude Code's own list has them; a tap changes it
      app.buttons["model-menu"].tap()
      if wait(app.buttons["model-option-3"], 40, "the models in the list") {
        sleep(1)
        shot("model-list")
        app.buttons["effort-more"].tap()
        sleep(2)
        shot("model-effort")
        app.buttons["model-option-3"].tap()
        sleep(3)
        shot("model-picked")
        if app.buttons["model-option-3"].exists { XCTFail("the list of models stayed up after a model was picked") }
      }
      // the other agents, a tap on the name away
      app.buttons["agent-switch"].tap()
      sleep(1)
      shot("chat-switcher")
      app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)).tap()
      sleep(1)
    }

    // its terminal
    // in place of the conversation; what it scrolled past is text above it, scrolled as any; Ctrl goes with the next key
    app.buttons["open-terminal"].tap()
    wait(app.buttons["key-Control"], 10, "the terminal")
    sleep(5)
    shot("terminal")
    let screen = app.windows.firstMatch
    screen.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(forDuration: 0.05, thenDragTo: screen.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7)))
    sleep(2)
    shot("terminal-scrolled")
    if wait(app.buttons["terminal-live"], 5, "the button back to the live screen, once scrolled back") {
      // a long press in what scrolled past takes a word, as in any text
      screen.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.3)).press(forDuration: 1.2)
      sleep(1)
      shot("terminal-select-history")
      app.buttons["terminal-live"].tap()
      sleep(1)
    }
    // a long press on the live screen holds it as text, with the word selected
    screen.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.142)).press(forDuration: 1.2)
    sleep(3)
    shot("terminal-select")
    if wait(app.buttons["terminal-live"], 5, "the live screen held as text") { app.buttons["terminal-live"].tap() }
    sleep(1)
    shot("terminal-live")
    app.buttons["key-Control"].tap()
    shot("terminal-ctrl")
    app.buttons["open-terminal"].tap()
    wait(app.buttons["send"], 10, "the conversation, back from the terminal")

    // plots and files
    app.buttons["agent-more"].tap()
    if wait(app.buttons["Plots and files"], 5) {
      app.buttons["Plots and files"].tap()
      sleep(5)
      shot("plots")
      // every group starts rolled up
      for group in app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'group-'")).allElementsBoundByIndex { group.tap() }
      shot("plots-unrolled")
      let first = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'media-'")).firstMatch
      if first.waitForExistence(timeout: 10) {
        first.tap()
        sleep(4)
        shot("viewer")
        // a prompt written while looking, hidden and still there in the conversation
        // (the list under the viewer has the same button: the one that can be tapped is the viewer's)
        let toggle = app.buttons.matching(identifier: "prompt-toggle").allElementsBoundByIndex.last(where: \.isHittable) ?? app.buttons["prompt-toggle"].firstMatch
        toggle.tap()
        sleep(2)
        // (and the conversation under both has the same box)
        let boxes = app.textFields.matching(identifier: "message").allElementsBoundByIndex + app.textViews.matching(identifier: "message").allElementsBoundByIndex
        let prompt = boxes.last(where: \.isHittable) ?? app.textFields["message"].firstMatch
        if wait(prompt, 10, "the prompt over the viewer") {
          // shown without the keyboard: the picture stays in view until the keyboard is asked for
          shot("viewer-prompt-open")
          prompt.tap()
          prompt.typeText("The pulls look off in the last bin")
          shot("viewer-prompt")
          toggle.tap()
          sleep(1)
        }
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
        wait(said("Review comments on"), 30, "the review comments in the conversation")
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
        // edited on the phone and saved back to the host
        app.buttons["viewer-edit"].tap()
        let editor = app.textViews["editor"]
        if wait(editor, 15, "the editor") {
          editor.tap()
          editor.typeText("# checked on the phone\n")
          shot("folder-edit")
          app.buttons["edit-save"].tap()
          wait(app.buttons["viewer-done"], 20, "the viewer, back from a saved edit")
          sleep(3)
          shot("folder-edited")
        }
        app.buttons["viewer-done"].tap()
        // kept on the Folders tab
        app.buttons["keep-place"].tap()
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
    // an agent with two questions: each as its screen shows it, answered by a tap
    let asking = app.buttons["agent-dddd4444"]
    if asking.waitForExistence(timeout: 5) {
      asking.tap()
      if wait(app.buttons["panel-option-2"], 40, "the first question's choices") {
        sleep(1)
        shot("question-1")
        app.buttons["panel-option-2"].tap()
        sleep(3)
        shot("question-2")
        app.buttons["panel-option-1"].tap()
        wait(said("Comparing with choice 2, log scale choice 1."), 30, "the agent going on with both answers")
        sleep(1)
        shot("question-answered")
      }
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
        if app.buttons["key-Control"].exists { app.buttons["open-terminal"].tap() }
        sleep(2)
        shot("new-agent-chat")
        app.navigationBars.buttons.element(boundBy: 0).tap()
      }
    }
    // a terminal in the same folder: the shell, on its own screen
    if wait(add, 10, "the folder's + button, back home") {
      add.tap()
      app.buttons["New terminal"].tap()
      if wait(app.buttons["key-Control"], 15, "the new terminal") {
        sleep(2)
        shot("new-terminal")
        app.navigationBars.buttons.element(boundBy: 0).tap()
      }
    }
    sleep(2)
    shot("home-after")
    // a Claude Code background session keeps its history to itself: a drag on its terminal is its mouse wheel
    let background = app.buttons["agent-cc-ffff6666"]
    if wait(background, 20, "the background session on the home screen") {
      background.tap()
      if wait(app.buttons["open-terminal"], 10, "the background session's screen") {
        app.buttons["open-terminal"].tap()
        wait(app.buttons["key-Control"], 10, "the background session's terminal")
        sleep(4)
        shot("background-terminal")
        let window = app.windows.firstMatch
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)))
        sleep(3)
        shot("background-terminal-scrolled")
        app.buttons["open-terminal"].tap()
      }
      app.navigationBars.buttons.element(boundBy: 0).tap()
      sleep(1)
    }

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

    // the other tabs: the folders kept to look through, and the settings
    app.tabBars.buttons["Folders"].tap()
    sleep(2)
    shot("folders")
    app.tabBars.buttons["Settings"].tap()
    sleep(1)
    shot("settings")
    app.swipeUp()
    sleep(1)
    shot("settings-haptics")
    // (scrolling down a list folds the tab bar into the tab in front; a tap on that unfolds it)
    if !app.tabBars.buttons["Agents"].exists { app.tabBars.buttons["Settings"].tap() }
    sleep(1)
    // what was open under Agents is still there
    app.tabBars.buttons["Agents"].tap()
    sleep(1)
    shot("home-again")
  }
}
