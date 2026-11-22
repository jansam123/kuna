#if os(iOS)
import KunaCore
import SwiftUI

/// The agents whose screens are open: each keeps its conversation and its terminal for as long
/// as it is on the navigation path, also while its plots or its review are on top.
@MainActor
final class OpenAgents {
  struct Open {
    let session: AgentSession
    let terminal: TerminalHolder
    /// review comments written and not yet sent
    let review: ReviewDraft
  }

  private var open: [String: Open] = [:]

  func get(_ key: String, _ model: AppModel) -> Open {
    if let found = open[key] { return found }
    let session = AgentSession(key: key, model: model)
    let made = Open(session: session, terminal: TerminalHolder(session: session), review: ReviewDraft())
    open[key] = made
    return made
  }

  func keep(only keys: Set<String>) {
    for (key, value) in open where !keys.contains(key) {
      value.session.close()
      open[key] = nil
    }
  }
}

/// One agent: its conversation, a line saying what it is doing, and a box to write to it.
struct AgentScreen: View {
  let model: AppModel
  let key: String
  @Binding var path: [Route]
  let open: OpenAgents
  @Environment(\.look) private var look
  @State private var draft = ""
  @State private var terminal = false
  @State private var sending = false
  @State private var failure: Notice?
  @State private var restart = false
  @State private var renaming = false
  @State private var name = ""
  @FocusState private var typing: Bool
  @State private var atEnd = true

  var body: some View {
    let here = open.get(key, model)
    let session = here.session
    VStack(spacing: 0) {
      if let agent = model.agent(key) {
        conversation(agent, session)
        StatusLine(agent: agent, details: session.details, terminal: { terminal = true })
        composer(agent, session)
      } else {
        ContentUnavailableView("This agent is gone", systemImage: "moon.zzz", description: Text("It is no longer on its host, or its host is not connected."))
      }
    }
    .background(look.ground)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if let agent = model.agent(key) {
        ToolbarItem(placement: .principal) {
          VStack(spacing: 1) {
            Text(model.name(of: agent)).font(.subheadline.weight(.semibold)).lineLimit(1)
            Text(place(agent)).font(.caption2).foregroundStyle(look.dim).lineLimit(1)
          }
        }
        ToolbarItemGroup(placement: .primaryAction) {
          Button("Terminal", systemImage: "apple.terminal") { terminal = true }.accessibilityIdentifier("open-terminal")
          Menu("More", systemImage: "ellipsis.circle") {
            Button("Plots and files", systemImage: "photo.on.rectangle.angled") { path.append(.plots(key)) }
            Button("Review changes", systemImage: "plus.forwardslash.minus") { path.append(.review(key)) }
            Button("Files of its folder", systemImage: "doc.text.magnifyingglass") { path.append(.files(agent.host, agent.base)) }
            if let place = model.place(of: key) {
              Button("New terminal here", systemImage: "apple.terminal") { Task { await startTerminal(model, place.project, place.folder, agent.base, $path, $failure) } }
            }
            Divider()
            Button("Rename", systemImage: "pencil") {
              name = model.name(of: agent)
              renaming = true
            }
            AgentActions(model: model, agent: agent, failure: $failure, gone: { path.removeAll { $0 == .agent(key) } })
          }
          .accessibilityIdentifier("agent-more")
        }
      }
    }
    .fullScreenCover(isPresented: $terminal) {
      TerminalScreen(model: model, session: session, holder: here.terminal, title: model.agent(key).map { model.name(of: $0) } ?? "").environment(\.look, look)
    }
    .alert("Name this agent", isPresented: $renaming) {
      TextField("Name", text: $name)
      Button("Save") { model.rename(key, to: name) }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Only on this phone. Empty takes its own title back.")
    }
    .alert(item: $failure) { Alert(title: Text($0.title), message: Text($0.text)) }
    .confirmationDialog("Start it again?", isPresented: $restart, titleVisibility: .visible) {
      Button("Start it and send") { send(session) }
    } message: {
      Text("This session is stopped. Sending a message starts it again on its host.")
    }
    .task(id: key) { await session.follow() }
    .onChange(of: model.agent(key)?.transcriptSize) { Task { await session.pull() } }
    .onAppear {
      // an agent that is not Claude Code has no conversation to read: its terminal is the agent
      if let agent = model.agent(key), !agent.isBackground, agent.sessionId == nil, agent.transcriptPath == nil { terminal = true }
    }
  }

  private func place(_ agent: Agent) -> String {
    let folder = (model.place(of: key)?.folder.name).map(model.plain) ?? agent.cwd.split(separator: "/").last.map(String.init) ?? agent.cwd
    return "\(folder) · \(agent.host)"
  }

  @ViewBuilder
  private func conversation(_ agent: Agent, _ session: AgentSession) -> some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          if !session.loaded {
            ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
          } else if session.items.isEmpty, session.outbox.isEmpty {
            Text(agent.transcriptPath == nil ? "Nothing to read yet. Its conversation shows up here once it has started; its terminal shows it as it is." : "No messages yet.")
              .font(.subheadline).foregroundStyle(look.dim).frame(maxWidth: .infinity).padding(.top, 40).padding(.horizontal, 24).multilineTextAlignment(.center)
          }
          ForEach(session.items) { item in ChatRow(item: item, terminal: { terminal = true }).id(item.id) }
          ForEach(session.outbox) { out in
            ChatRow(item: ChatItem(id: out.id.uuidString, kind: "user", text: out.text), terminal: {}, pending: true).id(out.id.uuidString)
          }
          Color.clear.frame(height: 1).id("end")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
      }
      .defaultScrollAnchor(.bottom)
      .scrollDismissesKeyboard(.interactively)
      // at the end, stay at the end as rows come; scrolled up to read, stay where the reader is
      .onScrollGeometryChange(for: Bool.self) { $0.contentOffset.y + $0.containerSize.height >= $0.contentSize.height - 120 } action: { _, now in atEnd = now }
      .onChange(of: session.items.last?.id) { if atEnd { proxy.scrollTo("end", anchor: .bottom) } }
      .onChange(of: session.outbox.count) { withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
      .onChange(of: typing) { if typing { withAnimation { proxy.scrollTo("end", anchor: .bottom) } } }
    }
  }

  @ViewBuilder
  private func composer(_ agent: Agent, _ session: AgentSession) -> some View {
    HStack(alignment: .bottom, spacing: 10) {
      TextField(agent.status == "waiting" ? "It is waiting for you…" : "Message", text: $draft, axis: .vertical)
        .lineLimit(1...7).focused($typing).padding(.horizontal, 14).padding(.vertical, 10)
        .background(look.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityIdentifier("message")
      Button {
        if agent.isBackground, !agent.alive { restart = true } else { send(session) }
      } label: {
        if sending { ProgressView().frame(width: 34, height: 34) } else { Image(systemName: "arrow.up.circle.fill").font(.system(size: 34)) }
      }
      .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      .accessibilityLabel("Send")
      .accessibilityIdentifier("send")
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(look.panel)
  }

  private func send(_ session: AgentSession) {
    let text = draft
    sending = true
    Task {
      do {
        try await session.send(text)
        if draft == text { draft = "" }
      } catch {
        failure = Notice(title: "Not sent", text: error.localizedDescription)
      }
      sending = false
    }
  }
}

/// What the agent is doing right now, and how full its context is.
private struct StatusLine: View {
  let agent: Agent
  let details: ChatDetails?
  let terminal: () -> Void
  @Environment(\.look) private var look

  var body: some View {
    HStack(spacing: 9) {
      if agent.status == "working" || agent.status == "starting" { ProgressView().controlSize(.mini) } else { StatusDot(status: agent.status, size: 8) }
      Text(words).font(.footnote).foregroundStyle(agent.status == "waiting" ? look.waiting : look.dim).lineLimit(2)
      Spacer(minLength: 4)
      if agent.status == "waiting" {
        Button("Answer", action: terminal).font(.footnote.weight(.semibold)).buttonStyle(.borderedProminent).controlSize(.small).tint(look.waiting).foregroundStyle(.black)
      } else if let context = agent.context ?? details?.context {
        Text("\(Int(context.pct))%").font(.caption.monospacedDigit()).foregroundStyle(context.level == "ok" ? look.faint : context.level == "full" ? look.danger : look.waiting)
          .accessibilityLabel("Context \(Int(context.pct)) percent full")
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 7)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(look.panel)
    .overlay(alignment: .top) { Divider().overlay(look.line) }
    .accessibilityIdentifier("status-line")
  }

  private var words: String {
    if agent.status == "waiting" { return agent.needs ?? "waiting for you" }
    let doing = agent.doing == agent.status ? statusWord(agent) : agent.doing
    return [doing, agent.modelName ?? details?.model].compactMap { $0 }.joined(separator: " · ")
  }
}

/// One row of the conversation. Each colour says one thing, as in the terminal: yours on the
/// accent, what was run or changed by what kind of work it is, green done, red failed, amber
/// a limit or a question for you.
private struct ChatRow: View {
  let item: ChatItem
  let terminal: () -> Void
  var pending = false
  @Environment(\.look) private var look
  @State private var unfolded = false

  var body: some View {
    switch item.kind {
    case "user":
      HStack {
        Spacer(minLength: 44)
        Text(item.text).font(item.text.hasPrefix("/") ? .body.monospaced() : .body).foregroundStyle(look.bright).padding(.horizontal, 13).padding(.vertical, 9)
          .background(look.raised.tint(look.accent, 0.3), in: RoundedRectangle(cornerRadius: 17, style: .continuous))
          .opacity(pending ? 0.55 : 1)
          .textSelection(.enabled)
      }
      .padding(.top, 6)
    case "assistant":
      MarkdownText(item.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu { Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = item.text } }
    case "limit": banner("hourglass", "Usage limit", look.waiting)
    case "error": banner("exclamationmark.triangle.fill", "The request failed", look.danger)
    case "thinking":
      VStack(alignment: .leading, spacing: 6) {
        Button { unfolded.toggle() } label: {
          HStack(spacing: 6) {
            Image(systemName: "chevron.right").font(.caption2.weight(.bold)).rotationEffect(.degrees(unfolded ? 90 : 0))
            Text("Thinking").font(.footnote.weight(.medium))
            if !unfolded { Text(item.text.prefix(80).replacingOccurrences(of: "\n", with: " ")).font(.footnote).italic().lineLimit(1).opacity(0.7) }
          }
          .foregroundStyle(look.dim)
        }
        .buttonStyle(.plain)
        if unfolded {
          Text(item.text).font(.footnote).italic().foregroundStyle(look.dim).textSelection(.enabled).padding(.leading, 12)
            .overlay(alignment: .leading) { Rectangle().fill(look.line).frame(width: 2) }
        }
      }
    case "tool":
      HStack(alignment: .firstTextBaseline, spacing: 7) {
        Group {
          switch item.state {
          case "error": Image(systemName: "xmark").foregroundStyle(look.danger)
          case "done": Image(systemName: "checkmark").foregroundStyle(look.green)
          default: Image(systemName: "circle.dotted").foregroundStyle(look.working)
          }
        }
        .font(.caption2.weight(.bold)).frame(width: 12)
        Text(item.tool ?? "tool").font(.system(size: 12.5, weight: .semibold, design: .monospaced)).foregroundStyle(item.state == "error" ? look.danger : work)
        Text(item.text).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(item.state == "error" ? look.danger.opacity(0.85) : look.dim).lineLimit(1).truncationMode(.middle)
      }
      .accessibilityElement(children: .combine)
    case "question":
      VStack(alignment: .leading, spacing: 9) {
        Label(item.tool == "Plan" ? "It proposes a plan" : "It asks", systemImage: item.tool == "Plan" ? "list.bullet.clipboard" : "questionmark.bubble")
          .font(.footnote.weight(.semibold)).foregroundStyle(item.state == "running" ? look.waiting : look.dim)
        MarkdownText(item.text)
        ForEach(Array((item.options ?? []).enumerated()), id: \.offset) { i, option in
          Text(item.state == "running" ? "\(i + 1). \(option)" : option).font(.subheadline).foregroundStyle(item.state == "running" ? look.text : look.green)
        }
        if item.state == "running" {
          Button("Answer in its terminal", systemImage: "apple.terminal", action: terminal).font(.footnote.weight(.semibold)).buttonStyle(.bordered)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(12)
      .background(look.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(item.state == "running" ? look.waiting.opacity(0.6) : look.line))
    default:
      HStack(spacing: 10) {
        Rectangle().fill(look.line).frame(height: 1)
        Text(item.text).font(.caption).foregroundStyle(look.dim).fixedSize()
        Rectangle().fill(look.line).frame(height: 1)
      }
      .padding(.vertical, 2)
    }
  }

  /// What Claude Code says in the agent's place, in the colour of what it means for you.
  private func banner(_ symbol: String, _ title: String, _ color: Color) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: symbol).foregroundStyle(color)
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(.footnote.weight(.semibold)).foregroundStyle(color)
        Text(item.text).font(.subheadline).foregroundStyle(look.text).textSelection(.enabled)
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .background(look.panel.tint(color, 0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(color.opacity(0.55)))
    .accessibilityIdentifier("chat-\(item.kind)")
  }

  /// a tool's name in the colour of its kind of work: green changes files, magenta runs a command, cyan hands work on, blue looks something up
  private var work: Color {
    switch item.tool ?? "" {
    case "Edit", "Write", "MultiEdit", "NotebookEdit": look.green
    case "Bash", "BashOutput", "KillShell": look.magenta
    case "Task", "Agent", "Workflow", "Skill": look.cyan
    case "Read", "Grep", "Glob", "WebFetch", "WebSearch", "ToolSearch": look.blue
    default: look.text
    }
  }
}
#endif
