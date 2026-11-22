# Seguridad — Almacén La Campiña

## Lo que ya viene hecho en el código

**Base de datos (Supabase / Postgres)**
- **RLS en todas las tablas.** Los visitantes solo leen el catálogo; no pueden leer pedidos, pagos, comprobantes ni administradores.
- **Pedidos de clientes por funciones, no por tablas.** El navegador del cliente solo llama `crear_pedido_web`, `consultar_pedido`, `solicitar_subida` y `reportar_comprobante`, que validan todo, ponen los precios del catálogo y limitan abusos. El cliente se identifica con **código (8 caracteres) + teléfono**; 5 intentos fallidos bloquean ese código 15 minutos.
- **Subida de comprobantes de clientes:** solo a la ruta exacta que autoriza el sistema (vence en 15 min, un solo uso, máx. 5 por pedido al día, 5 MB, imagen o PDF). El cliente no puede ver, listar ni borrar archivos.
- **Admin = lista + MFA.** No basta con tener usuario: debe estar en la tabla `admins` **y** haber entrado con el código del celular (`aal2`). Un admin con solo contraseña no puede modificar nada.
- **Privilegios por columna.** El admin no puede escribir totales, saldos, estados de pago ni códigos (los calcula la BD).
- **Anti-spam:** máx. 3 pedidos por teléfono cada 15 min y 15 por minuto en total, más un campo trampa para bots.
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
Los pedidos guardan nombre y teléfono de clientes y fotos de comprobantes. Usarlos solo para atender el pedido y no compartirlos. Los pedidos sin pagos se pueden borrar desde el panel; los comprobantes quedan como respaldo contable.

## Mejoras v4

- **Telegram:** el token del bot se guarda en la tabla `avisos`, que solo lee el admin con MFA. Los mensajes los envía la base de datos (pg_net), no el navegador, así que el token nunca llega a la página. Si se filtra, en @BotFather use `/revoke` y ponga el nuevo.
- **Importar Excel:** la función `importar_productos` solo funciona para el admin con MFA. Valida cada fila (nombre, precio, enlaces https) y un error no detiene las demás. El Excel se lee en el navegador sin librerías externas.
- **Precios:** la oferta y el agotado se revisan en la base de datos al crear el pedido. Aunque alguien cambie la página, no puede pedir a precio de oferta vencida ni un producto agotado.
- **Envío:** el precio sale de las zonas guardadas en el panel, no de lo que mande el navegador.
- **Factura:** cédula y correo del cliente quedan en `facturas` (solo admin). Para conectar un sistema de facturación se usa la llave secreta **solo en ese servidor** (ver FACTURACION.md).
- **Reportes:** `reporte_ventas` exige admin con MFA.

