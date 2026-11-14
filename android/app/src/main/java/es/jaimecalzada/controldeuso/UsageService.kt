package es.jaimecalzada.controldeuso

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.InputMethodManager
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Servicio de accesibilidad: sabe qué app está en primer plano, detecta la pantalla de Shorts de YouTube
 * y muestra el aviso de bloqueo. Android lo mantiene vivo y lo arranca solo al encender el móvil.
 */
class UsageService : AccessibilityService(), Engine.Host {

    companion object {
        @Volatile var instance: UsageService? = null
        private const val CH_STATUS = "estado"
        private const val CH_WARN = "avisos"
        private const val OVERLAY_MS = 2_500L
        private const val MAX_NODES = 900
        // Identificadores de vista del reproductor de Shorts (YouTube los llama "reel" por dentro).
        private val SHORTS_PREFIXES = listOf("reel_recycler", "reel_player", "reel_watch")
    }

    private val handler = Handler(Looper.getMainLooper())
    private var current: String? = null
    private var transient: Set<String> = emptySet()
    private var overlay: View? = null
    private var shortsBlocks = 0
    private var lastShortsBlockAt = 0L

    private val ticker = object : Runnable {
        override fun run() {
            tickOnce()
            handler.postDelayed(this, 1000)
        }
    }

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            handler.removeCallbacks(ticker)
            if (intent.action == Intent.ACTION_SCREEN_OFF) {
                Engine.tick(null, false)
                Engine.flushToDisk()
            } else {
                handler.post(ticker)
            }
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        Engine.init(applicationContext)
        instance = this

        // Paquetes que aparecen en primer plano sin ser "la app que estoy usando".
        val imes = (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
            .enabledInputMethodList.map { it.packageName }
        transient = (imes + listOf("com.android.systemui", "android")).toSet()
        val home = packageManager.resolveActivity(
            Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), 0)?.activityInfo?.packageName
        Engine.notCounted = setOfNotNull(home, "com.android.settings.intelligence")

        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_STATUS, "Tiempo restante", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CH_WARN, "Avisos de límite", NotificationManager.IMPORTANCE_HIGH))

        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(screenReceiver, filter)
        Engine.host = this
        handler.removeCallbacks(ticker)
        handler.post(ticker)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString() ?: return
        if (pkg !in transient) current = pkg
    }

    override fun onInterrupt() {}

    override fun onUnbind(intent: Intent?): Boolean {
        shutdown()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        shutdown()
        super.onDestroy()
    }

    private fun shutdown() {
        if (instance !== this) return
        instance = null
        handler.removeCallbacksAndMessages(null)
        try { unregisterReceiver(screenReceiver) } catch (e: Exception) { /* ya estaba quitado */ }
        removeOverlay()
        if (Engine.host === this) Engine.host = null
        Engine.flushToDisk()
    }

    private fun tickOnce() {
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        val keyguard = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        if (!power.isInteractive || keyguard.isKeyguardLocked) {
            Engine.tick(null, false)
            return
        }
        val root: AccessibilityNodeInfo? = try { rootInActiveWindow } catch (e: Exception) { null }
        val rootPkg = root?.packageName?.toString()
        // La ventana activa manda: corrige eventos que se hayan perdido (por ejemplo, al cerrar las notificaciones).
        if (rootPkg != null && rootPkg !in transient) current = rootPkg
        var shorts = false
        if (current == Engine.YOUTUBE && root != null && rootPkg == Engine.YOUTUBE) {
            shorts = try { scanYoutube(root) } catch (e: Exception) { false }
        }
        Engine.tick(current, shorts)
    }

    /** Recorre la pantalla de YouTube buscando el reproductor de Shorts. Guarda las pistas vistas para diagnóstico. */
    private fun scanYoutube(root: AccessibilityNodeInfo): Boolean {
        val seen = LinkedHashSet<String>()
        var found = false
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < MAX_NODES) {
            val node = queue.removeFirst()
            visited++
            val id = node.viewIdResourceName?.substringAfter(":id/")
            if (id != null) {
                val lower = id.lowercase()
                if (lower.contains("reel") || lower.contains("short")) {
                    if (seen.size < 12) seen.add(id)
                    if (!found && node.isVisibleToUser && SHORTS_PREFIXES.any { lower.startsWith(it) }) found = true
                }
            }
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                queue.add(child)
            }
        }
        Engine.youtubeIds = seen.toList()
        return found
    }

    // ---------------------------------------------------------------- Engine.Host

    override fun block(limit: Limit, shortsOnly: Boolean, state: State) {
        showOverlay(limit)
        val now = System.currentTimeMillis()
        if (shortsOnly) {
            // Primero se intenta salir de Shorts con "atrás"; si sigue ahí, se sale de YouTube.
            shortsBlocks = if (now - lastShortsBlockAt < 8_000) shortsBlocks + 1 else 1
            lastShortsBlockAt = now
            performGlobalAction(if (shortsBlocks >= 2) GLOBAL_ACTION_HOME else GLOBAL_ACTION_BACK)
        } else {
            performGlobalAction(GLOBAL_ACTION_HOME)
        }
    }

    override fun warn(message: String) {
        notify(2, Notification.Builder(this, CH_WARN)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Control de uso")
            .setContentText(message)
            .setAutoCancel(true)
            .setContentIntent(openApp())
            .build())
    }

    override fun status(text: String) {
        notify(1, Notification.Builder(this, CH_STATUS)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Control de uso")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp())
            .build())
    }

    private fun notify(id: Int, notification: Notification) {
        try {
            getSystemService(NotificationManager::class.java).notify(id, notification)
        } catch (e: Exception) {
            // Sin permiso de notificaciones: no pasa nada, el bloqueo funciona igual.
        }
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    // ---------------------------------------------------------------- aviso de bloqueo

    private fun text(content: String, sizeSp: Float, color: Int, bold: Boolean = false): TextView = TextView(this).apply {
        text = content
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        setTextColor(color)
        gravity = Gravity.CENTER
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        setPadding(48, 16, 48, 16)
    }

    private fun showOverlay(limit: Limit) {
        removeOverlay()
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#111827"))
            addView(text("Se acabó ${limit.name} por hoy", 28f, Color.parseColor("#F3F4F6"), bold = true))
            addView(text("Has gastado tus ${fmtDuration(limit.dailySeconds)} de hoy entre todos tus dispositivos.", 17f, Color.parseColor("#F3F4F6")))
            addView(text("Se reinicia a las 00:00.", 15f, Color.parseColor("#9CA3AF")))
        }
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.OPAQUE)
        try {
            (getSystemService(Context.WINDOW_SERVICE) as WindowManager).addView(box, params)
            overlay = box
            handler.postDelayed({ if (overlay === box) removeOverlay() }, OVERLAY_MS)
        } catch (e: Exception) {
            overlay = null
        }
    }

    private fun removeOverlay() {
        val view = overlay ?: return
        overlay = null
        try { (getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(view) } catch (e: Exception) { /* ya no estaba */ }
    }
}
