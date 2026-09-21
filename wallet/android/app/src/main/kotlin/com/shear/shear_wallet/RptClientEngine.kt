package com.shear.shear_wallet

import org.bouncycastle.crypto.engines.ChaCha7539Engine
import org.bouncycastle.crypto.modes.ChaCha20Poly1305
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.digests.SHA256Digest
import java.math.BigInteger
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Authorized RPT2 client engine — ElGamal hybrid + Pedersen + Ed25519 + ChaCha20-Poly1305.
 * Mirrors Python `client.connect` / `node.handshake` (not WireGuard/OpenVPN).
 *
 * Product residual parity with Python path:
 * - **PFS**: ephemeral X25519 in HELLO (`|pfs-x25519|`)
 * - **Traffic shape**: RPTP pad + RPTC cover on DATA AEAD plaintext
 * - **Outer obfs**: QUIC-mimic wrap/unwrap on UDP (not bare RPT2 alone)
 */
class RptClientEngine(
    private val clientPrivRaw: ByteArray,
    private val nodeElgamalPubRaw: ByteArray,
) {
    private val rnd = SecureRandom()
    private var sessionId: ByteArray? = null
    private var sessionKey: ByteArray? = null
    private var counterOut: Long = 0

    data class Session(
        val sessionId: ByteArray,
        val sessionKey: ByteArray,
        val vpnIp: String,
        val pfs: Boolean = true,
    )

    /**
     * Product HELLO: ElGamal hybrid + Pedersen + Ed25519 + X25519 PFS, outer-obfs wrap.
     * Retries on poll timeout (mobile UDP drop / NAT) without changing crypto.
     */
    fun handshake(
        socket: DatagramSocket,
        host: String,
        port: Int,
        timeoutMs: Int = 60000,
        attempts: Int = 5,
    ): Session {
        // Force IPv4 literal resolution (product node is IPv4-only)
        val endpoint = InetSocketAddress(host, port)
        // At least 8s per try on mobile (NAT/UDP loss); total budget is timeoutMs
        val perAttempt = (timeoutMs / attempts.coerceAtLeast(1)).coerceAtLeast(8000)
        var last: Exception? = null
        repeat(attempts.coerceAtLeast(1)) { attempt ->
            try {
                socket.soTimeout = perAttempt
                val clientPub = ed25519PublicFromPrivate(clientPrivRaw)
                val clientNonce = ByteArray(32).also { rnd.nextBytes(it) }
                val (commit, opening) = pedersenCommitBytes(clientNonce)
                // PFS: ephemeral X25519 public key appended to hybrid plaintext
                // (must match Python build_client_hello — node requires PFS)
                val eph = generateX25519()
                val payload = clientNonce + opening + eph.publicKey
                val hybrid = packHybrid(nodeElgamalPubRaw, payload)
                val transcript = byteArrayOf() +
                    "RPT2-CLIENT-HELLO|".toByteArray(Charsets.US_ASCII) +
                    clientPub + commit + hybrid
                val sig = ed25519Sign(clientPrivRaw, transcript)
                val hello = packClientHello(clientPub, commit, hybrid, sig)
                // Outer wrap HELLO (Python maybe_wrap) — product residual wire
                val wireHello = RptObfuscation.maybeWrap(hello)
                socket.send(DatagramPacket(wireHello, wireHello.size, endpoint))

                val buf = ByteArray(65535)
                val pkt = DatagramPacket(buf, buf.size)
                socket.receive(pkt)
                val reply = RptObfuscation.maybeUnwrap(buf.copyOf(pkt.length))
                val session = completeServerHello(reply, clientNonce, clientPub, eph)
                this.sessionId = session.sessionId
                this.sessionKey = session.sessionKey
                this.counterOut = 0
                return session
            } catch (e: java.net.SocketTimeoutException) {
                last = e
                // retry with fresh HELLO (new nonce/eph) on next loop
            } catch (e: Exception) {
                // Non-timeout parse/crypto errors: do not burn retries uselessly
                if (e is java.net.SocketTimeoutException) {
                    last = e
                } else if (
                    e.message?.contains("timed out", ignoreCase = true) == true ||
                    e.message?.contains("timeout", ignoreCase = true) == true
                ) {
                    last = e
                } else {
                    throw e
                }
            }
        }
        throw last ?: java.net.SocketTimeoutException(
            "Poll timed out after $attempts HELLO attempt(s) to $host:$port"
        )
    }

    /** Seal IP packet with product pad (RPTP) then pack DATA; caller should outer-wrap for UDP. */
    fun sealPacket(ipPacket: ByteArray): ByteArray {
        val sid = sessionId ?: error("no session")
        val key = sessionKey ?: error("no session")
        counterOut += 1
        val aad = sid + longToBytes(counterOut)
        val body = RptTrafficShape.prepareOutbound(ipPacket)
        val (nonce, sealed) = aeadSeal(key, body, aad)
        return packData(sid, counterOut, nonce, sealed)
    }

    /**
     * Open a DATA frame (inner RPT2, after outer unwrap). Returns null if cover (RPTC).
     * Throws if frame is not DATA or AEAD fails.
     */
    fun openPacketAllowCover(frame: ByteArray): ByteArray? {
        val key = sessionKey ?: error("no session")
        val (sid, counter, nonce, sealed) = parseData(frame)
        val aad = sid + longToBytes(counter)
        val raw = aeadOpen(key, nonce, sealed, aad)
        val (plain, isCover) = RptTrafficShape.interpretInbound(raw)
        if (isCover) return null
        return plain
    }

    fun openPacket(frame: ByteArray): ByteArray {
        return openPacketAllowCover(frame)
            ?: throw IllegalArgumentException("cover traffic frame")
    }

    /** Seal a cover (RPTC) DATA frame for traffic shaping. */
    fun sealCoverFrame(size: Int = RptTrafficShape.PRODUCT_COVER_SIZE): ByteArray {
        val sid = sessionId ?: error("no session")
        val key = sessionKey ?: error("no session")
        counterOut += 1
        val aad = sid + longToBytes(counterOut)
        val body = RptTrafficShape.makeCoverPayload(size)
        val (nonce, sealed) = aeadSeal(key, body, aad)
        return packData(sid, counterOut, nonce, sealed)
    }

    /** Product residual UDP send: pad + outer-wrap (+ bounded send jitter). */
    fun sealAndWrapPacket(ipPacket: ByteArray): ByteArray {
        RptTrafficShape.applySendJitter()
        return RptObfuscation.maybeWrap(sealPacket(ipPacket))
    }

    fun sealAndWrapCover(): ByteArray =
        RptObfuscation.maybeWrap(sealCoverFrame())

    /**
     * RPT2 KEEPALIVE (type 0x04) — small session-touch frame for node idle prune.
     * Independent of TUN data and traffic-shape cover. Python: pack_keepalive.
     */
    fun packKeepalive(): ByteArray {
        val sid = sessionId ?: error("no session")
        require(sid.size == 8) { "session_id must be 8 bytes" }
        return byteArrayOf(0x52, 0x50, 0x54, 0x32, 0x04) + sid
    }

    /** Outer-wrap KEEPALIVE when product outer obfs is ON (same path as DATA). */
    fun sealAndWrapKeepalive(): ByteArray =
        RptObfuscation.maybeWrap(packKeepalive())

    /** Product residual UDP recv: outer-unwrap then open DATA (null = cover). */
    fun unwrapAndOpen(udpPayload: ByteArray): ByteArray? {
        val inner = RptObfuscation.maybeUnwrap(udpPayload)
        if (inner.size < 5 || inner[4] != 0x03.toByte()) return null
        return openPacketAllowCover(inner)
    }

    // --- protocol ---

    private fun packClientHello(pub: ByteArray, commit: ByteArray, hybrid: ByteArray, sig: ByteArray): ByteArray {
        val bb = ByteBuffer.allocate(5 + 32 + 256 + 4 + hybrid.size + 64)
        bb.put(byteArrayOf(0x52, 0x50, 0x54, 0x32, 0x01)) // RPT2 CLIENT_HELLO
        bb.put(pub)
        bb.put(commit)
        bb.putInt(hybrid.size)
        bb.put(hybrid)
        bb.put(sig)
        return bb.array()
    }

    private fun completeServerHello(
        reply: ByteArray,
        clientNonce: ByteArray,
        clientPub: ByteArray,
        clientEph: X25519KeyPair,
    ): Session {
        require(reply.size >= 5 + 256 + 8 + 12 + 16) { "short SERVER_HELLO" }
        require(reply[0] == 0x52.toByte() && reply[4] == 0x02.toByte()) { "not SERVER_HELLO" }
        val body = reply.copyOfRange(5, reply.size)
        val sCommit = body.copyOfRange(0, 256)
        val sid = body.copyOfRange(256, 264)
        val nonce = body.copyOfRange(264, 276)
        val sealed = body.copyOfRange(276, body.size)
        val helloShared = sha256(clientNonce + clientPub + "|hello".toByteArray(Charsets.US_ASCII))
        val helloKey = hkdf(helloShared, clientNonce.copyOfRange(0, 16), "rpt-v2-hello".toByteArray())
        val aad = "RPT2-SERVER-HELLO".toByteArray(Charsets.US_ASCII) + sid
        val plain = aeadOpen(helloKey, nonce, sealed, aad)
        // Product PFS: server_nonce + pedersen opening + vpn_ip + server X25519 pub (32)
        val serverEphOff = 32 + 288 + 4
        require(plain.size >= serverEphOff + 32) {
            "SERVER_HELLO missing server X25519 pub (product requires PFS)"
        }
        val serverNonce = plain.copyOfRange(0, 32)
        val opening = plain.copyOfRange(32, 32 + 288)
        require(pedersenVerify(sCommit, opening)) { "pedersen open failed" }
        val ipBytes = plain.copyOfRange(32 + 288, 32 + 288 + 4)
        val vpnIp = ipBytes.joinToString(".") { (it.toInt() and 0xff).toString() }
        val serverEphPub = plain.copyOfRange(serverEphOff, serverEphOff + 32)
        val ephShared = x25519Shared(clientEph.privateKey, serverEphPub)
        // Python derive_pfs_session_shared
        val sessionShared = sha256(
            clientNonce + serverNonce + sid + clientPub +
                "|pfs-x25519|".toByteArray(Charsets.US_ASCII) + ephShared
        )
        val sessionKey = hkdf(sessionShared, clientNonce.copyOfRange(0, 16), "rpt-v2-session".toByteArray())
        return Session(sid, sessionKey, vpnIp, pfs = true)
    }

    private data class X25519KeyPair(val privateKey: ByteArray, val publicKey: ByteArray)

    private fun generateX25519(): X25519KeyPair {
        val priv = ByteArray(32).also { rnd.nextBytes(it) }
        // Clamp per RFC 7748
        priv[0] = (priv[0].toInt() and 248).toByte()
        priv[31] = (priv[31].toInt() and 127).toByte()
        priv[31] = (priv[31].toInt() or 64).toByte()
        val pub = ByteArray(32)
        org.bouncycastle.math.ec.rfc7748.X25519.scalarMultBase(priv, 0, pub, 0)
        return X25519KeyPair(priv, pub)
    }

    private fun x25519Shared(privateKey: ByteArray, peerPublic: ByteArray): ByteArray {
        require(peerPublic.size == 32) { "X25519 public key must be 32 bytes" }
        val out = ByteArray(32)
        org.bouncycastle.math.ec.rfc7748.X25519.scalarMult(privateKey, 0, peerPublic, 0, out, 0)
        return out
    }

    private fun packData(sid: ByteArray, counter: Long, nonce: ByteArray, sealed: ByteArray): ByteArray {
        val bb = ByteBuffer.allocate(5 + 8 + 8 + 12 + sealed.size)
        bb.put(byteArrayOf(0x52, 0x50, 0x54, 0x32, 0x03))
        bb.put(sid)
        bb.putLong(counter)
        bb.put(nonce)
        bb.put(sealed)
        return bb.array()
    }

    private fun parseData(frame: ByteArray): Quad {
        require(frame.size >= 5 + 8 + 8 + 12 + 16 && frame[4] == 0x03.toByte())
        val body = frame.copyOfRange(5, frame.size)
        val sid = body.copyOfRange(0, 8)
        val counter = ByteBuffer.wrap(body, 8, 8).long
        val nonce = body.copyOfRange(16, 28)
        val sealed = body.copyOfRange(28, body.size)
        return Quad(sid, counter, nonce, sealed)
    }

    private data class Quad(val a: ByteArray, val b: Long, val c: ByteArray, val d: ByteArray)

    // --- crypto primitives ---

    private fun ed25519PublicFromPrivate(priv: ByteArray): ByteArray {
        val params = Ed25519PrivateKeyParameters(priv, 0)
        return params.generatePublicKey().encoded
    }

    private fun ed25519Sign(priv: ByteArray, msg: ByteArray): ByteArray {
        val signer = Ed25519Signer()
        signer.init(true, Ed25519PrivateKeyParameters(priv, 0))
        signer.update(msg, 0, msg.size)
        return signer.generateSignature()
    }

    private fun aeadSeal(key: ByteArray, plain: ByteArray, aad: ByteArray): Pair<ByteArray, ByteArray> {
        val nonce = ByteArray(12).also { rnd.nextBytes(it) }
        val cipher = ChaCha20Poly1305()
        cipher.init(true, AEADParameters(KeyParameter(key), 128, nonce, aad))
        val out = ByteArray(cipher.getOutputSize(plain.size))
        val n = cipher.processBytes(plain, 0, plain.size, out, 0)
        cipher.doFinal(out, n)
        return nonce to out
    }

    private fun aeadOpen(key: ByteArray, nonce: ByteArray, sealed: ByteArray, aad: ByteArray): ByteArray {
        val cipher = ChaCha20Poly1305()
        cipher.init(false, AEADParameters(KeyParameter(key), 128, nonce, aad))
        val out = ByteArray(cipher.getOutputSize(sealed.size))
        val n = cipher.processBytes(sealed, 0, sealed.size, out, 0)
        val m = cipher.doFinal(out, n)
        return out.copyOf(n + m)
    }

    private fun packHybrid(nodePubRaw: ByteArray, plaintext: ByteArray): ByteArray {
        val key = ByteArray(32).also { rnd.nextBytes(it) }
        val ct = elgamalEncrypt(nodePubRaw, key)
        val nonce = ByteArray(12).also { rnd.nextBytes(it) }
        val sealed = aeadSealWithKey(key, plaintext, "RPT2-HYBRID".toByteArray(Charsets.US_ASCII), nonce)
        return ct + nonce + sealed
    }

    private fun aeadSealWithKey(key: ByteArray, plain: ByteArray, aad: ByteArray, nonce: ByteArray): ByteArray {
        val cipher = ChaCha20Poly1305()
        cipher.init(true, AEADParameters(KeyParameter(key), 128, nonce, aad))
        val out = ByteArray(cipher.getOutputSize(plain.size))
        val n = cipher.processBytes(plain, 0, plain.size, out, 0)
        cipher.doFinal(out, n)
        return out
    }

    // RFC 3526 Group 14
    private val P: BigInteger = BigInteger(
        "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1" +
            "29024E088A67CC74020BBEA63B139B22514A08798E3404DD" +
            "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245" +
            "E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
            "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D" +
            "C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F" +
            "83655D23DCA3AD961C62F356208552BB9ED529077096966D" +
            "670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
            "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9" +
            "DE2BCBF6955817183995497CEA956AE515D2261898FA0510" +
            "15728E5A8AACAA68FFFFFFFFFFFFFFFF",
        16,
    )
    private val G: BigInteger = BigInteger.valueOf(2)
    private val Q: BigInteger = P.subtract(BigInteger.ONE).shiftRight(1)

    private fun elgamalEncrypt(pubRaw: ByteArray, plaintext: ByteArray): ByteArray {
        require(pubRaw.size == 256)
        val y = BigInteger(1, pubRaw)
        val m = encodeMessage(plaintext)
        val k = randomExponent()
        val c1 = G.modPow(k, P)
        val c2 = m.multiply(y.modPow(k, P)).mod(P)
        return bigIntTo256(c1) + bigIntTo256(c2)
    }

    private fun encodeMessage(plaintext: ByteArray): BigInteger {
        require(plaintext.size <= 240)
        val pad = ByteArray(16).also { rnd.nextBytes(it) }
        val blob = byteArrayOf(plaintext.size.toByte()) + plaintext + pad
        return BigInteger(1, blob)
    }

    private fun randomExponent(): BigInteger {
        while (true) {
            val buf = ByteArray(256).also { rnd.nextBytes(it) }
            val x = BigInteger(1, buf).mod(Q)
            if (x >= BigInteger.ONE && x < Q) return x
        }
    }

    private fun bigIntTo256(v: BigInteger): ByteArray {
        val raw = v.toByteArray()
        val out = ByteArray(256)
        if (raw.size >= 256) {
            System.arraycopy(raw, raw.size - 256, out, 0, 256)
        } else {
            System.arraycopy(raw, 0, out, 256 - raw.size, raw.size)
        }
        return out
    }

    private fun pedersenH(): BigInteger {
        val seed = "rpt-pedersen-h-v1".toByteArray() + bigIntTo256(G)
        var acc = sha256(seed)
        while (acc.size < 256) {
            acc += sha256(acc)
        }
        var x = BigInteger(1, acc.copyOf(256)).mod(P)
        if (x <= BigInteger.ONE) x = BigInteger.valueOf(3)
        var h = x.modPow(BigInteger.valueOf(2), P)
        if (h <= BigInteger.ONE) h = x.add(BigInteger.valueOf(2)).modPow(BigInteger.valueOf(2), P)
        return h
    }

    private fun pedersenCommitBytes(payload: ByteArray): Pair<ByteArray, ByteArray> {
        val m = BigInteger(1, sha256(payload)).mod(Q)
        val r = randomExponent()
        val c = G.modPow(m, P).multiply(pedersenH().modPow(r, P)).mod(P)
        val opening = bigIntToFixed(m, 32) + bigIntTo256(r)
        return bigIntTo256(c) to opening
    }

    private fun pedersenVerify(commit: ByteArray, opening: ByteArray): Boolean {
        if (opening.size != 288) return false
        val m = BigInteger(1, opening.copyOfRange(0, 32)).mod(Q)
        val r = BigInteger(1, opening.copyOfRange(32, 288)).mod(Q)
        val expected = G.modPow(m, P).multiply(pedersenH().modPow(r, P)).mod(P)
        return bigIntTo256(expected).contentEquals(commit)
    }

    private fun bigIntToFixed(v: BigInteger, len: Int): ByteArray {
        val raw = v.toByteArray()
        val out = ByteArray(len)
        if (raw.size >= len) System.arraycopy(raw, raw.size - len, out, 0, len)
        else System.arraycopy(raw, 0, out, len - raw.size, raw.size)
        return out
    }

    private fun sha256(data: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(data)

    private fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray): ByteArray {
        val h = HKDFBytesGenerator(SHA256Digest())
        h.init(HKDFParameters(ikm, salt, info))
        val out = ByteArray(32)
        h.generateBytes(out, 0, 32)
        return out
    }

    private fun longToBytes(v: Long): ByteArray =
        ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN).putLong(v).array()
}
