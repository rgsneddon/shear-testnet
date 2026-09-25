package com.shear.shear_wallet

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.system.OsConstants
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/** Thin residual hop (RPT2) pinned to SHEAR-HOP / EU. Connect / Disconnect / status only. */
class PrivacyHopVpnService : VpnService() {
    private var tun: ParcelFileDescriptor? = null
    private val running = AtomicBoolean(false)
    private var worker: Thread? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CONNECT -> {
                val host = intent.getStringExtra(EXTRA_HOST) ?: HOP_HOST
                val port = intent.getIntExtra(EXTRA_PORT, HOP_PORT)
                val timeoutMs = intent.getIntExtra(EXTRA_TIMEOUT_MS, HOP_HANDSHAKE_TIMEOUT_MS)
                val attempts = intent.getIntExtra(EXTRA_ATTEMPTS, HOP_HANDSHAKE_ATTEMPTS)
                try {
                    startForeground(NOTIFICATION_ID, buildNotification(connecting = true))
                } catch (e: Exception) {
                    lastError = "Foreground service failed: ${e.message}"
                    isSessionActive = false
                    stopSelf()
                    return START_NOT_STICKY
                }
                startTunnel(host, port, timeoutMs, attempts)
                return START_STICKY
            }
            ACTION_DISCONNECT -> {
                stopTunnel()
                return START_NOT_STICKY
            }
            else -> {
                if (isSessionActive && running.get()) return START_STICKY
                stopTunnel()
                return START_NOT_STICKY
            }
        }
    }

    private fun loadSecrets(): Pair<ByteArray, ByteArray>? {
        val dir = File(filesDir, "secrets")
        dir.mkdirs()
        val privF = File(dir, "client_ed25519.priv")
        val pubF = File(dir, "node_elgamal.pub")
        try {
            assets.open("secrets/node_elgamal.pub").use { inp ->
                val bytes = inp.readBytes()
                if (bytes.size < 32) return null
                pubF.writeBytes(bytes)
            }
        } catch (_: Exception) {
            if (!pubF.isFile || pubF.length() < 32L) return null
        }
        if (!privF.isFile || privF.length() != 32L) {
            val seed = ByteArray(32)
            java.security.SecureRandom().nextBytes(seed)
            org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters(seed, 0)
            privF.writeBytes(seed)
        }
        val priv = privF.readBytes()
        val pub = pubF.readBytes()
        if (priv.size != 32 || pub.size < 32) return null
        return priv to pub
    }

    private fun startTunnel(host: String, port: Int, timeoutMs: Int, attempts: Int) {
        if (!running.compareAndSet(false, true)) return
        connecting = true
        lastError = null
        val secrets = loadSecrets()
        if (secrets == null) {
            running.set(false)
            connecting = false
            lastError = "Missing hop node public key"
            isSessionActive = false
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        val (clientPriv, nodePub) = secrets
        worker = thread(name = "shear-hop-dataplane", isDaemon = true) {
            val sock = DatagramSocket()
            try {
                protect(sock)
                RptTrafficShape.applyPrivacyScale(false)
                RptObfuscation.applyPrivacyScale(false)
                val engine = RptClientEngine(clientPriv, nodePub)
                val session = engine.handshake(sock, host, port, timeoutMs = timeoutMs, attempts = attempts)
                val builder = Builder()
                    .setSession("Shear Privacy hop")
                    .setMtu(1280)
                    .addAddress(session.vpnIp, 32)
                    .addDnsServer("10.88.0.1")
                    .addRoute("0.0.0.0", 0)
                try {
                    builder.allowFamily(OsConstants.AF_INET)
                } catch (_: Exception) {
                }
                try {
                    builder.addDisallowedApplication(packageName)
                } catch (_: Exception) {
                }
                val pfd = builder.establish()
                if (pfd == null) {
                    lastError = "VPN permission blocked TUN"
                    connecting = false
                    running.set(false)
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                    return@thread
                }
                tun = pfd
                val endpoint = InetSocketAddress(host, port)
                val dataSock = DatagramSocket()
                if (!protect(dataSock)) {
                    lastError = "Could not protect UDP to hop"
                    pfd.close()
                    running.set(false)
                    connecting = false
                    stopSelf()
                    return@thread
                }
                dataSock.connect(endpoint)
                try {
                    sock.close()
                } catch (_: Exception) {
                }
                isSessionActive = true
                connecting = false
                activeVpnIp = session.vpnIp
                lastError = null
                startForeground(NOTIFICATION_ID, buildNotification(connecting = false))

                val pfdIn = ParcelFileDescriptor.dup(pfd.fileDescriptor)
                val pfdOut = ParcelFileDescriptor.dup(pfd.fileDescriptor)
                val inTun = FileInputStream(pfdIn.fileDescriptor)
                val outTun = FileOutputStream(pfdOut.fileDescriptor)
                dataSock.soTimeout = 200
                val up = thread(name = "shear-hop-up", isDaemon = true) {
                    val buf = ByteArray(32767)
                    while (running.get()) {
                        try {
                            val n = inTun.read(buf)
                            if (n > 0) {
                                val wire = engine.sealAndWrapPacket(buf.copyOf(n))
                                dataSock.send(DatagramPacket(wire, wire.size))
                            } else if (n < 0) break
                        } catch (_: Exception) {
                            if (!running.get()) break
                        }
                    }
                }
                val down = thread(name = "shear-hop-down", isDaemon = true) {
                    val buf = ByteArray(65535)
                    while (running.get()) {
                        try {
                            val pkt = DatagramPacket(buf, buf.size)
                            dataSock.receive(pkt)
                            val plain = engine.unwrapAndOpen(buf.copyOf(pkt.length))
                            if (plain != null && plain.isNotEmpty()) {
                                outTun.write(plain)
                                outTun.flush()
                            }
                        } catch (_: Exception) {
                            if (!running.get()) break
                        }
                    }
                }
                val ka = thread(name = "shear-hop-ka", isDaemon = true) {
                    while (running.get()) {
                        try {
                            Thread.sleep(25_000)
                            if (!running.get()) break
                            val wire = engine.sealAndWrapKeepalive()
                            dataSock.send(DatagramPacket(wire, wire.size))
                        } catch (_: Exception) {
                            if (!running.get()) break
                        }
                    }
                }
                up.join()
                down.join(2_000)
                ka.join(500)
                try { inTun.close() } catch (_: Exception) {}
                try { outTun.close() } catch (_: Exception) {}
                try { pfdIn.close() } catch (_: Exception) {}
                try { pfdOut.close() } catch (_: Exception) {}
                try { dataSock.close() } catch (_: Exception) {}
            } catch (e: Exception) {
                lastError = e.message ?: e.javaClass.simpleName
                connecting = false
                isSessionActive = false
            } finally {
                running.set(false)
                isSessionActive = false
                activeVpnIp = ""
                try { sock.close() } catch (_: Exception) {}
                try { tun?.close() } catch (_: Exception) {}
                tun = null
            }
        }
    }

    private fun stopTunnel() {
        running.set(false)
        isSessionActive = false
        connecting = false
        activeVpnIp = ""
        try { tun?.close() } catch (_: Exception) {}
        tun = null
        try { worker?.join(2000) } catch (_: Exception) {}
        worker = null
        try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Exception) {}
        try { stopSelf() } catch (_: Exception) {}
    }

    override fun onDestroy() {
        stopTunnel()
        super.onDestroy()
    }

    override fun onRevoke() {
        stopTunnel()
        super.onRevoke()
    }

    private fun buildNotification(connecting: Boolean): Notification {
        val channelId = "shear_privacy_hop"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(channelId, "Shear Privacy hop", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val text = if (connecting) "Connecting Privacy hop…" else "Privacy hop up · SHEAR-HOP / EU"
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, channelId)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return b.setContentTitle("Shear Privacy hop")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setOngoing(true)
            .build()
    }

    companion object {
        const val HOP_HOST = "77.42.91.84"
        const val HOP_PORT = 44044
        const val HOP_HANDSHAKE_TIMEOUT_MS = 15_000
        const val HOP_HANDSHAKE_ATTEMPTS = 3
        const val HOP_SESSION_WAIT_MS = 20_000
        const val ACTION_CONNECT = "com.shear.shear_wallet.HOP_CONNECT"
        const val ACTION_DISCONNECT = "com.shear.shear_wallet.HOP_DISCONNECT"
        const val EXTRA_HOST = "host"
        const val EXTRA_PORT = "port"
        const val EXTRA_TIMEOUT_MS = "timeoutMs"
        const val EXTRA_ATTEMPTS = "attempts"
        private const val NOTIFICATION_ID = 0x5348

        @Volatile var isSessionActive: Boolean = false
        @Volatile var connecting: Boolean = false
        @Volatile var activeVpnIp: String = ""
        @Volatile var lastError: String? = null
    }
}
