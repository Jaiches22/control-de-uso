package es.jaimecalzada.controldeuso

import android.content.SharedPreferences
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class ApiException(message: String) : Exception(message)

/** Llamadas a Supabase (sesión y funciones RPC) con HttpURLConnection, sin librerías externas. */
class Api(private val prefs: SharedPreferences) {
    private val base = BuildConfig.SUPABASE_URL.trimEnd('/')
    private val key = BuildConfig.SUPABASE_ANON_KEY

    val loggedIn: Boolean get() = prefs.getString("refresh_token", null) != null
    val email: String? get() = prefs.getString("email", null)

    private fun request(path: String, body: String, bearer: String?): Pair<Int, String> {
        val conn = URL(base + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            conn.doOutput = true
            conn.setRequestProperty("apikey", key)
            conn.setRequestProperty("Content-Type", "application/json")
            if (bearer != null) conn.setRequestProperty("Authorization", "Bearer $bearer")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            return code to text
        } finally {
            conn.disconnect()
        }
    }

    private fun errorMessage(text: String, fallback: String): String = try {
        val o = JSONObject(text)
        o.optString("message").ifEmpty { o.optString("msg").ifEmpty { o.optString("error_description").ifEmpty { fallback } } }
    } catch (e: Exception) {
        fallback
    }

    private fun saveSession(o: JSONObject) {
        val expiresAt = if (o.has("expires_at")) o.getLong("expires_at") else System.currentTimeMillis() / 1000 + o.optLong("expires_in", 3600)
        prefs.edit()
            .putString("access_token", o.getString("access_token"))
            .putString("refresh_token", o.getString("refresh_token"))
            .putLong("expires_at", expiresAt)
            .putString("email", o.optJSONObject("user")?.optString("email"))
            .apply()
    }

    fun login(email: String, password: String) {
        val body = JSONObject().put("email", email).put("password", password).toString()
        val (code, text) = request("/auth/v1/token?grant_type=password", body, null)
        if (code !in 200..299) throw ApiException(errorMessage(text, "No se pudo iniciar sesión ($code)"))
        saveSession(JSONObject(text))
    }

    /** Devuelve un token válido, renovándolo si está a punto de caducar. */
    @Synchronized
    private fun token(): String {
        val refresh = prefs.getString("refresh_token", null) ?: throw ApiException("Sin sesión")
        val access = prefs.getString("access_token", null)
        val expiresAt = prefs.getLong("expires_at", 0)
        if (access != null && expiresAt - System.currentTimeMillis() / 1000 > 90) return access
        val (code, text) = request("/auth/v1/token?grant_type=refresh_token", JSONObject().put("refresh_token", refresh).toString(), null)
        if (code in 200..299) {
            saveSession(JSONObject(text))
            return prefs.getString("access_token", null)!!
        }
        // 400/401: la sesión ya no vale y hay que volver a entrar. Otros códigos son fallos pasajeros.
        if (code == 400 || code == 401) prefs.edit().remove("refresh_token").remove("access_token").apply()
        throw ApiException(errorMessage(text, "No se pudo renovar la sesión ($code)"))
    }

    /** Llama a una función RPC y devuelve su respuesta JSON como texto. */
    fun rpc(name: String, args: JSONObject): String {
        val (code, text) = request("/rest/v1/rpc/$name", args.toString(), token())
        if (code !in 200..299) throw ApiException(errorMessage(text, "Error del servidor ($code)"))
        return text
    }
}
