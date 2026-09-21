import Cocoa
import Darwin
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  private var hopUp = false

  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    RegisterGeneratedPlugins(registry: flutterViewController)
    let channel = FlutterMethodChannel(
      name: "shear/privacy_hop",
      binaryMessenger: flutterViewController.engine.binaryMessenger)
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self = self else { return }
      switch call.method {
      case "connect":
        self.probeHop { ok, message in
          self.hopUp = false
          result([
            "ok": false,
            "connected": false,
            "fullTunnelActive": false,
            "message": message,
          ])
        }
      case "disconnect":
        self.hopUp = false
        result(["ok": true, "connected": false, "message": "Disconnected"])
      case "status":
        result([
          "ok": self.hopUp,
          "connected": self.hopUp,
          "fullTunnelActive": self.hopUp,
          "message": self.hopUp ? "SHEAR-HOP / EU up" : "Hop off",
        ])
      default:
        result(FlutterMethodNotImplemented)
      }
    }

    super.awakeFromNib()
  }

  private func probeHop(done: @escaping (Bool, String) -> Void) {
    let fd = socket(AF_INET, SOCK_DGRAM, 0)
    if fd < 0 {
      done(false, "UDP socket failed")
      return
    }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(44044).bigEndian
    inet_pton(AF_INET, "77.42.35.12", &addr.sin_addr)
    var magic: [CChar] = [82, 80, 84, 50] // RPT2
    _ = magic.withUnsafeBufferPointer { buf in
      withUnsafePointer(to: &addr) { ap in
        ap.withMemoryRebound(to: sockaddr.self, capacity: 1) { sap in
          sendto(fd, buf.baseAddress, 4, 0, sap, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
      }
    }
    var tv = timeval(tv_sec: 2, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    var buf = [CChar](repeating: 0, count: 64)
    let n = recvfrom(fd, &buf, buf.count, 0, nil, nil)
    close(fd)
    // UDP reachability is not a residual session. Packet Tunnel HELLO is a MacBook cut.
    done(
      false,
      n > 0
        ? "SHEAR-HOP / EU is reachable on UDP 44044. macOS Packet Tunnel residual HELLO is a MacBook cut — use Privacy hop on Android, or a local Shear node."
        : "No residual HELLO reply from SHEAR-HOP / EU. Use Privacy hop on Android, or a local Shear node.")
  }
}
