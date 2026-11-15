package es.jaimecalzada.controldeuso

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Actualizaciones desde GitHub Releases: mira la última versión publicada y, si es más nueva, la instala encima. */
object Updater {
    private const val LATEST = "https://api.github.com/repos/Jaiches22/control-de-uso/releases/latest"

    data class Update(val version: String, val url: String)

    @Volatile var available: Update? = null
        private set
    @Volatile var lastMessage: String? = null

    fun check(done: (Update?) -> Unit) {
        Engine.background({ fetchLatest() }) { r ->
            if (r.isSuccess) available = r.getOrNull()
            done(available)
        }
    }

    /** Compara versiones tipo 0.4.0 número a número. */
    fun isNewer(candidate: String, current: String): Boolean {
        val a = candidate.trimStart('v').split(".").map { it.toIntOrNull() ?: 0 }
        val b = current.trimStart('v').split(".").map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }
            val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    private fun open(url: String): HttpURLConnection {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 30_000
        conn.setRequestProperty("Accept", "application/vnd.github+json, application/octet-stream")
        conn.setRequestProperty("User-Agent", "control-de-uso")
        return conn
    }

    private fun fetchLatest(): Update? {
        val conn = open(LATEST)
        try {
            if (conn.responseCode != 200) return null
            val release = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
            val version = release.optString("tag_name").trimStart('v')
            if (!isNewer(version, BuildConfig.VERSION_NAME)) return null
            val assets = release.optJSONArray("assets") ?: return null
            for (i in 0 until assets.length()) {
                val asset = assets.getJSONObject(i)
                if (asset.optString("name").endsWith(".apk")) return Update(version, asset.getString("browser_download_url"))
            }
            return null
        } finally {
            conn.disconnect()
        }
    }

    /** Descarga el APK directamente a una sesión de instalación; Android pide después la confirmación. */
    fun install(ctx: Context, update: Update, done: (Throwable?) -> Unit) {
        val app = ctx.applicationContext
        lastMessage = null
        Engine.background({
            val installer = app.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            params.setAppPackageName(app.packageName)
            val id = installer.createSession(params)
            installer.openSession(id).use { session ->
                val conn = open(update.url)
                try {
                    if (conn.responseCode != 200) throw ApiException("No se pudo descargar la actualización (${conn.responseCode})")
                    session.openWrite("control-de-uso.apk", 0, -1).use { out ->
                        conn.inputStream.use { it.copyTo(out) }
                        session.fsync(out)
                    }
                } finally {
                    conn.disconnect()
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                val pending = PendingIntent.getBroadcast(app, id, Intent(app, InstallReceiver::class.java), flags)
                session.commit(pending.intentSender)
            }
        }) { r -> done(r.exceptionOrNull()) }
    }
}

/** Recibe el resultado de la instalación: abre la confirmación de Android o guarda el motivo del fallo. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm: Intent? =
                    if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                    else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                if (confirm != null) {
                    try {
                        context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    } catch (e: Exception) {
                        Updater.lastMessage = "No se pudo abrir la confirmación de instalación."
                    }
                }
            }
            PackageInstaller.STATUS_SUCCESS -> Updater.lastMessage = null
            else -> Updater.lastMessage = "La instalación no se completó: " +
                (intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "motivo desconocido")
        }
        Engine.onChange?.invoke()
    }
}
