package com.shear.shear_wallet

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterFragmentActivity() {
    private val channelName = "shear/privacy_hop"
    private var pendingConnect: MethodChannel.Result? = null
    private var pendingHost = PrivacyHopVpnService.HOP_HOST
    private var pendingPort = PrivacyHopVpnService.HOP_PORT
    private var pendingTimeout = PrivacyHopVpnService.HOP_HANDSHAKE_TIMEOUT_MS
    private var pendingAttempts = PrivacyHopVpnService.HOP_HANDSHAKE_ATTEMPTS

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "connect" -> {
                        val host = call.argument<String>("host") ?: PrivacyHopVpnService.HOP_HOST
                        val port = call.argument<Int>("port") ?: PrivacyHopVpnService.HOP_PORT
                        val timeoutMs = call.argument<Int>("timeoutMs")
                            ?: PrivacyHopVpnService.HOP_HANDSHAKE_TIMEOUT_MS
                        val attempts = call.argument<Int>("attempts")
                            ?: PrivacyHopVpnService.HOP_HANDSHAKE_ATTEMPTS
                        startHop(host, port, timeoutMs, attempts, result)
                    }
                    "disconnect" -> {
                        val i = Intent(this, PrivacyHopVpnService::class.java)
                        i.action = PrivacyHopVpnService.ACTION_DISCONNECT
                        startService(i)
                        result.success(
                            mapOf(
                                "ok" to true,
                                "connected" to false,
                                "connecting" to false,
                                "message" to "Privacy hop off",
                            ),
                        )
                    }
                    "status" -> result.success(statusMap())
                    else -> result.notImplemented()
                }
            }
    }

    private fun startHop(
        host: String,
        port: Int,
        timeoutMs: Int,
        attempts: Int,
        result: MethodChannel.Result,
    ) {
        pendingHost = host
        pendingPort = port
        pendingTimeout = timeoutMs
        pendingAttempts = attempts
        val prep = VpnService.prepare(this)
        if (prep != null) {
            // System VPN permission dialog. Return without blocking; resume on grant.
            // The hop fee is already paid on the Dart side for this session.
            pendingConnect = result
            startActivityForResult(prep, REQ_VPN)
            return
        }
        launchService(host, port, timeoutMs, attempts)
        waitForSession(result)
    }

    private fun launchService(host: String, port: Int, timeoutMs: Int, attempts: Int) {
        val i = Intent(this, PrivacyHopVpnService::class.java)
        i.action = PrivacyHopVpnService.ACTION_CONNECT
        i.putExtra(PrivacyHopVpnService.EXTRA_HOST, host)
        i.putExtra(PrivacyHopVpnService.EXTRA_PORT, port)
        i.putExtra(PrivacyHopVpnService.EXTRA_TIMEOUT_MS, timeoutMs)
        i.putExtra(PrivacyHopVpnService.EXTRA_ATTEMPTS, attempts)
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            startForegroundService(i)
        } else {
            startService(i)
        }
    }

    private fun waitForSession(result: MethodChannel.Result) {
        // Poll on a background thread. Do not sleep on the main thread.
        Thread {
            val deadline = System.currentTimeMillis() + PrivacyHopVpnService.HOP_SESSION_WAIT_MS
            while (System.currentTimeMillis() < deadline) {
                if (PrivacyHopVpnService.isSessionActive) {
                    runOnUiThread { result.success(statusMap()) }
                    return@Thread
                }
                val err = PrivacyHopVpnService.lastError
                if (!PrivacyHopVpnService.connecting && err != null) {
                    runOnUiThread { result.success(statusMap()) }
                    return@Thread
                }
                try {
                    Thread.sleep(200)
                } catch (_: InterruptedException) {
                    break
                }
            }
            if (!PrivacyHopVpnService.isSessionActive && PrivacyHopVpnService.lastError == null) {
                PrivacyHopVpnService.connecting = false
                PrivacyHopVpnService.lastError = "Privacy hop unreachable"
            }
            runOnUiThread { result.success(statusMap()) }
        }.start()
    }

    private fun statusMap(): Map<String, Any?> {
        val up = PrivacyHopVpnService.isSessionActive
        val connecting = PrivacyHopVpnService.connecting
        val ip = PrivacyHopVpnService.activeVpnIp
        val err = PrivacyHopVpnService.lastError
        val msg = when {
            up -> "Privacy hop up · SHEAR-HOP / EU"
            connecting -> "Connecting Privacy hop…"
            err != null -> err
            else -> "Privacy hop off"
        }
        return mapOf(
            "ok" to up,
            "connected" to up,
            "fullTunnelActive" to up,
            "connecting" to connecting,
            "vpnIp" to ip,
            "message" to msg,
        )
    }

    @Deprecated("prepare VPN")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_VPN) return
        val pending = pendingConnect
        pendingConnect = null
        if (pending == null) return
        if (resultCode != Activity.RESULT_OK) {
            pending.success(
                mapOf(
                    "ok" to false,
                    "connected" to false,
                    "connecting" to false,
                    "message" to "VPN permission denied",
                ),
            )
            return
        }
        launchService(pendingHost, pendingPort, pendingTimeout, pendingAttempts)
        waitForSession(pending)
    }

    companion object {
        private const val REQ_VPN = 0x5348
    }
}
