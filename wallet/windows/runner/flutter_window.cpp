#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>

#include "flutter_window.h"

#include <optional>

#include <flutter/encodable_value.h>
#include <flutter/method_channel.h>
#include <flutter/standard_method_codec.h>

#include "flutter/generated_plugin_registrant.h"

#pragma comment(lib, "ws2_32.lib")

namespace {
bool g_hop_up = false;

void RegisterPrivacyHopChannel(flutter::FlutterEngine* engine) {
  auto channel = std::make_shared<flutter::MethodChannel<flutter::EncodableValue>>(
      engine->messenger(), "shear/privacy_hop",
      &flutter::StandardMethodCodec::GetInstance());
  channel->SetMethodCallHandler(
      [channel](const flutter::MethodCall<flutter::EncodableValue>& call,
                std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
                    result) {
        flutter::EncodableMap off_map(
            {{flutter::EncodableValue("ok"), flutter::EncodableValue(true)},
             {flutter::EncodableValue("connected"), flutter::EncodableValue(false)},
             {flutter::EncodableValue("message"),
              flutter::EncodableValue("Disconnected")}});
        if (call.method_name() == "connect") {
          WSADATA wsa;
          if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
            result->Error("hop", "WinSock init failed");
            return;
          }
          SOCKET s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
          if (s == INVALID_SOCKET) {
            WSACleanup();
            result->Error("hop", "UDP socket failed");
            return;
          }
          sockaddr_in addr{};
          addr.sin_family = AF_INET;
          addr.sin_port = htons(44044);
          inet_pton(AF_INET, "77.42.91.84", &addr.sin_addr);
          // Residual RPT2 HELLO is the Android VpnService / WinTUN dataplane.
          // Desktop attach: UDP 44044 must be reachable on the dedicated hop VPS.
          const char magic[] = "RPT2";
          sendto(s, magic, 4, 0, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
          DWORD timeout = 2000;
          setsockopt(s, SOL_SOCKET, SO_RCVTIMEO,
                     reinterpret_cast<const char*>(&timeout), sizeof(timeout));
          char buf[64];
          sockaddr_in from{};
          int fromlen = sizeof(from);
          int n = recvfrom(s, buf, sizeof(buf), 0,
                           reinterpret_cast<sockaddr*>(&from), &fromlen);
          closesocket(s);
          WSACleanup();
          // UDP reachability is not a residual session. Do not mark hop up
          // without WinTUN + authorized HELLO (Android VpnService path).
          g_hop_up = false;
          flutter::EncodableMap fail_map(
              {{flutter::EncodableValue("ok"), flutter::EncodableValue(false)},
               {flutter::EncodableValue("connected"), flutter::EncodableValue(false)},
               {flutter::EncodableValue("fullTunnelActive"),
                flutter::EncodableValue(false)},
               {flutter::EncodableValue("message"),
                flutter::EncodableValue(
                    n > 0
                        ? "SHEAR-HOP / EU is reachable on UDP 44044. Windows "
                          "WinTUN residual HELLO is not in this cut — use "
                          "Privacy hop on Android, or a local Shear node."
                        : "No residual HELLO reply from SHEAR-HOP / EU. Use "
                          "Privacy hop on Android, or a local Shear node.")}});
          result->Success(flutter::EncodableValue(fail_map));
          return;
        }
        if (call.method_name() == "disconnect") {
          g_hop_up = false;
          result->Success(flutter::EncodableValue(off_map));
          return;
        }
        if (call.method_name() == "status") {
          flutter::EncodableMap st(
              {{flutter::EncodableValue("ok"), flutter::EncodableValue(g_hop_up)},
               {flutter::EncodableValue("connected"),
                flutter::EncodableValue(g_hop_up)},
               {flutter::EncodableValue("fullTunnelActive"),
                flutter::EncodableValue(g_hop_up)},
               {flutter::EncodableValue("message"),
                flutter::EncodableValue(g_hop_up ? "SHEAR-HOP / EU up"
                                                : "Hop off")}});
          result->Success(flutter::EncodableValue(st));
          return;
        }
        result->NotImplemented();
      });
}
}  // namespace

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}

FlutterWindow::~FlutterWindow() {}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  // The size here must match the window dimensions to avoid unnecessary surface
  // creation / destruction in the startup path.
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  // Ensure that basic setup of the controller was successful.
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  RegisterPrivacyHopChannel(flutter_controller_->engine());
  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
}

void FlutterWindow::OnDestroy() {
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }

  Win32Window::OnDestroy();
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  // Give Flutter, including plugins, an opportunity to handle window messages.
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
