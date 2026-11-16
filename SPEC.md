# Control de uso — Especificación

App personal de autocontrol del tiempo de uso en mis propios dispositivos. Un solo usuario. No monitoriza a nadie más.

Este documento es la fuente de verdad. Si algo cambia, se actualiza aquí.

## 1. Dispositivos

| Dispositivo | Sistema | Dónde se cuenta y bloquea |
|---|---|---|
| PC | Windows | Navegador Brave (extensión) + apps de escritorio (app de bandeja) |
| Portátil | Windows | Igual que el PC |
| Móvil | Android (Samsung S23) | Apps (Instagram, YouTube oficiales, etc.) |

El navegador del móvil no se cubre: no se usa.

## 2. Funciones

### 2.1 Registro y estadísticas
- Se registra el tiempo en webs (por dominio), apps de escritorio (por proceso) y apps Android (por paquete), tengan límite o no.
- Gráficas de evolución por día, semana, mes y año dentro de la app de Windows y de la de Android. Sin correos.
- **Panel** (Windows y Android, misma pantalla): menú lateral (en el móvil, arriba), límites de hoy, cifras del periodo (tiempo total, media diaria, comparación con el periodo anterior y lo más usado), gráfica de barras apiladas por dispositivo y lista de lo más usado con su logo y el reparto por dispositivo.
- Filtros: periodo (hoy, 7 días, 30 días, 3 meses, 12 meses o fechas a mano), agrupación (automática, días, semanas, meses o años) y dispositivo.
- Cada dispositivo tiene un color fijo en las gráficas (azul, naranja y verde, paleta validada para daltonismo), asignado por orden alfabético de nombre para que no cambie al filtrar.
- **Logos y nombres:** la extensión sube el logo de cada web sacándolo de la caché de favicons del propio navegador (no se pide nada a las webs ni a terceros); la app de Windows, el icono del ejecutable; la de Android, el nombre e icono de la app. Se guardan en la tabla `app_meta` y se ven en todos los dispositivos.

### 2.2 Límites diarios compartidos
- Un límite corresponde a **un servicio** (no a una categoría o grupo de servicios) y tiene un único contador diario compartido entre los tres dispositivos.
- Cada límite puede tener varios identificadores: dominios web, procesos de Windows y paquetes Android. Ejemplo: "Instagram, 12 min/día" = `instagram.com` + `com.instagram.android`.
- Al agotarse, se bloquea en todos los dispositivos hasta las 00:00 (Europe/Madrid).
- El día se calcula siempre en el servidor con la zona Europe/Madrid.

### 2.3 YouTube Shorts
- YouTube normal no se limita.
- Web: solo las URL que contienen `/shorts/` (incluida la navegación interna sin recarga).
- Android: detección de la pantalla de Shorts dentro de la app de YouTube con el servicio de accesibilidad. Es frágil por diseño; se prueba así y se ajusta cuando YouTube cambie la interfaz.

### 2.4 Configuración
- Desde la app de Windows y la de Android: añadir, editar y borrar límites.
  - Webs: por dominio.
  - Apps de escritorio: elegidas de la lista de procesos abiertos.
  - Apps Android: elegidas de las instaladas.
- Se sincroniza sola en todos los dispositivos.
- **Regla anti-trampa:** bajar un límite, crear uno nuevo o añadirle identificadores se aplica al momento. Subir un límite, borrarlo o quitarle un identificador entra en vigor a las 00:00 (Europe/Madrid) siguientes. Los cambios pendientes se pueden cancelar.
- **Margen de corrección:** durante los 10 minutos siguientes a crear un límite se puede editar o borrar libremente (para arreglar erratas).
- La regla se aplica en el servidor: las tablas solo admiten lectura directa y toda escritura pasa por funciones.

### 2.4 bis Fricción para aflojar
- Subir los minutos de un límite o borrarlo exige teclear entera una frase larga (sin poder pegarla) que recuerda por qué se puso el límite. Además, el cambio sigue sin aplicarse hasta las 00:00.
- No hace falta durante los 10 minutos siguientes a crear el límite (margen para corregir erratas).

### 2.5 Sin pausa
No existe botón de pausa ni forma de desactivar el bloqueo desde la interfaz.

## 3. Reglas de conteo

- **Web:** solo la pestaña activa con la ventana de Brave enfocada. Se pausa tras 120 s de inactividad (`chrome.idle`), salvo que la pestaña esté reproduciendo sonido (un vídeo en marcha sigue contando).
- Un dominio incluye sus subdominios (`instagram.com` cubre `www.instagram.com`).
- **Windows:** app en primer plano. Se pausa tras 2 min sin teclado ni ratón (`GetLastInputInfo`).
- **Sin doble conteo:** cuando la ventana en primer plano es Brave, la app de escritorio no cuenta nada; lo cuenta la extensión.
- **Android:** pantalla encendida y app en primer plano.
- **Sin conexión:** cada dispositivo guarda en local lo pendiente y lo envía al volver. Mientras tanto aplica el último saldo conocido.
- **Ritmo de envío:** cada 30 s mientras hay uso, y al instante cuando se agota un límite. El bloqueo es al segundo porque la cuenta atrás se lleva en local.

## 4. Bloqueo

- **Web:** redirección a una página propia de la extensión que indica qué límite se agotó y cuándo se reinicia.
- **Apps de Windows:** ventana de aviso a pantalla completa y siempre encima mientras la app bloqueada esté en primer plano.
- **Android:** pantalla de aviso superpuesta (overlay) y vuelta al inicio.
- **Aviso previo:** notificación normal cuando queda 1 minuto.
- Los formularios de inicio de sesión tienen un botón para ver la contraseña.

## 5. Extras

- **+5 minutos:** solo aparece en la pantalla de bloqueo y solo en los límites marcados para ello en la configuración. Hay que mantener pulsado 5 s; después hay una cuenta atrás de 10 s cancelable. Una vez al día en total entre todos los dispositivos y todos los límites. Activar el +5 en un límite que ya existía entra en vigor a las 00:00 (regla anti-trampa). No se ofrece durante el modo foco.
- **Sugerencia de bajar límites:** si la media de uso de un límite en los últimos 14 días completos está por debajo del 70 % del límite, se propone uno nuevo: la media más un 15 % de margen, redondeada al minuto. Aparece en la pantalla de Límites con «Bajar» y «No, gracias» (no vuelve a salir en 14 días). Solo para límites con al menos 14 días de vida.
- **Modo foco:** bloquea los límites elegidos durante X minutos (1 a 720) en todos los dispositivos. No se puede cancelar ni acortar; sí ampliar o añadir límites.
- **Exportar a CSV** todos los datos de uso (día, tipo, web o app, dispositivo, segundos), desde la pestaña Estadísticas de Windows y Android.
- **Actualizaciones automáticas:** la app de Windows y la de Android consultan GitHub Releases. Windows se actualiza sola. Android avisa con una notificación y un botón «Actualizar» en la app, y pide confirmación al instalar (limitación del sistema). La extensión se instala sin empaquetar en una carpeta que gestiona la app de Windows, que la actualiza; la extensión se recarga sola al detectar una versión nueva.

## 6. Arquitectura

### 6.1 Backend: Supabase (plan gratis, región eu-west-3, París)
- Autenticación con email y contraseña. Un único usuario; el registro de usuarios nuevos queda desactivado una vez creado.
- RLS en todas las tablas: cada fila pertenece a un usuario y solo él puede leerla o escribirla.
- Las tablas nuevas no se exponen automáticamente a la API; los permisos se conceden de forma explícita en las migraciones.
- Contador atómico mediante función RPC (`add_usage`), que suma segundos y devuelve el estado completo. Resto de funciones: `get_state`, `upsert_limit`, `delete_limit`, `cancel_pending` `get_stats` (estadísticas agregadas por día, semana, mes o año), `grant_extra`, `start_focus`, `snooze_suggestion`, `export_usage_csv`, `get_stats_range` (estadísticas por rango de fechas y dispositivo), `get_app_meta` y `put_app_meta` (nombres y logos).
- Tablas: `limits`, `limit_targets` (identificadores de cada límite), `usage` (todo el uso, para estadísticas) y `limit_usage` (contador diario de cada límite).
- Realtime para propagar al momento bloqueos, cambios de límites, modo foco y uso del +5.
- Migraciones SQL versionadas en `supabase/migrations/`.

### 6.2 Extensión de Brave
- Manifest V3, TypeScript.
- Pulsos cada 30 s (mínimo que permiten las alarmas de Manifest V3).
- Debe activarse también en ventanas privadas (modo `split`: las ventanas privadas llevan su propio contador local y suman al mismo límite).
- Incluye una página de configuración de límites web, además de las de Windows y Android.
- No tiene botón de cerrar sesión.

### 6.3 App de Windows
- App de bandeja hecha con Electron y TypeScript (carpeta `desktop/`). Comparte con la extensión la lógica de límites y la pantalla de configuración (carpeta `shared/`).
- Panel con cuatro pestañas: Hoy, Límites, Estadísticas y Extensión de Brave.
- Mira la app en primer plano una vez por segundo (llamadas a `user32`/`kernel32` con koffi) y usa el tiempo de inactividad del sistema.
- No se cuentan Brave (lo cuenta la extensión) ni piezas del propio Windows (pantalla de bloqueo, menú Inicio, búsqueda).
- El aviso de bloqueo es una ventana a pantalla completa, siempre encima y que no roba el foco: se muestra mientras la app bloqueada está en primer plano y se quita al cambiar de ventana.
- Arranca con Windows, oculta en la bandeja. No tiene opción de salir.
- Instalador `.exe` por usuario, sin permisos de administrador (sin firmar: SmartScreen avisa la primera vez).
- Se actualiza sola desde GitHub Releases (electron-updater).
- Guarda la extensión en `%LOCALAPPDATA%\ControlDeUso\extension` y la actualiza con cada versión de la app; la extensión detecta el cambio y se recarga sola. La extensión tiene un identificador fijo (`key` en el manifiesto), así que no pierde la sesión al actualizarse.
- Limitación: las apps de la Microsoft Store pueden aparecer con el nombre de su contenedor (`applicationframehost.exe`).

### 6.4 App de Android
- Kotlin, sin librerías externas (carpeta `android/`). La pantalla es un WebView con el mismo panel que la app de Windows (`shared/`), conectado al motor nativo: Hoy, Límites, Estadísticas y Permisos.
- Un servicio de accesibilidad hace todo el trabajo: sabe qué app está en primer plano, detecta la pantalla de Shorts, muestra el aviso y vuelve al inicio. Android lo arranca solo al encender el móvil.
- Solo se cuenta con la pantalla encendida y desbloqueada. No se cuentan el lanzador, el teclado ni la interfaz del sistema.
- **Shorts:** se busca en la pantalla de YouTube el reproductor de Shorts por sus identificadores internos (`reel_recycler`, `reel_player…`, `reel_watch…`). Es frágil por diseño; la pestaña Permisos muestra si se detecta y qué pistas se ven, para ajustarlo cuando YouTube cambie.
- **Bloqueo:** aviso a pantalla completa unos segundos y vuelta al inicio. Si el límite es solo de Shorts, primero se pulsa «atrás» para salir de Shorts sin cerrar YouTube; si sigue en Shorts, se vuelve al inicio.
- Notificación de aviso cuando queda 1 minuto. No hay notificación permanente (se quitó a petición propia: no aportaba nada).
- Sincronización por consulta, sin conexión permanente: al cambiar de app, cada 30 s mientras hay uso, cada 15 s mientras la app en primer plano tiene límite, y al momento cuando se agota. Un bloqueo o un modo foco iniciado en otro dispositivo tarda como mucho 15 s en llegar al móvil.
- Permisos que necesita: accesibilidad (con «Permitir ajustes restringidos», por instalarse fuera de Play Store), notificaciones y quedar sin restricción de batería. No necesita acceso a datos de uso ni permiso de superposición: el aviso lo dibuja el propio servicio de accesibilidad.
- APK firmado siempre con la misma clave para que las actualizaciones se instalen encima. La clave vive en el secreto `ANDROID_KEYSTORE_BASE64` del repositorio.

### 6.5 Compilación y publicación
- GitHub Actions compila el instalador de Windows, el APK y el zip de la extensión y los publica en Releases.
- Secretos del repositorio: `SUPABASE_URL` y `SUPABASE_ANON_KEY` (se inyectan al compilar) y `ANDROID_KEYSTORE_BASE64` (firma del APK). `SUPABASE_ANON_KEY` contiene la clave *publishable* del proyecto, que es el nombre actual de la clave anon.
- Se publica una versión al cambiar el archivo `VERSION` en `main`; el workflow crea la etiqueta `vX.Y.Z` y la release.
- El repositorio es público: **nunca se suben claves ni contraseñas**. La contraseña de la base de datos solo la tiene el dueño y no se usa en ningún sitio del proyecto.
- La clave anon acaba dentro de los instaladores públicos. Es una clave pensada para ser pública: la privacidad de los datos la garantizan RLS y el registro cerrado.

## 7. Limitaciones conocidas

- Otros navegadores de Windows (por ejemplo, Edge) no cuentan ni bloquean webs. Se puede poner un límite a ese navegador como app de escritorio.
- La detección de Shorts en Android puede romperse con actualizaciones de YouTube.
- Sin conexión, el límite compartido no se puede garantizar entre dispositivos: se concilia al reconectar.
- Es autocontrol: se puede saltar desinstalando la app o la extensión. No se intenta impedir.

## 8. Fases

Cada fase termina con algo instalable y con instrucciones paso a paso.

1. Supabase (esquema, RLS, RPC, Realtime) + extensión de Brave con límites y bloqueo.
2. App de Windows: apps de escritorio, inactividad, overlay, configuración, estadísticas e instalador de la extensión.
3. App de Android: conteo, overlay, detección de Shorts y configuración.
4. Extras: +5 min, sugerencias, foco, CSV, gráficas completas y actualizaciones automáticas.

## 9. Registro de decisiones

| Fecha | Decisión |
|---|---|
| 2026-11-14 | Subir o borrar un límite entra en vigor a las 00:00; bajarlo, al momento. |
| 2026-11-14 | Un límite = un servicio con varios identificadores; sin categorías. |
| 2026-11-14 | No se cubre el navegador del móvil. |
| 2026-11-14 | Pulsos de la extensión cada 30 s; login con email y contraseña. |
| 2026-11-14 | App de Windows con Electron en lugar de C#/.NET: comparte código ya probado con la extensión, se puede probar automáticamente antes de publicar y trae actualización automática. A cambio ocupa más (instalador de unos 90 MB y más memoria). |
| 2026-11-14 | Un límite no puede llevar youtube.com y Shorts a la vez: youtube.com ya incluye Shorts. |
| 2026-11-14 | Android sin Jetpack Compose ni UsageStatsManager: panel compartido en un WebView y todo el conteo desde el servicio de accesibilidad. Menos permisos que conceder y la misma pantalla en móvil y ordenador. |
| 2026-11-15 | Fuera la notificación permanente de Android. Activar el +5 en un límite existente espera a las 00:00. |
| 2026-11-16 | Panel nuevo inspirado en StayFree (diseño propio, no una copia), con colores por dispositivo, filtros de fechas y dispositivo, y logos. Frase obligatoria para subir o borrar un límite. |
| 2026-11-14 | Android sincroniza por consulta periódica en lugar de Realtime, para no mantener una conexión abierta gastando batería. |
| 2026-11-14 | Margen de 10 minutos para corregir un límite recién creado. Un vídeo con sonido sigue contando aunque no se toque teclado ni ratón. |
| 2026-11-14 | Proyecto de Supabase en París (eu-west-3), con RLS automático y sin exposición automática de tablas. |
