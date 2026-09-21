package com.shear.shear_wallet

import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Outer QUIC-mimic layer — mirrors `node/obfuscation.py`.
 *
 * Product residual UDP is not bare RPT2 alone; wrap outbound / unwrap inbound.
 */
object RptObfuscation {
    const val OBFS_VERSION: Int = 0x52505431 // 'RPT1'
    private val RPT_MAGIC: ByteArray = byteArrayOf(0x52, 0x50, 0x54, 0x32) // RPT2
    // Same public product key material as Python _PRODUCT_OBFS_KEY
    private val PRODUCT_OBFS_KEY: ByteArray =
        ("RPT-OBFS-LAYER-v1\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000").toByteArray(Charsets.US_ASCII) +
            byteArrayOf(
                0x9a.toByte(), 0x3c, 0x7e, 0x11, 0xd4.toByte(), 0x55, 0x88.toByte(), 0x02,
            )

    /**
     * Runtime outer wrap flag — default **OFF** (lean residual) until Settings
     * enables outer obfuscation (parity with desktop/Apple privacy scale).
     */
    @Volatile
    var productObfsEnabled: Boolean = false

    private val rnd = SecureRandom()

    fun looksLikeBareRpt(data: ByteArray): Boolean =
        data.size >= 5 && data[0] == 0x52.toByte() && data[1] == 0x50.toByte() &&
            data[2] == 0x54.toByte() && data[3] == 0x32.toByte()

    fun looksLikeObfs(data: ByteArray): Boolean {
        if (data.size < 1 + 4 + 1 + 8 + 1 + 2 + 12) return false
        if ((data[0].toInt() and 0xC0) != 0xC0) return false
        val ver = ByteBuffer.wrap(data, 1, 4).int
        return ver == OBFS_VERSION
    }

    private fun streamMask(nonce: ByteArray, length: Int): ByteArray {
        val out = ByteArray(length)
        var filled = 0
        var counter = 0
        val md = MessageDigest.getInstance("SHA-256")
        while (filled < length) {
            md.reset()
            md.update(PRODUCT_OBFS_KEY)
            md.update(nonce)
            md.update(ByteBuffer.allocate(4).putInt(counter).array())
            val h = md.digest()
            val n = minOf(h.size, length - filled)
            System.arraycopy(h, 0, out, filled, n)
            filled += n
            counter++
        }
        return out
    }

    private fun xor(data: ByteArray, mask: ByteArray): ByteArray {
        require(mask.size >= data.size)
        return ByteArray(data.size) { i -> (data[i].toInt() xor mask[i].toInt()).toByte() }
    }

    fun wrapFrame(inner: ByteArray): ByteArray {
        require(inner.isNotEmpty()) { "empty inner frame" }
        val flags = (0xC0 or (rnd.nextInt(16))).toByte()
        val dcid = ByteArray(8).also { rnd.nextBytes(it) }
        val nonce = ByteArray(12).also { rnd.nextBytes(it) }
        val mask = streamMask(nonce, inner.size)
        val body = xor(inner, mask)
        require(body.size <= 0xFFFF) { "inner frame too large" }
        val bb = ByteBuffer.allocate(1 + 4 + 1 + 8 + 1 + 2 + 12 + body.size)
        bb.put(flags)
        bb.putInt(OBFS_VERSION)
        bb.put(8.toByte()) // dcid_len
        bb.put(dcid)
        bb.put(0.toByte()) // scid_len
        bb.putShort(body.size.toShort())
        bb.put(nonce)
        bb.put(body)
        return bb.array()
    }

    fun unwrapFrame(outer: ByteArray, allowBare: Boolean = true): ByteArray {
        if (allowBare && looksLikeBareRpt(outer)) return outer
        require(looksLikeObfs(outer)) { "not an RPT obfuscated frame" }
        var o = 0
        o += 1 // flags
        o += 4 // version
        val dcidLen = outer[o].toInt() and 0xff
        o += 1
        require(dcidLen == 8) { "unexpected dcid_len" }
        o += dcidLen
        val scidLen = outer[o].toInt() and 0xff
        o += 1
        o += scidLen
        require(o + 2 + 12 <= outer.size) { "truncated outer" }
        val plen = ((outer[o].toInt() and 0xff) shl 8) or (outer[o + 1].toInt() and 0xff)
        o += 2
        val nonce = outer.copyOfRange(o, o + 12)
        o += 12
        require(o + plen <= outer.size) { "truncated body" }
        val body = outer.copyOfRange(o, o + plen)
        val mask = streamMask(nonce, plen)
        return xor(body, mask)
    }

    fun applyPrivacyScale(outerObfuscation: Boolean) {
        productObfsEnabled = outerObfuscation
    }

    fun maybeWrap(inner: ByteArray, enabled: Boolean = productObfsEnabled): ByteArray =
        if (enabled) wrapFrame(inner) else inner

    fun maybeUnwrap(outer: ByteArray, enabled: Boolean = productObfsEnabled): ByteArray =
        unwrapFrame(outer, allowBare = true)
}
