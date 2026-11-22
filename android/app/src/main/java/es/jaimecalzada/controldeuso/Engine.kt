package es.jaimecalzada.controldeuso

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Motor: recibe cada segundo qué app está en primer plano, acumula su tiempo, lo sincroniza con Supabase
 * y avisa cuando un límite se agota. Todo su estado se toca solo desde el hilo principal; la red va aparte.
 */
object Engine {
    const val YOUTUBE = "com.google.android.youtube"
    private const val FLUSH_EVERY_MS = 28_000L
    private const val LIMITED_REFRESH_MS = 15_000L
    private const val IDLE_REFRESH_MS = 60_000L
    private const val SWITCH_REFRESH_MS = 10_000L
    private const val RETRY_GAP_MS = 3_000L
    private const val BLOCK_GAP_MS = 2_000L

    interface Host {
        /** focusUntil > 0 cuando el bloqueo viene del modo foco y no de haber agotado el tiempo. */
        fun block(limit: Limit, shortsOnly: Boolean, focusUntil: Long)
        fun warn(limitId: String, message: String)
        /** Retira el aviso de «queda 1 minuto» de ese límite. */
        fun clearWarning(limitId: String)
    }

    private class Cur(val keys: List<Key>, var since: Long)

    private var ready = false
    private lateinit var prefs: SharedPreferences
    lateinit var api: Api
        private set
    private var ownPackage = ""
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()

    var state: State? = null
        private set
    val pending = LinkedHashMap<String, PendingEntry>()
    var host: Host? = null
    var onChange: (() -> Unit)? = null

    /** Paquetes que no son "usar una app": el lanzador, el teclado, la interfaz del sistema. */
    var notCounted: Set<String> = emptySet()
    var foreground: String? = null
        private set
    var shorts = false
        private set
    var youtubeIds: List<String> = emptyList()

    private var cur: Cur? = null
    private var lastFlushAt = 0L
    private var lastAttemptAt = 0L
    private var lastBlockAt = 0L
    private var syncing = false
    private var refreshWanted = true
    private var ticks = 0
    private var warnedDay = ""
    private val warnedIds = HashSet<String>()
    private val clearedIds = HashSet<String>()
    private var lastPkg: String? = null

    val device: String? get() = prefs.getString("device", null)

    fun init(ctx: Context) {
        if (ready) return
        val app = ctx.applicationContext
        prefs = app.getSharedPreferences("control_de_uso", Context.MODE_PRIVATE)
        api = Api(prefs)
        ownPackage = app.packageName
        try {
            val arr = JSONArray(prefs.getString("pending", "[]"))
            for (i in 0 until arr.length()) {
                val e = PendingEntry.fromJson(arr.getJSONObject(i))
                pending[pendingId(e.keys, e.day)] = e
            }
            prefs.getString("state", null)?.let { state = State(JSONObject(it)) }
        } catch (e: Exception) {
            pending.clear()
        }
        ready = true
    }

    private fun persist() {
        prefs.edit().putString("pending", JSONArray(pending.values.map { it.toJson() }).toString()).apply()
    }

    fun setDevice(name: String) {
        prefs.edit().putString("device", name).apply()
        refreshWanted = true
    }

    fun remaining(): Map<String, Int> {
        val st = state ?: return emptyMap()
        val today = madridDay(System.currentTimeMillis())
        return st.limits.associate { it.id to effectiveRemaining(it, st, pending, today) }
    }

    /** Ejecuta trabajo de red fuera del hilo principal y entrega el resultado en el hilo principal. */
    fun <T> background(work: () -> T, done: (Result<T>) -> Unit) {
        io.execute {
            val result = runCatching(work)
            main.post { done(result) }
        }
    }

    private fun applyState(text: String) {
        state = State(JSONObject(text))
        prefs.edit().putString("state", text).apply()
        onChange?.invoke()
    }

    /** Llama a una función de configuración (crear, editar o borrar límites) y aplica el estado que devuelve. */
    fun call(name: String, args: JSONObject, done: (Throwable?) -> Unit) {
        background({ api.rpc(name, args) }) { r ->
            r.onSuccess { applyState(it) }
            done(r.exceptionOrNull())
        }
    }

    fun grantExtra(limitId: String, done: (Throwable?) -> Unit) {
        call("grant_extra", JSONObject().put("p_limit_id", limitId).put("p_device", device ?: "?"), done)
    }

    fun refresh(done: (() -> Unit)? = null) {
        refreshWanted = true
        sync(done)
    }

    /** pkg = null cuando la pantalla está apagada o bloqueada. */
    fun tick(pkg: String?, shortsNow: Boolean) {
        if (!ready) return
        val dev = device
        foreground = pkg
        shorts = pkg == YOUTUBE && shortsNow
        if (dev == null || !api.loggedIn) return
        val now = System.currentTimeMillis()
        val today = madridDay(now)
        if (warnedDay != today) { warnedDay = today; warnedIds.clear(); clearedIds.clear() }

        val fgKeys: List<Key>? =
            if (pkg == null || pkg == ownPackage) null
            else if (shorts) listOf(Key("android_package", pkg), SHORTS)
            else listOf(Key("android_package", pkg))
        var keys = if (pkg != null && pkg in notCounted) null else fgKeys

        // 1. Cerrar el intervalo abierto.
        cur?.let { c ->
            val elapsed = now - c.since
            if (elapsed >= 1000) {
                val secs = creditedSeconds(elapsed)
                addPending(pending, c.keys, secs, today)
                c.since = if (secs > 0 && elapsed < 61_000) c.since + secs * 1000L else now
            }
        }

        // 2. Aplicar los límites a la app en primer plano.
        var blocked: Limit? = null
        var tightest: Pair<Limit, Int>? = null
        val st = state
        if (fgKeys != null && st != null) {
            for (limit in st.limits) {
                if (!limit.matches(fgKeys)) continue
                val left = effectiveRemaining(limit, st, pending, today)
                if (left <= 0) { if (blocked == null) blocked = limit; continue }
                if (left <= 60 && warnedIds.add(limit.id)) {
                    host?.warn(limit.id, "Te queda ${fmtDuration(left)} de ${limit.name} por hoy.")
                }
                if (tightest == null || left < tightest!!.second) tightest = limit to left
            }
        }
        if (blocked != null && st != null) {
            keys = null
            if (now - lastBlockAt > BLOCK_GAP_MS) {
                lastBlockAt = now
                // Si el límite solo coincide por Shorts, basta con salir de Shorts; si no, se sale de la app.
                val shortsOnly = !blocked.matches(listOf(Key("android_package", pkg ?: "")))
                host?.block(blocked, shortsOnly, if (st.inFocus(blocked, now)) st.focusEndsAt else 0L)
            }
        }

        // 2b. El aviso de «queda 1 minuto» sobra en cuanto ese límite se agota (aquí o en otro dispositivo).
        if (st != null) {
            for (id in warnedIds) {
                if (id in clearedIds) continue
                val limit = st.limits.firstOrNull { it.id == id }
                if (limit == null || effectiveRemaining(limit, st, pending, today) <= 0) {
                    clearedIds.add(id)
                    host?.clearWarning(id)
                }
            }
        }

        // 3. Abrir el intervalo nuevo.
        val prev = cur
        cur = if (keys == null) null else Cur(keys, if (prev != null && prev.keys == keys) prev.since else now)

        // 4. Sincronizar cuando toca. Al cambiar de app se refresca para enterarse pronto de bloqueos de otros dispositivos.
        val hasPending = pending.isNotEmpty()
        val stale = st == null || st.day != today
        val limited = tightest != null || blocked != null
        val sinceFlush = now - lastFlushAt
        val switched = pkg != null && pkg != lastPkg
        lastPkg = pkg
        val due = refreshWanted || stale ||
            (hasPending && (sinceFlush > FLUSH_EVERY_MS || blocked != null)) ||
            (limited && sinceFlush > LIMITED_REFRESH_MS) ||
            (switched && sinceFlush > SWITCH_REFRESH_MS) ||
            (pkg != null && sinceFlush > IDLE_REFRESH_MS)
        if (due && (refreshWanted || now - lastAttemptAt > RETRY_GAP_MS)) sync(null)

        if (++ticks % 10 == 0) persist()
    }

    /** Envía lo pendiente (o pide el estado). Lo que se acumule mientras tanto se conserva. */
    private fun sync(done: (() -> Unit)?) {
        val dev = device
        if (syncing || dev == null || !api.loggedIn) { done?.invoke(); return }
        syncing = true
        refreshWanted = false
        lastAttemptAt = System.currentTimeMillis()
        val sent = pending.mapValues { it.value.seconds }
        val entries = JSONArray(pending.values.map { it.toJson() })
        background({
            if (sent.isEmpty()) api.rpc("get_state", JSONObject())
            else api.rpc("add_usage", JSONObject().put("p_device", dev).put("p_entries", entries))
        }) { r ->
            syncing = false
            r.onSuccess { text ->
                for ((id, secs) in sent) {
                    val e = pending[id] ?: continue
                    e.seconds -= secs
                    if (e.seconds <= 0) pending.remove(id)
                }
                lastFlushAt = System.currentTimeMillis()
                persist()
                applyState(text)
            }
            done?.invoke()
        }
    }

    fun flushToDisk() { if (ready) persist() }
}
