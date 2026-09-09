import Foundation
import CoreMIDI
import WebKit

/// CoreMIDI ⇄ page. Every source (USB controller through a camera/USB-C adapter, Bluetooth MIDI, network
/// MIDI) is connected to one input port; bytes are forwarded to the page's Web MIDI polyfill, and the
/// page's `output.send()` comes back here and goes to the matching destination (LEDs on the SB3).
final class MidiBridge {
    static let polyfill = """
    (() => {
      const inputs = new Map(), outputs = new Map(); const access = { inputs, outputs, onstatechange: null, sysexEnabled: false };
      const post = m => window.webkit?.messageHandlers?.midi?.postMessage(m);
      window.__djslyMidi = {
        devices(ins, outs) {
          inputs.clear(); outputs.clear();
          for (const d of ins) inputs.set(d.id, { id: d.id, name: d.name, manufacturer: d.manufacturer || '', state: 'connected', type: 'input', onmidimessage: null });
          for (const d of outs) outputs.set(d.id, { id: d.id, name: d.name, manufacturer: d.manufacturer || '', state: 'connected', type: 'output', send: bytes => post({ id: d.id, bytes: Array.from(bytes) }) });
          access.onstatechange?.({ port: null });
        },
        recv(id, bytes) { const inp = inputs.get(id); if (inp?.onmidimessage) inp.onmidimessage({ data: new Uint8Array(bytes), timeStamp: performance.now() }); },
      };
      navigator.requestMIDIAccess = () => Promise.resolve(access);
      window.__djslyNative = { midi: true, file: !!window.webkit?.messageHandlers?.file };
    })();
    """
    private var client = MIDIClientRef()
    private var inPort = MIDIPortRef()
    private var outPort = MIDIPortRef()
    private weak var webView: WKWebView?
    private var sources: [MIDIEndpointRef] = []
    private var destinations: [MIDIEndpointRef] = []

    func attach(to webView: WKWebView) {
        self.webView = webView
        MIDIClientCreateWithBlock("DJ5ly" as CFString, &client) { [weak self] _ in DispatchQueue.main.async { self?.reconnect() } }
        MIDIInputPortCreateWithProtocol(client, "DJ5ly In" as CFString, ._1_0, &inPort) { [weak self] list, srcRefCon in
            guard let self else { return }
            let src = MIDIEndpointRef(UInt(bitPattern: srcRefCon))   // connRefCon carries the endpoint ref itself
            self.handle(list: list, from: src)
        }
        MIDIOutputPortCreate(client, "DJ5ly Out" as CFString, &outPort)
        reconnect()
    }

    private func reconnect() {
        for s in sources { MIDIPortDisconnectSource(inPort, s) }
        sources = (0..<MIDIGetNumberOfSources()).map { MIDIGetSource($0) }
        destinations = (0..<MIDIGetNumberOfDestinations()).map { MIDIGetDestination($0) }
        for s in sources { MIDIPortConnectSource(inPort, s, UnsafeMutableRawPointer(bitPattern: UInt(s))) }
        pushDevices()
    }

    func pushDevices() {
        let ins = sources.map { ["id": "in-\($0)", "name": name(of: $0), "manufacturer": prop($0, kMIDIPropertyManufacturer)] }
        let outs = destinations.map { ["id": "out-\($0)", "name": name(of: $0), "manufacturer": prop($0, kMIDIPropertyManufacturer)] }
        guard let insJSON = try? JSONSerialization.data(withJSONObject: ins), let outsJSON = try? JSONSerialization.data(withJSONObject: outs) else { return }
        let js = "window.__djslyMidi && __djslyMidi.devices(\(String(decoding: insJSON, as: UTF8.self)), \(String(decoding: outsJSON, as: UTF8.self)))"
        DispatchQueue.main.async { self.webView?.evaluateJavaScript(js) }
    }

    private func handle(list: UnsafePointer<MIDIEventList>, from src: MIDIEndpointRef) {
        var batches: [[Int]] = []
        for packet in list.unsafeSequence() {
            let words = Array(packet.sequence())
            var i = 0
            while i < words.count {
                let w = words[i]; let type = (w >> 28) & 0xF
                switch type {
                case 2: batches.append([Int((w >> 16) & 0xFF), Int((w >> 8) & 0xFF), Int(w & 0xFF)]); i += 1      // MIDI 1.0 channel voice
                case 1: batches.append([Int((w >> 16) & 0xFF), Int((w >> 8) & 0xFF), Int(w & 0xFF)]); i += 1      // system common
                case 3: i += 2                                                                                    // sysex 7-bit (2 words) — ignored
                case 4: i += 2; case 5: i += 4; default: i += 1
                }
            }
        }
        guard !batches.isEmpty else { return }
        let id = "in-\(src)"
        let js = batches.map { "__djslyMidi.recv('\(id)',[\($0.map(String.init).joined(separator: ","))]);" }.joined()
        DispatchQueue.main.async { self.webView?.evaluateJavaScript(js) }
    }

    func send(_ bytes: [UInt8], to id: String?) {
        let targets = destinations.filter { id == nil || "out-\($0)" == id }
        guard !targets.isEmpty, !bytes.isEmpty else { return }
        var list = MIDIPacketList()
        let pkt = MIDIPacketListInit(&list)
        _ = MIDIPacketListAdd(&list, MemoryLayout<MIDIPacketList>.size, pkt, 0, bytes.count, bytes)
        for d in targets { MIDISend(outPort, d, &list) }
    }

    private func name(of ep: MIDIEndpointRef) -> String {
        let disp = prop(ep, kMIDIPropertyDisplayName); if !disp.isEmpty { return disp }
        return prop(ep, kMIDIPropertyName)
    }
    private func prop(_ ep: MIDIEndpointRef, _ key: CFString) -> String {
        var s: Unmanaged<CFString>?; MIDIObjectGetStringProperty(ep, key, &s); return (s?.takeRetainedValue() as String?) ?? ""
    }
}
