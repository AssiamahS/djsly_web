import SwiftUI
import AVFoundation

@main
struct DJ5lyApp: App {
    init() {
        #if os(iOS)
        // Keep Web Audio alive with the screen locked and let the mixer own the output.
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [.allowBluetoothA2DP, .allowAirPlay])
        try? session.setPreferredIOBufferDuration(0.005)
        try? session.setActive(true)
        #endif
    }
    var body: some Scene {
        WindowGroup {
            ZStack {
                Color(red: 0.043, green: 0.051, blue: 0.071).ignoresSafeArea()
                DJWebView().ignoresSafeArea()
            }
            .preferredColorScheme(.dark)
            #if os(iOS)
            .persistentSystemOverlays(.hidden)
            #else
            .frame(minWidth: 900, minHeight: 560)
            #endif
        }
        #if os(macOS)
        .defaultSize(width: 1280, height: 800)
        .windowToolbarStyle(.unifiedCompact)
        #endif
    }
}
