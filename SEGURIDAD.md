# Seguridad — Almacén La Campiña

## Lo que ya viene hecho en el código

**Base de datos (Supabase / Postgres)**
- **RLS en todas las tablas.** Los visitantes solo leen el catálogo y envían cotizaciones; no pueden leer cotizaciones, ventas, pagos ni administradores.
- **Admin = lista + MFA.** No basta con tener usuario: debe estar en la tabla `admins` **y** haber entrado con el código del celular (`aal2`). Un admin con solo contraseña no puede modificar nada.
- **Privilegios por columna.** Los visitantes solo pueden enviar `nombre, telefono, detalle, items`; el admin no puede escribir totales, saldos, estados de pago ni códigos (los calcula la BD).
- **Anti-spam** en el formulario: máx. 3 cotizaciones por teléfono cada 15 min y 15 por minuto en total, más un campo trampa para bots.
- **Validaciones en la BD**: largos, teléfonos, URLs solo `https://` (bloquea `javascript:`), claves de ajustes permitidas, montos positivos, fechas no futuras.
- **Fotos**: bucket `productos` público solo para lectura, máx. 2 MB, solo imágenes, sin listado de archivos. Las fotos se reescalan y re-codifican en el navegador (se eliminan datos EXIF/GPS).
- **Comprobantes SINPE**: bucket `comprobantes` **privado**, solo admin, enlaces temporales de 2 min, no se pueden borrar ni reemplazar.
- **Bitácora** (`auditoria`) de todo cambio hecho desde el panel.
- Funciones `security definer` con `search_path` fijo.

**Páginas**
- **Content-Security-Policy** estricta: solo scripts, estilos y fuentes del mismo sitio; conexiones solo a `*.supabase.co`. Sin scripts en línea.
- **Sin CDNs**: supabase-js y las fuentes se sirven desde el propio repo (nadie de afuera puede inyectar código).
- Todo texto que viene de la BD se **escapa** antes de mostrarse (evita XSS); los enlaces pasan por `safeUrl`.
- Panel: `noindex`, no enlazado desde el sitio, no funciona dentro de iframes (anti-clickjacking), **cierre de sesión tras 30 min sin uso**, `no-referrer`.
- CSV exportado protegido contra **inyección de fórmulas** en Excel.

## Lo que hay que configurar a mano en Supabase (Dashboard)

| Dónde | Qué | Por qué |
|---|---|---|
| Authentication → Sign In / Providers → **Allow new users to sign up: OFF** | Desactivar registros | Nadie más puede crearse cuenta |
| Authentication → Sign In / Providers → Email → **Confirm email: ON** | Confirmar correos | |
| Authentication → Policies (o Passwords) → **Minimum length: 12** y requerir letras + números + símbolos | Contraseñas fuertes | |
| Authentication → Multi-Factor → **TOTP: Enabled** (viene activado) | MFA | El panel lo exige |
| Authentication → URL Configuration → **Site URL** = `https://johancubillo.github.io/almacen-la-campina/` | URL oficial | Correos de recuperación apuntan al sitio correcto |
| Authentication → Rate Limits | Dejar los valores por defecto (o bajarlos) | Frena ataques de fuerza bruta |
| Project Settings → API | **Nunca** compartir la `service_role` key | Salta todas las reglas |
| Database → Backups | El plan gratis no tiene backups automáticos: exportar con `pg_dump` o *Database → Backups* si se pasa a Pro | |

## GitHub
- Activar **2FA** en la cuenta de GitHub.
- Settings → Pages → **Enforce HTTPS** ✓.
- No subir nunca archivos `.env` ni la `service_role` (el `.gitignore` ya lo evita).

## Rutinas
- **Diario:** cuadrar la Caja SINPE con la app del banco; no entregar nada *Por verificar*.
- **Mensual:** descargar el CSV del mes; revisar la Actividad reciente.
- **Si se pierde el celular del MFA:** en Supabase → Authentication → Users → (usuario) → borrar el factor MFA; al entrar de nuevo pedirá configurarlo.
- **Si alguien deja de trabajar en el almacén:** borrarlo de `public.admins` y de Authentication.

## Privacidad
Las cotizaciones y ventas guardan nombre y teléfono de clientes. Usarlos solo para atender el pedido, no compartirlos, y borrar cotizaciones viejas que no se convirtieron en venta (Cotizaciones → Borrar).
