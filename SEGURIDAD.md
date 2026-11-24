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
- **Factura:** cédula y correo del cliente quedan en `facturas` (solo admin). La emisión la hace la función `facturar` de Supabase (ver abajo y FACTURACION.md).
- **Reportes:** `reporte_ventas` exige admin con MFA.

## Sin internet (v5)

- **sw.js** solo guarda la página (HTML, estilos, código, letras, íconos) y las fotos públicas de productos. **Nunca** guarda respuestas de la base de datos ni de la sesión.
- La tienda guarda en el teléfono del cliente solo el catálogo público y su propio pedido pendiente.
- El panel guarda en la compu una copia de la lista de ventas y de las últimas 60 ventas abiertas (con nombres y teléfonos de clientes) para verlas sin internet. Se borra al tocar **Salir**. Use el panel solo en compus del almacén.
- Sin internet el panel solo puede anotar ventas nuevas en la compu; no puede cambiar nada en la base de datos. Al volver el internet, las ventas se envían con `registrar_venta_sin_internet`, que exige admin con MFA y revisa cada dato igual que siempre (precios, comprobantes repetidos, fechas). Cada venta lleva un identificador único, así que si el envío se corta y se repite no se duplica.

## Limpieza de fotos (v6)

- Las fotos de comprobantes solo se pueden borrar con la regla `comprobantes_borrar_viejos`: admin con MFA, venta pagada/entregada/anulada y de hace más de 3 meses. Los comprobantes nuevos sin revisar y las ventas abiertas no se pueden borrar.
- Se borra solo la imagen; el pago (monto, comprobante, fecha) queda. Cada borrado se anota en `archivos_borrados` con quién y cuándo.
- Antes de borrar, el panel obliga a descargar el ZIP con las fotos.

## Inventario (v9)

- La tabla `productos` ya no se puede leer completa con la llave pública: la tienda solo puede pedir las columnas que se muestran (nombre, precio, foto, código, etc.). **Existencia y CABYS no salen de la base** hacia la tienda; solo el panel (admin con MFA) las ve.
- `importar_productos` exige admin con MFA, acepta máximo 3 000 filas por llamada y revisa cada dato (código sin espacios y de máximo 40 caracteres, CABYS de 13 dígitos, precios y existencias numéricos). El panel envía de 1 000 en 1 000.
- La importación nunca borra productos ni cambia nombres, fotos o categorías de productos que ya existen.

## Facturación electrónica (v10)

- La **llave criptográfica (.p12)**, su **PIN** y el **usuario/contraseña de Hacienda** viven solo como **secretos de la función** `facturar` en Supabase. No están en el código, en GitHub, en la base ni en el navegador. Para probar en la compu se ponen con `set` en la ventana de CMD, sin archivos; `*.p12` y la carpeta de salida están en `.gitignore`.
- La función solo atiende a un **admin con MFA** (revisa `is_admin()` con el token de quien llama) y solo acepta llamadas desde el dominio del panel (`PANEL_ORIGENES`).
- Escribir comprobantes y reservar consecutivos lo hace **solo la función** con la llave de servicio que Supabase le da por dentro; el panel solo puede **leer** `fe_documentos` y `fe_consecutivos`. Así nadie puede marcar a mano un comprobante como "aceptado".
- Cada comprobante se guarda **firmado antes de enviarlo**. Si el envío falla, se reenvía el mismo XML con la misma clave, sin duplicar ni gastar otro número.
- La numeración de pruebas y la de producción van separadas. Pasar a producción pide confirmación en el panel.

## Historial de precios (v11)

- Cada cambio de precio queda en `precios_movimientos` por un disparador de la base: no importa si se hizo con *Ajuste de precios*, editando el producto o importando el Excel. El panel solo puede **leer** ese historial; nadie lo puede editar ni borrar desde la página.
- `ajustar_precios` exige admin con MFA y acepta máximo 500 productos por vez.

## Inventario (v12)

- La existencia la mueven **disparadores de la base**: las ventas, anulaciones y borrados, y las funciones `registrar_entrada` y `anular_entrada` (admin con MFA, máximo 500 productos por entrada). Cada cambio queda en `inventario_movimientos`, que el panel solo puede **leer**.
- **Costo** y **existencia** no son públicos: la tienda no los puede pedir, porque v9 le dejó solo las columnas públicas de productos.
- Al borrar una venta entera, la devolución se hace una sola vez, aunque los renglones se borren en cascada.

## Crédito (v13)

- `clientes`, `abonos` y los saldos (`v_clientes_credito`) solo los ve el admin con MFA. La tienda no tiene acceso.
- Una venta pasa a crédito solo con `poner_credito()`: revisa que el cliente esté activo y el **límite**, y calcula el vencimiento. Los abonos solo con `registrar_abono()`: no deja abonar más de lo que debe ni repetir un número de comprobante, ni de otro abono ni de otro pago. Anular y verificar abonos también va por funciones.
- Las partes de un abono son pagos normales con `abono_id`, así que siguen todas las reglas de pagos: no se editan, se anulan con motivo y un verificado no se puede desmarcar.

## Caja (v14)

- Abrir, mover efectivo y cerrar la caja solo se hace con `abrir_caja`, `mover_caja` y `cerrar_caja` (admin con MFA). El panel solo puede **leer** `caja_turnos` y `caja_movimientos`.
- Lo que debería haber lo calcula la base (`resumen_caja`) con los pagos del turno, no el navegador. Al cerrar, el resumen y el conteo quedan guardados y ya no cambian.

## Lo más vendido (v15)

- `productos.vendido` (lo vendido según Moriah) **no** se le da a `anon`: la tienda no puede leerlo (las columnas públicas de `productos` se dan una por una desde v9).
- Solo se anota con `anotar_vendido` (admin con MFA), que nada más toca esa columna y solo en productos que ya tienen ese código.
- La pantalla **Productos → Fotos** abre Google en otra pestaña con el nombre del producto (sin datos del panel: el enlace va con `noreferrer`). La foto llega por el portapapeles o como archivo, se re-codifica en el navegador (lo que borra datos EXIF/GPS) y se sube igual que cualquier foto de producto.

## Bitácora, usuarios y ventas (v16)

- `auditoria` guarda quién (nombre en ese momento), qué tabla y registro, el cambio campo por campo (antes → después) y de dónde vino. Solo la escribe el disparador `registrar_auditoria` (security definer); a `authenticated` y `anon` se les quitó insertar, cambiar y borrar.
- Los datos secretos (`telegram_token`, `token`, `password`, `pin`) se anotan como "(oculto)". Los textos largos se recortan a 300 letras.
- Roles en `admins.rol`: `administrador` o `usuario` (los nuevos entran como `usuario`). Solo `es_administrador()` puede `poner_rol_usuario` y siempre queda al menos un administrador. Los nombres y roles se cambian solo con RPC (`admins` sigue sin políticas para la API).
- Ventas: `validar_pedido` no deja borrar una venta directo por la API. Solo `borrar_venta(p_pedido, p_motivo)` (administrador, motivo de 5+ letras), y nunca si tiene pagos, comprobante electrónico o datos de factura. El motivo queda en la bitácora junto con lo que tenía la venta y sus renglones.
- Una venta con tiquete o factura electrónica viva (sin nota de crédito) no se puede anular: primero la nota de crédito.

## Empleados y permisos (v17)

- `is_admin()` ahora exige rol `administrador`, cuenta activa y `aal2` (autenticador). Todas las reglas viejas que usan `is_admin()` quedan solo para el administrador.
- `puede(permiso)`: el administrador, o un empleado activo que tenga ese permiso (y `aal2` si se le marcó "pide código"). Las reglas de las tablas para empleados se **suman** a las del administrador; no se tocaron las de la tienda (anon).
- Las funciones que el panel usa por permiso (caja, abonos, entradas, ajuste de precios, importar, reportes, ventas sin internet) se cambiaron en la base para revisar `puede(...)` en vez de `is_admin()`. Si se vuelve a correr un archivo viejo, hay que correr otra vez v17.
- Disparadores: sin "precios" no se pone ni cambia el precio de un producto ni se vende un producto del catálogo por debajo de su precio (o de la oferta vigente); sin "anular" no se anula una venta ni un pago.
- Solo el administrador: datos del negocio, avisos, facturación (configuración y "probar"), usuarios, bitácora, limpieza de fotos, espacio, respaldo y borrar ventas.
- Cuentas de empleados: las crea la función `usuarios` (Edge Function) con la llave de servicio, que nunca sale de Supabase; antes revisa que quien llama sea administrador con autenticador. El registro en `admins` se hace con la sesión del administrador, así queda en la bitácora. Solo se les cambia la contraseña o el usuario a empleados, nunca a un administrador. Contraseñas de 8+ con letras y números.
- Empleado desactivado: `puede()` y `es_personal()` dan falso al instante aunque su sesión siga abierta.
- La función `facturar` ahora deja emitir a quien tenga "ventas" y hacer notas de crédito a quien tenga "anular"; "probar" sigue siendo solo del administrador.
