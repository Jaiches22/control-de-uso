package es.jaimecalzada.controldeuso

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject

/** Pantalla única: un WebView con el mismo panel que la app de Windows, conectado al motor nativo. */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private var exportId = 0
    private var exportText: String? = null

    private companion object { const val REQUEST_EXPORT = 7 }

    private val errors = mapOf(
        "target_in_use" to "Esa web o app ya está en otro límite.",
        "limit_not_found" to "Ese límite ya no existe.",
        "invalid_daily_seconds" to "Los minutos tienen que estar entre 0 y 1440.",
        "Invalid login credentials" to "Email o contraseña incorrectos.",
        "extra_already_used" to "El +5 de hoy ya está gastado.",
        "extra_not_allowed" to "Este límite no permite el +5 ahora mismo.",
        "focus_without_limits" to "Marca al menos un límite para el modo foco.",
        "invalid_minutes" to "El foco dura entre 1 y 720 minutos.",
    )

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Engine.init(applicationContext)
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.setBackgroundColor(0xFF111827.toInt())
        web.webViewClient = WebViewClient()
        web.addJavascriptInterface(Bridge(), "Android")
        setContentView(web)
        web.loadUrl("file:///android_asset/app/panel.html")
    }

    override fun onResume() {
        super.onResume()
        Engine.onChange = { web.evaluateJavascript("window.__cduChanged && window.__cduChanged()", null) }
        Engine.refresh()
        Updater.check { Engine.onChange?.invoke() }
    }

    override fun onPause() {
        Engine.onChange = null
        super.onPause()
    }

    private inner class Bridge {
        @JavascriptInterface
        fun send(id: Int, json: String) {
            runOnUiThread {
                try {
                    handle(id, JSONObject(json))
                } catch (e: Exception) {
                    fail(id, e)
                }
            }
        }
    }

    private fun reply(id: Int, payload: JSONObject) {
        web.evaluateJavascript("window.__cduReply($id, ${JSONObject.quote(payload.toString())})", null)
    }

    private fun ok(id: Int, result: Any?) = reply(id, JSONObject().put("ok", true).put("result", result ?: JSONObject.NULL))

    private fun fail(id: Int, e: Throwable) {
        val msg = e.message ?: e.toString()
        reply(id, JSONObject().put("ok", false).put("error", errors[msg] ?: msg))
    }

    private fun status(): JSONObject {
        val remaining = JSONObject()
        for ((k, v) in Engine.remaining()) remaining.put(k, v)
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        return JSONObject()
            .put("loggedIn", Engine.api.loggedIn)
            .put("email", Engine.api.email ?: JSONObject.NULL)
            .put("device", Engine.device ?: JSONObject.NULL)
            .put("state", Engine.state?.json ?: JSONObject.NULL)
            .put("remaining", remaining)
            .put("version", BuildConfig.VERSION_NAME)
            .put("foreground", Engine.foreground ?: JSONObject.NULL)
            .put("platformError", JSONObject.NULL)
            .put("platform", "android")
            .put("android", JSONObject()
                .put("accessibility", UsageService.instance != null)
                .put("notifications", getSystemService(NotificationManager::class.java).areNotificationsEnabled())
                .put("battery", power.isIgnoringBatteryOptimizations(packageName))
                .put("update", Updater.available?.let { JSONObject().put("version", it.version) } ?: JSONObject.NULL)
                .put("updateMessage", Updater.lastMessage ?: JSONObject.NULL)
                .put("shorts", Engine.shorts)
                .put("youtubeIds", JSONArray(Engine.youtubeIds)))
    }

    private fun handle(id: Int, msg: JSONObject) {
        when (msg.getString("type")) {
            "status" -> ok(id, status())
            "refresh" -> Engine.refresh { ok(id, status()) }
            "login" -> {
                val device = msg.optString("device").trim()
                if (device.isEmpty()) throw IllegalArgumentException("Pon un nombre a este dispositivo.")
                val email = msg.optString("email").trim()
                val password = msg.optString("password")
                Engine.background({ Engine.api.login(email, password) }) { r ->
                    r.onSuccess {
                        Engine.setDevice(device)
                        Engine.refresh { ok(id, status()) }
                    }.onFailure { fail(id, it) }
                }
            }
            "upsertLimit" -> config(id, "upsert_limit", JSONObject()
                .put("p_id", if (msg.isNull("id")) JSONObject.NULL else msg.getString("id"))
                .put("p_name", msg.getString("name"))
                .put("p_daily_seconds", msg.getInt("dailySeconds"))
                .put("p_allow_extra", msg.optBoolean("allowExtra"))
                .put("p_targets", msg.getJSONArray("targets")))
            "deleteLimit" -> config(id, "delete_limit", JSONObject().put("p_id", msg.getString("id")))
            "cancelPending" -> config(id, "cancel_pending", JSONObject().put("p_id", msg.getString("id")))
            "snoozeSuggestion" -> config(id, "snooze_suggestion", JSONObject().put("p_id", msg.getString("id")))
            "grantExtra" -> config(id, "grant_extra", JSONObject().put("p_limit_id", msg.getString("id")).put("p_device", Engine.device ?: "?"))
            "startFocus" -> config(id, "start_focus", JSONObject().put("p_limit_ids", msg.getJSONArray("ids")).put("p_minutes", msg.getInt("minutes")))
            "exportCsv" -> Engine.background({ JSONObject("{\"v\":" + Engine.api.rpc("export_usage_csv", JSONObject()) + "}").getString("v") }) { r ->
                r.onSuccess { csv ->
                    // Android abre su selector de "guardar como"; el resultado llega en onActivityResult.
                    exportId = id
                    exportText = csv
                    val pick = Intent(Intent.ACTION_CREATE_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("text/csv")
                        .putExtra(Intent.EXTRA_TITLE, "control-de-uso.csv")
                    try {
                        @Suppress("DEPRECATION")
                        startActivityForResult(pick, REQUEST_EXPORT)
                    } catch (e: Exception) {
                        exportText = null
                        fail(id, e)
                    }
                }.onFailure { fail(id, it) }
            }
            "installUpdate" -> {
                val update = Updater.available ?: throw IllegalStateException("No hay ninguna actualización pendiente.")
                Updater.install(this, update) { error -> if (error == null) ok(id, status()) else fail(id, error) }
            }
            "listApps" -> Engine.background({ installedApps() }) { r ->
                r.onSuccess { ok(id, it) }.onFailure { fail(id, it) }
            }
            "stats" -> {
                val args = JSONObject()
                    .put("p_bucket", msg.getString("bucket"))
                    .put("p_count", msg.getInt("count"))
                    .put("p_kind", if (msg.has("kind") && !msg.isNull("kind")) msg.getString("kind") else JSONObject.NULL)
                    .put("p_value", if (msg.has("value") && !msg.isNull("value")) msg.getString("value") else JSONObject.NULL)
                Engine.background({ JSONObject(Engine.api.rpc("get_stats", args)) }) { r ->
                    r.onSuccess { ok(id, it) }.onFailure { fail(id, it) }
                }
            }
            "openSettings" -> {
                openSettings(msg.optString("which"))
                ok(id, null)
            }
            else -> throw IllegalArgumentException("Mensaje desconocido")
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_EXPORT) return
        val text = exportText
        exportText = null
        val uri = data?.data
        if (resultCode != RESULT_OK || uri == null || text == null) {
            ok(exportId, JSONObject().put("saved", false))
            return
        }
        try {
            // El BOM hace que Excel abra bien los acentos.
            contentResolver.openOutputStream(uri)?.use { it.write(("\uFEFF" + text).toByteArray(Charsets.UTF_8)) }
            ok(exportId, JSONObject().put("saved", true))
        } catch (e: Exception) {
            fail(exportId, e)
        }
    }

    private fun config(id: Int, name: String, args: JSONObject) {
        Engine.call(name, args) { error -> if (error == null) ok(id, status()) else fail(id, error) }
    }

    /** Apps con icono en el cajón de aplicaciones, ordenadas por nombre. */
    private fun installedApps(): JSONArray {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val seen = HashSet<String>()
        val apps = packageManager.queryIntentActivities(intent, 0)
            .mapNotNull { info ->
                val pkg = info.activityInfo.packageName
                if (pkg == packageName || !seen.add(pkg)) null else pkg to info.loadLabel(packageManager).toString()
            }
            .sortedBy { it.second.lowercase() }
        return JSONArray(apps.map { JSONObject().put("id", it.first).put("label", it.second) })
    }

    private fun openSettings(which: String) {
        val pkgUri = Uri.parse("package:$packageName")
        val intent = when (which) {
            "accessibility" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            "appinfo" -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri)
            "battery" -> Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkgUri)
            "notifications" -> {
                val granted = Build.VERSION.SDK_INT < 33 ||
                    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
                if (!granted && shouldAsk()) {
                    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
                    return
                }
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
            }
            else -> return
        }
        try {
            startActivity(intent)
        } catch (e: Exception) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri))
        }
    }

    /** El diálogo del sistema solo sale las dos primeras veces; después hay que ir a los ajustes. */
    private fun shouldAsk(): Boolean {
        val prefs = getPreferences(Context.MODE_PRIVATE)
        val asked = prefs.getInt("asked_notifications", 0)
        prefs.edit().putInt("asked_notifications", asked + 1).apply()
        return asked < 2
    }
}
