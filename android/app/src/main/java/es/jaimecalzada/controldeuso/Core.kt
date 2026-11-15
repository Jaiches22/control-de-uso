package es.jaimecalzada.controldeuso

import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// Misma lógica que shared/core.ts, en Kotlin. Si cambia una, hay que cambiar la otra.

data class Key(val kind: String, val value: String) {
    fun toJson(): JSONObject = JSONObject().put("kind", kind).put("value", value)
}

data class Limit(
    val id: String,
    val name: String,
    val dailySeconds: Int,
    val remainingSeconds: Int,
    val extraAvailable: Boolean,
    val targets: List<Key>,
) {
    fun matches(keys: List<Key>): Boolean = targets.any { t -> keys.any { k -> targetMatches(t, k) } }
}

/** Estado tal como lo devuelve el servidor (get_state / add_usage). Se guarda el JSON entero para el panel. */
class State(val json: JSONObject) {
    val day: String = json.optString("day")
    val resetsAt: String = json.optString("resets_at")

    /** Modo foco: hasta cuándo (en milisegundos) y sobre qué límites. Cero si no hay foco. */
    val focusEndsAt: Long
    val focusIds: Set<String>

    init {
        val f = json.optJSONObject("focus")
        val ids = f?.optJSONArray("limit_ids")
        focusEndsAt = try {
            if (f == null) 0L else java.time.OffsetDateTime.parse(f.getString("ends_at")).toInstant().toEpochMilli()
        } catch (e: Exception) {
            0L
        }
        focusIds = if (ids == null) emptySet() else (0 until ids.length()).map { ids.getString(it) }.toSet()
    }

    fun inFocus(limit: Limit, now: Long): Boolean = focusEndsAt > now && limit.id in focusIds
    val limits: List<Limit> = run {
        val arr = json.optJSONArray("limits") ?: JSONArray()
        (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            val ts = o.optJSONArray("targets") ?: JSONArray()
            Limit(
                id = o.getString("id"),
                name = o.optString("name"),
                dailySeconds = o.optInt("daily_seconds"),
                remainingSeconds = o.optInt("remaining_seconds"),
                extraAvailable = o.optBoolean("extra_available", false),
                targets = (0 until ts.length()).map { j ->
                    val t = ts.getJSONObject(j)
                    Key(t.getString("kind"), t.getString("value"))
                },
            )
        }
    }
}

data class PendingEntry(val keys: List<Key>, var seconds: Int, val day: String) {
    fun toJson(): JSONObject {
        val o = JSONObject().put("kind", keys[0].kind).put("value", keys[0].value).put("seconds", seconds).put("day", day)
        if (keys.size > 1) o.put("also", JSONArray(keys.drop(1).map { it.toJson() }))
        return o
    }

    companion object {
        fun fromJson(o: JSONObject): PendingEntry {
            val keys = mutableListOf(Key(o.getString("kind"), o.getString("value")))
            val also = o.optJSONArray("also")
            if (also != null) for (i in 0 until also.length()) {
                val k = also.getJSONObject(i)
                keys.add(Key(k.getString("kind"), k.getString("value")))
            }
            return PendingEntry(keys, o.getInt("seconds"), o.getString("day"))
        }
    }
}

val SHORTS = Key("special", "youtube_shorts")

/** Un dominio cubre sus subdominios; el resto de identificadores deben coincidir exactamente. */
fun targetMatches(t: Key, k: Key): Boolean {
    if (t.kind != k.kind) return false
    if (t.value == k.value) return true
    return t.kind == "domain" && k.value.endsWith("." + t.value)
}

fun pendingId(keys: List<Key>, day: String): String = day + "|" + keys.joinToString("|") { "${it.kind}:${it.value}" }

fun addPending(pending: MutableMap<String, PendingEntry>, keys: List<Key>, seconds: Int, day: String) {
    if (seconds <= 0 || keys.isEmpty()) return
    val id = pendingId(keys, day)
    val cur = pending[id]
    if (cur != null) cur.seconds += seconds else pending[id] = PendingEntry(keys, seconds, day)
}

/** Segundos que le quedan hoy a un límite: lo que dice el servidor menos lo local aún sin enviar. */
fun effectiveRemaining(limit: Limit, state: State, pending: Map<String, PendingEntry>, today: String, now: Long = System.currentTimeMillis()): Int {
    if (state.inFocus(limit, now)) return 0
    var remaining = if (state.day == today) limit.remainingSeconds else limit.dailySeconds
    for (e in pending.values) {
        if (e.day == today && limit.matches(e.keys)) remaining -= e.seconds
    }
    return maxOf(remaining, 0)
}

/** Cuántos segundos contar de un intervalo abierto. Si el hueco es raro (móvil dormido), no se cuenta. */
fun creditedSeconds(elapsedMs: Long): Int {
    val secs = (elapsedMs / 1000).toInt()
    if (secs <= 0 || secs > 120) return 0
    return minOf(secs, 60)
}

fun madridDay(now: Long): String {
    val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    f.timeZone = TimeZone.getTimeZone("Europe/Madrid")
    return f.format(Date(now))
}

fun fmtDuration(totalSeconds: Int): String {
    val s = maxOf(0, totalSeconds)
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return when {
        h > 0 -> "$h h $m min"
        m > 0 -> if (sec > 0) "$m min $sec s" else "$m min"
        else -> "$sec s"
    }
}

fun fmtClock(millis: Long): String = SimpleDateFormat("HH:mm", Locale.US).format(Date(millis))
