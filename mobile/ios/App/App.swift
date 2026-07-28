import SwiftUI
import WebKit

/// Change BASE_URL to your HTTPS production domain before App Store submit.
private let BASE_URL = URL(string: "https://removecarbackground.com/editor.html")!

struct WebView: UIViewRepresentable {
    let url: URL
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.load(URLRequest(url: url))
        return wv
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

@main
struct RemoveCarBackgroundApp: App {
    var body: some Scene {
        WindowGroup {
            WebView(url: BASE_URL)
                .ignoresSafeArea()
        }
    }
}
