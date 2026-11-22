#if os(iOS)
import KunaCore
import SwiftUI
import WebKit

/// Serves a web view its files. `kuna-app:` is the app's own script (Markdown, code and diffs);
/// `kuna-page:` is a folder on a host, read through the helper's `pcat`, which lets out only the
/// files a web page is made of from inside that folder (the same fence as the Mac's viewer).
@MainActor
final class PageServer: NSObject, WKURLSchemeHandler {
  private let model: AppModel
  private let host: String
  private let dir: String
  private var live = Set<ObjectIdentifier>()
  private static let script = Bundle.module.url(forResource: "kuna-web", withExtension: "js").flatMap { try? Data(contentsOf: $0) } ?? Data()

  /// `dir`: the folder on `host` the page's files may come from.
  init(model: AppModel, host: String, dir: String) {
    self.model = model
    self.host = host
    self.dir = dir
  }

  /// the app's own page: nothing in it but the script, which draws what the app hands it
  static let shell = """
    <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src kuna-page: data:; style-src 'unsafe-inline'; script-src kuna-app:; font-src data:">
    </head><body><div id="root"></div><script src="kuna-app://bundle/kuna-web.js"></script><script src="kuna-app://bundle/boot.js"></script></body></html>
    """

  func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
    let id = ObjectIdentifier(task)
    live.insert(id)
    guard let url = task.request.url else { return fail(task, 400) }
    if url.scheme == "kuna-app" {
      let body = url.path == "/boot.js" ? Data("KunaWeb.boot()".utf8) : Self.script
      return answer(task, url, body, "text/javascript; charset=utf-8", csp: nil)
    }
    struct File: Decodable { var path: String; var mime: String }
    guard let file = try? Shared.main.decode(File?.self, "pageFile", [dir, url.path]) else { return fail(task, 404) }
    let b64 = { (s: String) in Data(s.utf8).base64EncodedString() }
    Task {
      let read = try? await model.run(host, ["pcat", b64(dir.isEmpty ? "/" : dir), b64(file.path)], timeout: 180)
      guard live.contains(id) else { return }
      guard let read, read.code == 0 else { return fail(task, 404) }
      answer(task, url, read.stdout, file.mime, csp: try? Shared.main.call("pageCsp"))
    }
  }

  func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
    live.remove(ObjectIdentifier(task))
  }

  private func answer(_ task: any WKURLSchemeTask, _ url: URL, _ body: Data, _ mime: String, csp: String?) {
    guard live.remove(ObjectIdentifier(task)) != nil else { return }
    var headers = ["Content-Type": mime, "Cache-Control": "no-store", "Content-Length": String(body.count)]
    if let csp, !csp.isEmpty { headers["Content-Security-Policy"] = csp }
    guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else { return }
    task.didReceive(response)
    task.didReceive(body)
    task.didFinish()
  }

  private func fail(_ task: any WKURLSchemeTask, _ code: Int) {
    guard live.remove(ObjectIdentifier(task)) != nil else { return }
    task.didFailWithError(URLError(code == 404 ? .fileDoesNotExist : .badURL))
  }
}

/// What a web view shows.
enum WebContent: Equatable {
  case markdown(String)
  /// a file's text, with line numbers
  case code(path: String, text: String)
  /// a file before and after, as JSON for `KunaWeb.diff`
  case diff(String)
  case svg(Data)
  /// an HTML page of the host: the file's name in its folder
  case page(String)
}

/// A web view on one folder of one host. It loads nothing from anywhere else, except what a
/// page's own policy lets it take from the plotting libraries' CDNs.
struct WebPane: UIViewRepresentable {
  let model: AppModel
  let host: String
  let dir: String
  let content: WebContent
  /// a line of a diff was tapped: side (`old`, `new`), its number and its text
  var onLine: ((String, Int, String) -> Void)?

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    let server = PageServer(model: model, host: host, dir: dir)
    context.coordinator.server = server
    config.setURLSchemeHandler(server, forURLScheme: "kuna-page")
    config.setURLSchemeHandler(server, forURLScheme: "kuna-app")
    config.websiteDataStore = .nonPersistent()
    config.userContentController.add(context.coordinator, name: "kuna")
    if case .svg = content { config.defaultWebpagePreferences.allowsContentJavaScript = false }
    let view = WKWebView(frame: .zero, configuration: config)
    view.navigationDelegate = context.coordinator
    view.isOpaque = false
    view.backgroundColor = UIColor(hex: model.theme.ground)
    view.scrollView.backgroundColor = UIColor(hex: model.theme.ground)
    view.allowsLinkPreview = false
    context.coordinator.web = view
    context.coordinator.onLine = onLine
    context.coordinator.theme = model.theme
    context.coordinator.show(content)
    return view
  }

  func updateUIView(_ view: WKWebView, context: Context) {
    context.coordinator.onLine = onLine
    context.coordinator.theme = model.theme
    context.coordinator.show(content)
  }

  @MainActor
  final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var server: PageServer?
    weak var web: WKWebView?
    var onLine: ((String, Int, String) -> Void)?
    var theme = Theme.fallback
    private var shown: WebContent?
    private var ready = false
    /// the app's own page is loaded (Markdown, code, diff), as opposed to a host's page or a picture
    private var shell = false

    func show(_ content: WebContent) {
      guard content != shown, let web else { return }
      let before = shown
      shown = content
      switch content {
      case .svg(let data):
        shell = false
        // drawings are made for paper: on white, as they were meant
        web.backgroundColor = .white
        web.scrollView.backgroundColor = .white
        web.load(data, mimeType: "image/svg+xml", characterEncodingName: "utf-8", baseURL: URL(string: "about:blank")!)
      case .page(let name):
        shell = false
        if let url = URL(string: "kuna-page://h/" + (name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name)) { web.load(URLRequest(url: url)) }
      default:
        if shell, before != nil {
          draw()
        } else {
          shell = true
          ready = false
          web.loadHTMLString(PageServer.shell, baseURL: URL(string: "kuna-page://h/"))
        }
      }
    }

    private func draw() {
      guard ready, shell, let web, let shown else { return }
      let colors = ["ground": theme.ground, "panel": theme.panel, "raised": theme.raised, "line": theme.line, "text": theme.text, "dim": theme.dim, "faint": theme.faint, "accent": theme.accent, "waiting": theme.waiting]
      var script = "KunaWeb.theme(\(json(colors)));"
      switch shown {
      case .markdown(let text): script += "KunaWeb.markdown(\(json(text)));"
      case .code(let path, let text): script += "KunaWeb.code(\(json(path)),\(json(text)),false);"
      case .diff(let input): script += "KunaWeb.diff(\(input));"
      default: return
      }
      web.evaluateJavaScript(script)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
      guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
      if type == "ready" {
        ready = true
        draw()
      } else if type == "line", let side = body["side"] as? String, let line = body["line"] as? Int {
        onLine?(side, line, body["text"] as? String ?? "")
      }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
      let scheme = action.request.url?.scheme ?? ""
      if ["kuna-page", "kuna-app", "about", "data", "blob"].contains(scheme) { return decisionHandler(.allow) }
      // a link out: the browser's business, and only when it was tapped
      if action.navigationType == .linkActivated, scheme == "https" || scheme == "http", let url = action.request.url { UIApplication.shared.open(url) }
      decisionHandler(action.targetFrame?.isMainFrame == false && (scheme == "https" || scheme == "http") ? .allow : .cancel)
    }
  }
}
#endif
