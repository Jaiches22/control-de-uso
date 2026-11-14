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
- **Regla anti-trampa:** bajar un límite o crear uno nuevo se aplica al momento. Subir un límite, borrarlo o quitarle un identificador entra en vigor a las 00:00 (Europe/Madrid) siguientes.

### 2.5 Sin pausa
No existe botón de pausa ni forma de desactivar el bloqueo desde la interfaz.

## 3. Reglas de conteo

- **Web:** solo la pestaña activa con la ventana de Brave enfocada. Se pausa tras 120 s de inactividad (`chrome.idle`).
- **Windows:** app en primer plano. Se pausa tras 2 min sin teclado ni ratón (`GetLastInputInfo`).
- **Sin doble conteo:** cuando la ventana en primer plano es Brave, la app de escritorio no cuenta nada; lo cuenta la extensión.
- **Android:** pantalla encendida y app en primer plano.
- **Sin conexión:** cada dispositivo guarda en local lo pendiente y lo envía al volver. Mientras tanto aplica el último saldo conocido.
- **Ritmo de envío:** lo que tiene límite se envía cada 30 s; el resto (solo estadísticas) se agrupa y se envía cada pocos minutos. El bloqueo es al segundo porque la cuenta atrás se lleva en local.

## 4. Bloqueo

- **Web:** redirección a una página propia de la extensión que indica qué límite se agotó y cuándo se reinicia.
- **Apps de Windows:** ventana de aviso a pantalla completa y siempre encima mientras la app bloqueada esté en primer plano.
- **Android:** pantalla de aviso superpuesta (overlay) y vuelta al inicio.
- **Aviso previo:** notificación normal cuando queda 1 minuto.

## 5. Extras

- **+5 minutos:** solo aparece en la pantalla de bloqueo y solo en los límites marcados para ello en la configuración. Hay que mantener pulsado 5 s; después hay una cuenta atrás de 10 s cancelable. Una vez al día en total entre todos los dispositivos y todos los límites.
- **Sugerencia de bajar límites:** si la media de uso de un límite en las últimas 2 semanas está por debajo del 70 % del límite, se propone uno nuevo más bajo.
- **Modo foco:** bloquea la lista de límites elegida durante X minutos en todos los dispositivos. No se puede cancelar.
- **Exportar a CSV** todos los datos de uso.
- **Actualizaciones automáticas:** la app de Windows y la de Android consultan GitHub Releases. Android pide confirmación al instalar cada actualización (limitación del sistema). La extensión se instala sin empaquetar en una carpeta que gestiona la app de Windows, que la actualiza; la extensión se recarga sola al detectar una versión nueva.

## 6. Arquitectura

### 6.1 Backend: Supabase (plan gratis, región eu-west-3, París)
- Autenticación con email y contraseña. Un único usuario; el registro de usuarios nuevos queda desactivado una vez creado.
- RLS en todas las tablas: cada fila pertenece a un usuario y solo él puede leerla o escribirla.
- Las tablas nuevas no se exponen automáticamente a la API; los permisos se conceden de forma explícita en las migraciones.
- Contador atómico mediante función RPC (`add_usage`), que suma segundos y devuelve lo que queda.
- Realtime para propagar al momento bloqueos, cambios de límites, modo foco y uso del +5.
- Migraciones SQL versionadas en `supabase/migrations/`.

### 6.2 Extensión de Brave
- Manifest V3, TypeScript.
- Pulsos cada 30 s (mínimo que permiten las alarmas de Manifest V3).
- Debe activarse también en ventanas privadas.

### 6.3 App de Windows
- App de bandeja en C# / .NET 10 (LTS), con panel de configuración y estadísticas.
- Instalador `.exe` (sin firmar: SmartScreen avisa la primera vez).
- Instala y actualiza la carpeta de la extensión.

### 6.4 App de Android
- Kotlin + Jetpack Compose.
- AccessibilityService (app en primer plano y detección de Shorts), UsageStatsManager (conciliación) y overlay.
- Notificación fija con el tiempo restante.
- Se instala desde fuera de Play Store; requiere "Permitir ajustes restringidos", accesibilidad, acceso a uso, superposición y quedar excluida de la optimización de batería.
- APK firmado siempre con la misma clave (guardada como secreto del repositorio) para que las actualizaciones se instalen encima.

### 6.5 Compilación y publicación
- GitHub Actions compila el instalador de Windows, el APK y el zip de la extensión y los publica en Releases.
- Secretos del repositorio: `SUPABASE_URL` y `SUPABASE_ANON_KEY` (se inyectan al compilar), más los de la firma de Android.
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
| 2026-11-14 | .NET 10 en lugar de .NET 8; pulsos de la extensión cada 30 s; login con email y contraseña. |
| 2026-11-14 | Proyecto de Supabase en París (eu-west-3), con RLS automático y sin exposición automática de tablas. |
