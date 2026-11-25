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

  /// The box that can be typed into, of the ones on top of each other (conversation, list, viewer).
  func topMessageBox() -> XCUIElement {
    let boxes = app.textFields.matching(identifier: "message").allElementsBoundByIndex + app.textViews.matching(identifier: "message").allElementsBoundByIndex
    return boxes.last(where: \.isHittable) ?? app.textFields["message"].firstMatch
  }

  /// The viewer's back arrow, its bar brought back first if a tap or a swipe hid it.
  func closeViewer() {
    let back = app.buttons["viewer-done"]
    if !back.exists {
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).tap()
      _ = back.waitForExistence(timeout: 3)
    }
    if back.exists { back.tap() }
  }

  /// Settings ▸ An agent opens in: `Terminal` or `Conversation`; back on the Projects tab after.
  func opensIn(_ which: String, _ name: String? = nil) {
    app.tabBars.buttons["Settings"].tap()
    let segment = app.segmentedControls.buttons[which]
    for _ in 0..<5 where !(segment.exists && segment.isHittable) { app.swipeUp() }
    if wait(segment, 5, "the setting for what an agent opens in") { segment.tap() }
    sleep(1)
    if let name { shot(name) }
    // (scrolling down a list folds the tab bar into the tab in front; a tap on that unfolds it)
    if !app.tabBars.buttons["Projects"].exists { app.tabBars.buttons["Settings"].tap() }
    app.tabBars.buttons["Projects"].tap()
  }

  /// An agent opens on its terminal (or, by the setting, its conversation); the key row starts with
  /// the arrows; one button rolls every project in and out; the first tab is Projects; the
  /// viewer's prompt stays put while the agent works, and what is sent then waits for the turn's end.
  func testDefaultsAndPrompt() throws {
    let env = ProcessInfo.processInfo.environment
    // no -opensTerminal here: the setting itself is what is tried
    app.launchArguments = ["-lock", "NO", "-kunaStill", "YES"]
    if let file = env["KUNA_IMPORT"] { app.launchArguments += ["-kunaImport", file] }
    app.launch()
    let agent = app.buttons["agent-aaaa1111"]
    wait(agent, 40, "the fixture's agent on the home screen")
    XCTAssertTrue(app.tabBars.buttons["Projects"].exists, "the first tab is called Projects")
    XCTAssertFalse(app.tabBars.buttons["Agents"].exists, "no tab is called Agents any more")
    // from the default, whatever an earlier run left
    opensIn("Terminal")
    sleep(1)
    shot("defaults-home")

    // everything rolled in with one button, and out again
    app.buttons["roll-all"].tap()
    sleep(1)
    shot("defaults-rolled-in")
    XCTAssertFalse(agent.exists, "an agent still shows with every project rolled in")
    XCTAssertFalse(app.buttons["agent-cccc3333"].exists, "an agent of the second project still shows with every project rolled in")
    app.buttons["roll-all"].tap()
    wait(agent, 10, "the agent, with every project rolled out again")
    wait(app.buttons["agent-cccc3333"], 5, "the second project's agent, rolled out again")
    shot("defaults-rolled-out")

    // its terminal first, the arrows first in the key row
    agent.tap()
    if wait(app.buttons["key-Control"], 20, "the agent's terminal, shown first") {
      sleep(2)
      shot("defaults-terminal-first")
      let x = { (name: String) in self.app.buttons["key-\(name)"].frame.minX }
      XCTAssertLessThan(x("Keyboard"), x("Up"), "the keyboard's button before the arrows")
      XCTAssertLessThan(x("Up"), x("Down"))
      XCTAssertLessThan(x("Left"), x("Right"))
      XCTAssertLessThan(x("Right"), x("Control"), "the arrows before ctrl")
      XCTAssertLessThan(x("Command"), x("Escape"), "ctrl and ⌘ before esc")
      XCTAssertLessThan(x("Escape"), x("Tab"))
    }
    app.navigationBars.buttons.element(boundBy: 0).tap()

    // the setting: its conversation first
    opensIn("Conversation", "defaults-setting")
    agent.tap()
    wait(said("The fit converged."), 30, "the agent's conversation, shown first by the setting")
    XCTAssertFalse(app.buttons["key-Control"].exists, "the terminal shown, though the setting says the conversation")
    shot("defaults-conversation-first")
    app.navigationBars.buttons.element(boundBy: 0).tap()

    // the slides of an agent at work, with the prompt over them
    let working = app.buttons["agent-cccc3333"]
    if wait(working, 10, "the agent at work") {
      working.tap()
      wait(app.buttons["send"], 20, "the working agent's conversation")
      app.buttons["agent-more"].tap()
      app.buttons["Plots and files"].tap()
      // (under Slides once the PDF has been read; a group's tap before that would be undone)
      let group = app.buttons["group-slides"]
      _ = group.waitForExistence(timeout: 30)
      shot("working-plots")
      if wait(group, 1, "the Slides group") { group.tap() }
      let slides = app.buttons["media-talk.pdf"]
      if wait(slides, 20, "the working agent's slides") {
        slides.tap()
        sleep(3)
        let toggle = app.buttons.matching(identifier: "prompt-toggle").allElementsBoundByIndex.last(where: \.isHittable) ?? app.buttons["prompt-toggle"].firstMatch
        toggle.tap()
        sleep(1)
        let prompt = topMessageBox()
        if wait(prompt, 10, "the prompt over the slides") {
          prompt.tap()
          prompt.typeText("Make the title")
          sleep(1)
          // written into while the agent works: the box stays where it is
          let start = prompt.frame
          var moved: [CGRect] = []
          // (a letter typed and taken back: the text stays on one line, so the box has no reason to grow)
          for i in 0..<12 where app.keyboards.count > 0 {
            prompt.typeText(i.isMultiple(of: 2) ? "x" : XCUIKeyboardKey.delete.rawValue)
            usleep(500_000)
            let now = prompt.frame
            if abs(now.minY - start.minY) > 0.5 || abs(now.maxY - start.maxY) > 0.5 { moved.append(now) }
            if i == 5 { shot("viewer-prompt-working") }
          }
          XCTAssertTrue(app.keyboards.count > 0, "the keyboard went down while the agent worked")
          print("kuna: the box at \(start), moved to \(moved)")
          XCTAssertTrue(moved.isEmpty, "the prompt moved while the agent worked: from \(start) to \(moved)")
          shot("viewer-prompt-still")

          // sent in the middle of the turn: queued, and taken back
          app.buttons.matching(identifier: "send").allElementsBoundByIndex.last(where: \.isHittable)?.tap()
          let queued = app.descendants(matching: .any).matching(identifier: "queued").firstMatch
          if wait(queued, 10, "the message, queued while the agent works") {
            shot("viewer-queued")
            app.buttons.matching(identifier: "unqueue").allElementsBoundByIndex.last(where: \.isHittable)?.tap()
            sleep(1)
            XCTAssertFalse(queued.exists, "the message taken back is still queued")
            shot("viewer-unqueued")
          }
          // queued again, and typed into the agent once its turn is over
          prompt.typeText("Make the title bigger")
          app.buttons.matching(identifier: "send").allElementsBoundByIndex.last(where: \.isHittable)?.tap()
          if wait(queued, 10, "the message, queued again") {
            sleep(4)
            XCTAssertTrue(queued.exists, "the queued message went before the turn was over")
            shot("viewer-queued-again")
            if let home = env["KUNA_HOME"] { FileManager.default.createFile(atPath: "\(home)/.turn-over-cccc3333", contents: Data()) }
            let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: queued)
            wait(for: [gone], timeout: 40)
            sleep(1)
            shot("viewer-queue-sent")
          }
        }
        closeViewer()
      }
      app.navigationBars.buttons.element(boundBy: 0).tap()
      wait(said("You said: Make the title bigger"), 30, "the queued message, answered after the turn")
      wait(said("The tagger is trained"), 5, "the turn that the message waited for")
      sleep(1)
      shot("queued-answered")
      app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    // the default again, for whatever runs next
    opensIn("Terminal")
  }

  /// A file a reply names opens in the viewer from the conversation; its bar goes on a tap and on
  /// scrolling, and on its side the file has the whole screen; the back arrow goes back to the conversation.
  func testFileFromChat() throws {
    app.launchArguments = ["-lock", "NO", "-opensTerminal", "NO", "-kunaStill", "YES"]
    if let file = ProcessInfo.processInfo.environment["KUNA_IMPORT"] { app.launchArguments += ["-kunaImport", file] }
    app.launch()
    wait(app.buttons["agent-aaaa1111"], 40, "the fixture's agent")
    app.buttons["agent-aaaa1111"].tap()
    wait(said("The fit converged."), 30, "the agent's reply")
    let link = app.links["plots/pulls.pdf"].firstMatch
    guard wait(link, 10, "the PDF the reply names, as a link") else { return }
    shot("chat-file-link")
    link.tap()
    let back = app.buttons["viewer-done"]
    guard wait(back, 20, "the viewer, opened on the file") else { return }
    wait(app.staticTexts["pulls.pdf"], 5, "the file the reply named, in view")
    sleep(3)
    shot("chat-file-viewer")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).tap()
    sleep(1)
    XCTAssertFalse(back.exists, "a tap on the file left its bar")
    shot("chat-file-bare")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).tap()
    wait(back, 3, "the bar, back after a second tap")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)))
    sleep(1)
    XCTAssertFalse(back.exists, "scrolling the file left its bar")
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).tap()
    wait(back, 3, "the bar, back after a tap")
    XCUIDevice.shared.orientation = .landscapeLeft
    sleep(3)
    XCTAssertFalse(back.exists, "on its side the file shares the screen with its bar")
    shot("chat-file-landscape")
    XCUIDevice.shared.orientation = .portrait
    sleep(2)
    wait(back, 3, "the bar, back upright")
    back.tap()
    wait(said("The fit converged."), 10, "the conversation, back from the file")
    shot("chat-file-back")
  }

  /// A swipe to the left removes an agent, as Ctrl+X Ctrl+X on the Mac: half way it shows the
  /// button, all the way it goes. `scripts/ios-sim.sh` checks the host after: the
  /// tmux agent ended, the background session `claude rm`-ed.
  func testSwipeRemoves() throws {
    app.launchArguments = ["-lock", "NO", "-kunaStill", "YES"]
    if let file = ProcessInfo.processInfo.environment["KUNA_IMPORT"] { app.launchArguments += ["-kunaImport", file] }
    app.launch()
    let tmux = app.buttons["agent-hhhh8888"], background = app.buttons["agent-cc-ffff9999"]
    wait(tmux, 40, "the agent to swipe away")
    wait(background, 20, "the stopped background session to swipe away")
    for _ in 0..<6 where !(background.isHittable && tmux.isHittable) { app.swipeUp() }
    // half way: the button, and a tap on it
    let from = tmux.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
    from.press(forDuration: 0.05, thenDragTo: tmux.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.5)), withVelocity: .slow, thenHoldForDuration: 0.1)
    let button = app.buttons["agent-delete-hhhh8888"]
    if wait(button, 5, "the delete button half way through a swipe") {
      shot("swipe-half-way")
      button.tap()
    }
    // all the way across
    background.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).press(forDuration: 0.05, thenDragTo: background.coordinate(withNormalizedOffset: CGVector(dx: 0.0, dy: 0.5)))
    for (row, what) in [(tmux, "the swiped agent"), (background, "the swiped background session")] {
      let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: row)
      if XCTWaiter().wait(for: [gone], timeout: 20) != .completed { XCTFail("\(what) is still on the list") }
    }
    shot("swiped-away")
  }

  /// A terminal on screen leaves the app idle for XCUITest: every step there is quick.
  func testTerminalIsQuick() throws {
    app.launchArguments = ["-lock", "NO", "-kunaStill", "YES", "-opensTerminal", "NO"]
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

  /// Claude Code's questions as cards, against the fake's copies of Claude Code 2.1.330's screens:
  /// one answer picked, one typed, boxes ticked and sent, a set through its review, a permission,
  /// and /compact after a reply that asks, with no card.
  func testQuestions() throws {
    app.launchArguments = ["-lock", "NO", "-opensTerminal", "NO", "-kunaStill", "YES"]
    if let file = ProcessInfo.processInfo.environment["KUNA_IMPORT"] { app.launchArguments += ["-kunaImport", file] }
    app.launch()
    let agent = app.buttons["agent-gggg7777"]
    wait(agent, 40, "the agent that asks, on the home screen")
    agent.tap()
    wait(said("The fit converged."), 30, "its conversation")
    let message = app.textFields["message"].exists ? app.textFields["message"] : app.textViews["message"]
    let review = app.descendants(matching: .any)["panel-review"]
    func send(_ text: String) {
      message.tap()
      message.typeText(text)
      app.buttons["send"].tap()
    }
    func card(_ what: String) -> Bool {
      let up = wait(app.buttons["panel-option-1"], 40, what)
      sleep(1)
      // a question puts the keyboard away, so the whole card shows
      if up, app.keyboards.count > 0 { XCTFail("the keyboard stayed up over \(what)") }
      return up
    }

    // one question: a tap picks, and the agent goes on with it
    send("ask one")
    if card("the question's rows") {
      shot("q-one")
      XCTAssertTrue(app.staticTexts["Which colour do you prefer?"].exists, "the question is not on its card")
      app.buttons["panel-option-2"].tap()
      wait(said("Answers: Green."), 30, "the agent going on with the pick")
      sleep(1)
      shot("q-one-answered")
    }
    // an answer of one's own: "Type something." hands the prompt box to the question
    send("ask one")
    if card("the question again") {
      app.buttons["panel-option-4"].tap()
      if wait(app.descendants(matching: .any)["answering"], 10, "the prompt box taking the answer") {
        shot("q-type")
        message.typeText("Purple please")
        shot("q-typed")
        app.buttons["send"].tap()
      }
      wait(said("Answers: Purple please."), 30, "the typed answer reaching the agent")
      sleep(1)
      shot("q-type-answered")
    }
    // several answers: two ticked, Submit, the review, sent
    send("ask many")
    if card("the boxes") {
      app.buttons["panel-option-1"].tap()
      sleep(1)
      app.buttons["panel-option-3"].tap()
      sleep(2)
      shot("q-many-ticked")
      XCTAssertEqual(app.buttons["panel-option-1"].value as? String, "ticked")
      XCTAssertEqual(app.buttons["panel-option-2"].value as? String, "not ticked")
      XCTAssertEqual(app.buttons["panel-option-3"].value as? String, "ticked")
      app.buttons["panel-option-5"].tap()
      if wait(review, 20, "the review of the ticks") {
        sleep(1)
        shot("q-many-review")
        app.buttons["panel-option-1"].tap()
      }
      wait(said("Answers: Apple, Cherry."), 30, "the ticks reaching the agent")
      sleep(1)
      shot("q-many-answered")
    }
    // two questions at once: one picked, the next ticked, the review, sent
    send("ask set")
    if card("the first question of the set") {
      shot("q-set-1")
      app.buttons["panel-option-2"].tap()
      if wait(app.staticTexts["Which toppings?"], 20, "the second question of the set") {
        sleep(1)
        shot("q-set-2")
        app.buttons["panel-option-1"].tap()
        sleep(1)
        app.buttons["panel-option-2"].tap()
        sleep(2)
        shot("q-set-2-ticked")
        app.buttons["panel-option-4"].tap()
      }
      if wait(review, 20, "the review of the set") {
        sleep(1)
        shot("q-set-review")
        app.buttons["panel-option-1"].tap()
      }
      wait(said("Answers: Large; Cheese, Olives."), 30, "the set's answers reaching the agent")
      sleep(1)
      shot("q-set-answered")
    }
    // a permission
    send("run it")
    if card("the permission") {
      shot("q-permission")
      app.buttons["panel-option-1"].tap()
      wait(said("Ran make plots"), 30, "the command run once allowed")
      sleep(1)
      shot("q-permission-answered")
    }
    // /compact after a reply that asks: the reply is drawn again over the input box, and is no question
    send("Do you want to keep going?")
    wait(said("You said: Do you want to keep going?"), 30, "the reply that asks")
    send("/compact")
    sleep(4)
    shot("q-compacting")
    sleep(6)
    shot("q-compacted")
    XCTAssertFalse(app.descendants(matching: .any)["panel"].exists, "a card came up after /compact")
    app.navigationBars.buttons.element(boundBy: 0).tap()
  }

  func testWalkthrough() throws {
    let env = ProcessInfo.processInfo.environment
    app.launchArguments = ["-lock", "NO", "-kunaStill", "YES", "-opensTerminal", "NO"]
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
        closeViewer()
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
        // a set of questions ends in the review of its answers, as Claude Code's does
        if wait(app.descendants(matching: .any)["panel-review"], 20, "the review of both answers") {
          sleep(1)
          shot("question-review")
          app.buttons["panel-option-1"].tap()
        }
        wait(said("Answers: Only the new one; Yes."), 30, "the agent going on with both answers")
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
    if !app.tabBars.buttons["Projects"].exists { app.tabBars.buttons["Settings"].tap() }
    sleep(1)
    // what was open under Projects is still there
    app.tabBars.buttons["Projects"].tap()
    sleep(1)
    shot("home-again")
  }
}
