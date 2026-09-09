import SwiftUI
import WebKit
import UniformTypeIdentifiers

/// Hosts the djsly web app from the bundled `web/` folder behind a custom scheme so it gets a real,
/// secure origin (AudioWorklet, crypto.subtle and IndexedDB all need one), plus native bridges:
///   midi  — CoreMIDI in/out exposed to the page as a Web MIDI polyfill (Safari has none)
///   file  — save a recording into Documents and offer the share sheet
struct DJWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: "djsly")
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.allowsPictureInPictureMediaPlayback = false
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        let ucc = cfg.userContentController
        ucc.add(context.coordinator, name: "midi")
        ucc.add(context.coordinator, name: "file")
        ucc.addUserScript(WKUserScript(source: MidiBridge.polyfill, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.isOpaque = false
        wv.backgroundColor = UIColor(red: 0.043, green: 0.051, blue: 0.071, alpha: 1)
        wv.scrollView.bounces = false
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.allowsBackForwardNavigationGestures = false
        wv.navigationDelegate = context.coordinator
        context.coordinator.webView = wv
        context.coordinator.midi.attach(to: wv)
        wv.load(URLRequest(url: URL(string: "djsly://app/index.html")!))
        return wv
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        weak var webView: WKWebView?
        let midi = MidiBridge()
        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any] else { return }
            switch message.name {
            case "midi":
                if let bytes = body["bytes"] as? [Int] { midi.send(bytes.map { UInt8(clamping: $0) }, to: body["id"] as? String) }
            case "file":
                if let name = body["name"] as? String, let b64 = body["b64"] as? String, let data = Data(base64Encoded: b64) { save(name: name, data: data) }
            default: break
            }
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { midi.pushDevices() }
        // External links (README etc.) open in Safari; everything else stays in the app.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let url = action.request.url, url.scheme == "http" || url.scheme == "https", action.navigationType == .linkActivated {
                UIApplication.shared.open(url); decisionHandler(.cancel); return
            }
            decisionHandler(.allow)
        }
        private func save(name: String, data: Data) {
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let url = docs.appendingPathComponent(name)
            try? data.write(to: url, options: .atomic)
            DispatchQueue.main.async {
                guard let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController }).first else { return }
                let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                share.popoverPresentationController?.sourceView = root.view
                share.popoverPresentationController?.sourceRect = CGRect(x: root.view.bounds.midX, y: root.view.bounds.maxY - 80, width: 1, height: 1)
                root.present(share, animated: true)
            }
        }
    }
}

/// djsly://app/<path> → Bundle/web/<path>
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
        if path.hasSuffix("/") { path += "index.html" }
        let file = root.appendingPathComponent(path)
        guard let data = FileManager.default.contents(atPath: file.path) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!)
            task.didReceive(Data("not found".utf8)); task.didFinish(); return
        }
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let headers = ["Content-Type": mime == "text/javascript" || file.pathExtension == "js" || file.pathExtension == "mjs" ? "text/javascript" : mime,
                       "Content-Length": String(data.count), "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*"]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data); task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
