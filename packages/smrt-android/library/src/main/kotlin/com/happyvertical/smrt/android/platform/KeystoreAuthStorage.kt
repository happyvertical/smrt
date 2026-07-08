package com.happyvertical.smrt.android.platform

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.happyvertical.smrt.mobile.auth.AuthStorage
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Keystore-backed [AuthStorage] — the upgrade smrt-mobile's auth module
 * names explicitly (the reporter seed persisted the session in plain
 * SharedPreferences). Values are AES/GCM-encrypted with a non-exportable
 * Android Keystore key; only ciphertext (IV-prefixed, Base64) touches
 * SharedPreferences. The pending-auth slot survives process death, which
 * the PKCE browser hand-off requires.
 *
 * If a stored value no longer decrypts (Keystore key lost — e.g. a device
 * restore), it is treated as absent and cleared: the session path degrades
 * to re-auth instead of crashing.
 */
class KeystoreAuthStorage(
    context: Context,
    private val keyAlias: String = DEFAULT_KEY_ALIAS,
    preferencesName: String = DEFAULT_PREFERENCES_NAME,
) : AuthStorage {
    private val preferences: SharedPreferences =
        context.applicationContext.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)

    override suspend fun readSession(): String? = read(KEY_SESSION)

    override suspend fun writeSession(value: String) = write(KEY_SESSION, value)

    override suspend fun clearSession() = clear(KEY_SESSION)

    override suspend fun readPendingAuth(): String? = read(KEY_PENDING_AUTH)

    override suspend fun writePendingAuth(value: String) = write(KEY_PENDING_AUTH, value)

    override suspend fun clearPendingAuth() = clear(KEY_PENDING_AUTH)

    private suspend fun read(key: String): String? = withContext(Dispatchers.IO) {
        val stored = preferences.getString(key, null) ?: return@withContext null
        runCatching { decrypt(stored) }.getOrElse {
            preferences.edit().remove(key).apply()
            null
        }
    }

    private suspend fun write(key: String, value: String) = withContext(Dispatchers.IO) {
        preferences.edit().putString(key, encrypt(value)).apply()
    }

    private suspend fun clear(key: String) = withContext(Dispatchers.IO) {
        preferences.edit().remove(key).apply()
    }

    private fun encrypt(plaintext: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val ciphertext = cipher.doFinal(plaintext.encodeToByteArray())
        return Base64.encodeToString(cipher.iv + ciphertext, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String {
        val bytes = Base64.decode(stored, Base64.NO_WRAP)
        require(bytes.size > GCM_IV_LENGTH_BYTES) { "stored value too short" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            secretKey(),
            GCMParameterSpec(GCM_TAG_LENGTH_BITS, bytes, 0, GCM_IV_LENGTH_BYTES),
        )
        val plaintext = cipher.doFinal(bytes, GCM_IV_LENGTH_BYTES, bytes.size - GCM_IV_LENGTH_BYTES)
        return plaintext.decodeToString()
    }

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        const val DEFAULT_KEY_ALIAS = "smrt_mobile_auth"
        const val DEFAULT_PREFERENCES_NAME = "smrt_auth_storage"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_IV_LENGTH_BYTES = 12
        private const val GCM_TAG_LENGTH_BITS = 128
        private const val KEY_SESSION = "session"
        private const val KEY_PENDING_AUTH = "pending_auth"
    }
}
