package es.jaimecalzada.controldeuso

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.annotation.SuppressLint
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
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Servicio de accesibilidad: sabe qué app está en primer plano, detecta la pantalla de Shorts de YouTube
 * y muestra el aviso de bloqueo. Android lo mantiene vivo y lo arranca solo al encender el móvil.
 */
class UsageService : AccessibilityService(), Engine.Host {

    companion object {
        @Volatile var instance: UsageService? = null
        private const val CH_WARN = "avisos"
        private const val OVERLAY_MS = 2_500L
        private const val OVERLAY_EXTRA_MS = 60_000L
        private const val EXTRA_HOLD_MS = 5_000L
        private const val EXTRA_COUNTDOWN_S = 10
        private const val EXTRA_IDLE = "Mantén pulsado 5 s para +5 minutos"
        private const val MAX_NODES = 900
        // Identificadores de vista del reproductor de Shorts (YouTube los llama "reel" por dentro).
        private val SHORTS_PREFIXES = listOf("reel_recycler", "reel_player", "reel_watch")
    }

    private val handler = Handler(Looper.getMainLooper())
    private var current: String? = null
    private var transient: Set<String> = emptySet()
    private var overlay: View? = null
    private var overlayKey = ""
    private var lastUpdateCheck = 0L
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
        // Versiones anteriores dejaban una notificación permanente: se retira junto con su canal.
        nm.cancel(1)
        nm.deleteNotificationChannel("estado")
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
        checkForUpdate()
    }

    /** Una vez cada 12 horas mira si hay versión nueva y, si la hay, avisa con una notificación normal. */
    private fun checkForUpdate() {
        val now = System.currentTimeMillis()
        if (now - lastUpdateCheck < 12 * 3600_000L) return
        lastUpdateCheck = now
        Updater.check { update ->
            if (update != null) notifyUser(3, "Hay una versión nueva (${update.version}). Abre Control de uso para actualizar.")
        }
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

    override fun block(limit: Limit, shortsOnly: Boolean, focusUntil: Long) {
        if (focusUntil > 0) {
            showOverlay(limit, "${limit.name} está en modo foco", "Lo bloqueaste tú hasta las ${fmtClock(focusUntil)}.", extra = false)
        } else {
            showOverlay(limit, "Se acabó ${limit.name} por hoy",
                "Has gastado tu tiempo de hoy (${fmtDuration(limit.dailySeconds)}) entre todos tus dispositivos.\nSe reinicia a las 00:00.",
                extra = limit.extraAvailable)
        }
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

    override fun warn(limitId: String, message: String) = notifyUser(warningId(limitId), message)

    override fun clearWarning(limitId: String) {
        try { getSystemService(NotificationManager::class.java).cancel(warningId(limitId)) } catch (e: Exception) { /* nada que quitar */ }
    }

    /** Un aviso por límite, para poder quitar cada uno cuando se agota. */
    private fun warningId(limitId: String): Int = 1000 + (limitId.hashCode() and 0xffff)

    /** Notificación normal (no permanente). Si no hay permiso de notificaciones, no pasa nada. */
    fun notifyUser(id: Int, message: String) {
        try {
            getSystemService(NotificationManager::class.java).notify(id, Notification.Builder(this, CH_WARN)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Control de uso")
                .setContentText(message)
                .setAutoCancel(true)
                .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
                .build())
        } catch (e: Exception) {
            // Sin permiso: el bloqueo funciona igual.
        }
    }

    // ---------------------------------------------------------------- aviso de bloqueo

    private fun label(content: String, sizeSp: Float, color: Int, bold: Boolean = false): TextView = TextView(this).apply {
        text = content
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        setTextColor(color)
        gravity = Gravity.CENTER
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        setPadding(48, 16, 48, 16)
    }

    private fun button(content: String): Button = Button(this).apply {
        text = content
        isAllCaps = false
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            topMargin = 36
        }
    }

    private fun showOverlay(limit: Limit, title: String, detail: String, extra: Boolean) {
        // Si ya se está mostrando este mismo aviso, no se rehace (se perdería una pulsación larga en curso).
        val key = "${limit.id}|$title|$extra"
        if (overlay != null && overlayKey == key) return
        removeOverlay()
        val light = Color.parseColor("#F3F4F6")
        val muted = Color.parseColor("#9CA3AF")
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#111827"))
            addView(label(title, 28f, light, bold = true))
            addView(label(detail, 17f, light))
        }
        if (extra) {
            val note = label("Solo una vez al día entre todos tus dispositivos.", 14f, muted)
            val hold = button(EXTRA_IDLE)
            wireExtraButton(hold, note, limit.id)
            val close = button("Cerrar")
            close.setOnClickListener { removeOverlay() }
            box.addView(hold)
            box.addView(note)
            box.addView(close)
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
            overlayKey = key
            // Sin botón de +5 el aviso dura un momento; con él, espera a que decidas (como mucho un minuto).
            handler.postDelayed({ if (overlay === box) removeOverlay() }, if (extra) OVERLAY_EXTRA_MS else OVERLAY_MS)
        } catch (e: Exception) {
            overlay = null
        }
    }

    /** +5 minutos: mantener pulsado 5 s y después una cuenta atrás de 10 s que se cancela tocando. */
    @SuppressLint("ClickableViewAccessibility")
    private fun wireExtraButton(btn: Button, note: TextView, limitId: String) {
        var phase = 0 // 0 = en reposo, 1 = pulsando, 2 = cuenta atrás, 3 = concediendo
        var startedAt = 0L
        var left = 0
        lateinit var holdStep: Runnable
        lateinit var countStep: Runnable
        fun reset() {
            handler.removeCallbacks(holdStep)
            handler.removeCallbacks(countStep)
            phase = 0
            btn.isEnabled = true
            btn.text = EXTRA_IDLE
        }
        countStep = Runnable {
            left -= 1
            if (left > 0) {
                btn.text = "+5 minutos en $left s · toca para cancelar"
                handler.postDelayed(countStep, 1000)
            } else {
                phase = 3
                btn.isEnabled = false
                btn.text = "Concediendo…"
                Engine.grantExtra(limitId) { error ->
                    if (error == null) {
                        removeOverlay()
                    } else {
                        note.text = when (error.message) {
                            "extra_already_used" -> "El +5 de hoy ya está gastado."
                            "extra_not_allowed" -> "Este límite no permite el +5 ahora mismo."
                            else -> "No se pudo conceder: ${error.message}"
                        }
                        reset()
                    }
                }
            }
        }
        holdStep = Runnable {
            val remaining = EXTRA_HOLD_MS - (System.currentTimeMillis() - startedAt)
            if (remaining > 0) {
                btn.text = "Sigue pulsando… ${(remaining + 999) / 1000}"
                handler.postDelayed(holdStep, 100)
            } else {
                phase = 2
                left = EXTRA_COUNTDOWN_S
                btn.text = "+5 minutos en $left s · toca para cancelar"
                handler.postDelayed(countStep, 1000)
            }
        }
        btn.setOnTouchListener { _, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> when (phase) {
                    2 -> reset()
                    0 -> { phase = 1; startedAt = System.currentTimeMillis(); handler.post(holdStep) }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (phase == 1) reset()
            }
            true
        }
    }

    private fun removeOverlay() {
        val view = overlay ?: return
        overlay = null
        overlayKey = ""
        try { (getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(view) } catch (e: Exception) { /* ya no estaba */ }
    }
}
