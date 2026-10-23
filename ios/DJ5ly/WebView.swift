import SwiftUI
import WebKit
import UniformTypeIdentifiers
#if os(iOS)
import UIKit
typealias PlatformViewRepresentable = UIViewRepresentable
#else
import AppKit
typealias PlatformViewRepresentable = NSViewRepresentable
#endif

/// Hosts the djsly web app from the bundled `web/` folder behind a custom scheme so it gets a real,
/// secure origin (AudioWorklet, crypto.subtle and IndexedDB all need one), plus native bridges:
///   midi  — CoreMIDI in/out exposed to the page as a Web MIDI polyfill (WebKit has none)
///   file  — save a recording (iPhone: Documents + share sheet, Mac: ~/Music/DJ5ly + Finder)
struct DJWebView: PlatformViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    #if os(iOS)
    func makeUIView(context: Context) -> WKWebView { makeWebView(context.coordinator) }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
    #else
    func makeNSView(context: Context) -> WKWebView { makeWebView(context.coordinator) }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
    #endif

    private func makeWebView(_ coordinator: Coordinator) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: "djsly")
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        #if os(iOS)
        cfg.allowsInlineMediaPlayback = true
        cfg.allowsPictureInPictureMediaPlayback = false
        #endif
        let ucc = cfg.userContentController
        ucc.add(coordinator, name: "midi")
        ucc.add(coordinator, name: "file")
        ucc.addUserScript(WKUserScript(source: MidiBridge.polyfill, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let wv = WKWebView(frame: .zero, configuration: cfg)
        #if os(iOS)
        wv.isOpaque = false
        wv.backgroundColor = UIColor(red: 0.043, green: 0.051, blue: 0.071, alpha: 1)
        wv.scrollView.bounces = false
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        #else
        wv.underPageBackgroundColor = NSColor(red: 0.043, green: 0.051, blue: 0.071, alpha: 1)
        wv.isInspectable = true   // right-click → Inspect Element
        #endif
        wv.allowsBackForwardNavigationGestures = false
        wv.navigationDelegate = coordinator
        wv.uiDelegate = coordinator
        coordinator.webView = wv
        coordinator.midi.attach(to: wv)
        wv.load(URLRequest(url: URL(string: "djsly://app/index.html")!))
        return wv
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
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
        // External links (README etc.) open in the browser; everything else stays in the app.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let url = action.request.url, url.scheme == "http" || url.scheme == "https", action.navigationType == .linkActivated {
                #if os(iOS)
                UIApplication.shared.open(url)
                #else
                NSWorkspace.shared.open(url)
                #endif
                decisionHandler(.cancel); return
            }
            decisionHandler(.allow)
        }
        #if os(iOS)
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
        #else
        private func save(name: String, data: Data) {
            let dir = FileManager.default.urls(for: .musicDirectory, in: .userDomainMask)[0].appendingPathComponent("DJ5ly", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(name)
            guard (try? data.write(to: url, options: .atomic)) != nil else { return }
            DispatchQueue.main.async { NSWorkspace.shared.activateFileViewerSelecting([url]) }
        }
        // WKWebView on macOS ignores <input type=file> unless the host shows the panel itself.
        func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.canChooseDirectories = parameters.allowsDirectories
            panel.canChooseFiles = true
            panel.allowedContentTypes = [.audio]
            panel.directoryURL = FileManager.default.urls(for: .musicDirectory, in: .userDomainMask).first
            panel.begin { completionHandler($0 == .OK ? panel.urls : nil) }
        }
        #endif
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
