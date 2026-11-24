# Almacén La Campiña — tienda en línea con pedidos y control de pagos SINPE

Sitio estático en **GitHub Pages** con base de datos en **Supabase** (plan gratis).

- **Tienda** (`index.html`): catálogo con fotos, filtros, ofertas con fecha, productos agotados, **calculadora de láminas** (techo y PVC), carrito con **envío a domicilio por zonas** y **solicitud de factura electrónica**, pedido con código y comprobante SINPE opcional.
- **Mi pedido** (`pedido.html`): el cliente ve su pedido con **código + teléfono** (sin crear cuenta), si ya está **listo**, la entrega, la factura, y sube el comprobante.
- **Panel** (`admin.html`): pedidos y ventas, comprobantes, caja SINPE, **reportes**, productos (con **importar/descargar Excel**, agotado y ofertas), categorías y datos del negocio (envío, **avisos por Telegram**). Entra con contraseña + código del celular (MFA). Se instala como app en el celular.

En línea: https://johancubillo.github.io/almacen-la-campina/

---

## 1. Supabase

1. **SQL Editor → New query** → pegar `supabase/schema.sql` → **Run**. **Solo la primera vez** (con la base vacía): después de v4 ya no se vuelve a correr.
2. **SQL Editor → New query** → pegar `supabase/v4_mejoras.sql` → **Run**. Agrega agotado, ofertas, envío, factura, avisos, Excel y reportes. **Siempre después de `schema.sql`** (si vuelve a correr `schema.sql`, corra también este).
3. **SQL Editor → New query** → pegar `supabase/productos_iniciales.sql` → **Run**. Carga los productos con fotos de su Facebook y oculta los de ejemplo. (`precios_aproximados.sql` llena los precios que falten.)
4. **SQL Editor → New query** → pegar `supabase/v4_datos.sql` → **Run**. Activa el envío con los barrios de Cariari y su precio aproximado (se cambian en Datos del negocio).
5. **SQL Editor → New query** → pegar `supabase/v5_sin_internet.sql` → **Run**. Permite enviar las ventas hechas sin internet sin que se dupliquen.
6. **SQL Editor → New query** → pegar `supabase/v6_espacio.sql` → **Run**. Muestra el espacio usado y permite limpiar fotos de comprobantes viejos.
7. **SQL Editor → New query** → pegar `supabase/v7_monto_completo.sql` → **Run**. El cliente ya no escribe el monto: el comprobante queda por el saldo completo del pedido.
8. **SQL Editor → New query** → pegar `supabase/v8_consultas.sql` → **Run**. Activa el formulario de preguntas y la pestaña *Preguntas* del panel.
9. **SQL Editor → New query** → pegar `supabase/v9_inventario.sql` → **Run**. Agrega código, existencia y CABYS a los productos y permite importar el inventario de Moriah.
10. **SQL Editor → New query** → pegar `supabase/v11_precios.sql` → **Run**. Activa *Ajuste de precios* (varios a la vez, con documento y observación) y el historial *Movimientos* de cada cambio de precio.
11. **SQL Editor → New query** → pegar `supabase/v12_inventario.sql` → **Run**. Las ventas bajan la existencia, las anulaciones la devuelven, y activa la pestaña *Inventario* (entradas de mercadería y movimientos).
12. **SQL Editor → New query** → pegar `supabase/v13_credito.sql` → **Run**. Activa la pestaña *Crédito* (clientes, límite, plazo, abonos y estado de cuenta) y la opción *Crédito* en las ventas.
13. **SQL Editor → New query** → pegar `supabase/v14_caja.sql` → **Run**. Activa abrir y cerrar caja (fondo, entradas y salidas de efectivo, conteo y cierre impreso) en la pestaña *Caja*.
14. **SQL Editor → New query** → pegar `supabase/v15_mas_vendidos.sql` → **Run**. Anota lo que más se vende al importar el inventario de Moriah, para ponerle foto primero a eso (**Productos → Fotos**). Correrlo **antes** de importar el Excel de Moriah.
15. *(Cuando se vaya a facturar desde el panel)* **SQL Editor → New query** → pegar `supabase/v10_facturacion.sql` → **Run**, y seguir **FACTURACION.md** (función `facturar` y secretos de Hacienda).
16. **Authentication → Users → Add user** (correo + contraseña de 12+ caracteres, *Auto Confirm*).
17. Registrar al administrador:
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'correo-del-admin@ejemplo.com'
   on conflict do nothing;
   ```
18. Ajustes de seguridad del Dashboard: ver **SEGURIDAD.md** (sobre todo **desactivar registros nuevos**).
19. `assets/js/config.js` lleva la **Project URL** y la **Publishable key** (`sb_publishable_…`). **Nunca** la secret / service_role.

## 2. Primer ingreso al panel

`/admin.html` → correo y contraseña → escanear el QR con Google/Microsoft Authenticator → código de 6 dígitos. Sin ese paso la base de datos no deja modificar nada.

En **Datos del negocio**: número **SINPE Móvil** y titular, horario por día, teléfonos, **zonas de envío** (una por línea: `Cariari centro = 2000`) y **avisos por Telegram** (token de @BotFather + su Id de @userinfobot → *Enviar prueba*).

---

## Cómo compra un cliente

```
Tienda: Agregar productos al carrito  ─►  Enviar pedido (nombre + teléfono)
          │                                   │  (opcional) adjuntar comprobante SINPE
          ▼                                   ▼
   Recibe un CÓDIGO (ej. LC7K2QFM)   ──►  El pedido entra al panel en "Nuevos"
          │
          ▼
   "Mi pedido" (código + teléfono): ve el estado, cómo pagar y sube el comprobante después
   Botón "Enviar comprobante por WhatsApp": abre el menú de compartir del celular con la foto
```

- Los **precios los pone la base de datos** con el catálogo: aunque alguien manipule la página, no puede cambiar precios.
- Productos con "precio a consultar" o escritos a mano entran en ₡0: el admin les pone precio y manda el cobro por WhatsApp.
- La **oferta** se cobra solo hasta su fecha (la base de datos lo revisa). Un producto **agotado** no se puede pedir.
- El **envío** entra como un renglón más con el precio de la zona (el admin lo puede cambiar).
- Con avisos encendidos, cada pedido nuevo y cada comprobante subido llega a Telegram con el código y el enlace al panel.

## Control de ventas y SINPE (panel)

1. **Pedidos y ventas → Nuevos**: pedidos web recién llegados y comprobantes nuevos.
2. Abrir el pedido → completar precios → **Enviar cobro por WhatsApp** (total + SINPE + "en el detalle escriba LC…").
3. **Comprobantes enviados por el cliente** → *Ver comprobante* → **Registrar como pago** (copiar el Nº de referencia de la imagen) o **Rechazar** con motivo (el cliente lo ve en "Mi pedido").
4. El pago queda **Por verificar** hasta que lo vea en la app del banco → **Ya lo vi en el banco** → venta **Pagada** → entregar.
5. **Avisar que está listo**: abre WhatsApp con el mensaje para el cliente y en "Mi pedido" le sale *listo para recoger*.
6. **Factura electrónica**: el panel emite tiquetes, facturas y notas de crédito con Hacienda. Ver **FACTURACION.md**.
7. **Imprimir recibo**: escoja el papel (térmica 80 mm, 58 mm u hoja carta; queda guardado) y se abre la ventana de imprimir. Sirve con cualquier impresora instalada en la compu o el celular. Si la venta ya tiene **tiquete o factura electrónica**, el recibo lo trae: tipo, número, consecutivo, clave, IVA incluido, condición (contado o crédito) y cómo va con Hacienda, más la cédula del negocio arriba (si está en pruebas lo dice abajo). Si es **a crédito**, trae el cliente, la fecha de vencimiento, el saldo total de su cuenta en ese momento y una línea para que firme. Sin comprobante electrónico dice que es un comprobante de venta, no la factura de Hacienda.

**Productos en Excel:** *Descargar en Excel* → editar → *Importar de Excel* (actualiza por nombre, crea lo nuevo y las categorías que falten; muestra antes qué va a pasar con cada fila). También acepta CSV.

**Reportes:** vendido, cobrado, venta promedio, pedidos por la página, ventas de los últimos 12 meses, lo que más se vende y cómo pagan.

| Riesgo | Cómo se controla |
|---|---|
| Mismo comprobante usado dos veces | Nº de comprobante único; avisa en qué venta ya se usó |
| Captura falsa o editada | "Pagada" solo con pagos marcados **Ya lo vi en el banco** (queda quién y cuándo) |
| Cambiar o borrar pagos | No se editan ni se borran: se anulan con motivo |
| Bajar precios después de cobrar | Productos de la venta congelados con pagos verificados |
| Cliente adivinando pedidos ajenos | Código de 8 caracteres + teléfono; máx. 5 intentos fallidos por código cada 15 min |
| Spam de pedidos o archivos | Máx. 3 pedidos por teléfono cada 15 min; subidas solo a rutas autorizadas, 5 por pedido al día, 5 MB |
| Comprobantes expuestos | Bucket privado; solo el admin los ve con enlaces de 2 minutos |

## Usar el panel como programa (en la compu del almacén)

1. En la compu del almacén, abrir el panel en **Chrome** o **Edge**: `https://johancubillo.github.io/almacen-la-campina/admin.html`.
2. Entrar con el usuario del almacén y tocar **Instalar como programa** (arriba, junto al correo). Si no aparece el botón, usar el ícono de instalar en la barra de direcciones (o menú ⋮ → *Instalar La Campiña*).
3. Queda como un programa más: ícono en el escritorio y en el menú Inicio, ventana propia sin barra del navegador. Clic derecho sobre el ícono de la barra de tareas → **Anclar**.
4. Clic derecho sobre el ícono también trae accesos directos: **Nueva venta**, **Productos** y **Caja SINPE**.

- Abre aunque no haya internet (igual que el panel en el navegador: ventas sin internet que se envían solas al volver).
- Se actualiza solo: cuando se publican cambios, la próxima vez que se abre ya trae la versión nueva. No hay que reinstalar.
- Los datos siguen en Supabase, así que la tienda web, los respaldos y otras compus ven lo mismo.

**Imprimir sin la ventana de impresión (opcional, para la caja):** crear un acceso directo en el escritorio con este destino y usarlo para abrir el panel. Imprime directo en la impresora predeterminada de Windows. Solo funciona si Edge no estaba abierto antes.

```
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=https://johancubillo.github.io/almacen-la-campina/admin.html --kiosk-printing
```

## Pantallas que reemplazan a Moriah

| En Moriah | En el panel |
|---|---|
| Consulta Producto | **Productos**: buscador por nombre o código (sirve el lector de barras), con precio y existencia |
| Categorizar | **Categorías** (los productos de Moriah traen la categoría puesta según el nombre) |
| Ajuste de Precios + Movimientos | **Productos → Ajuste de precios**: se buscan productos, se pone el precio nuevo o un % para todos (redondea a ₡5), N.º de documento y observación. **Movimientos** muestra cada cambio de precio con el anterior, el nuevo y de dónde vino (ajuste, editar producto o importación) |
| Entradas de mercadería / inventario | **Inventario**: entradas del proveedor (con costo y precio de venta opcionales) y **Movimientos** de existencia por producto y fechas |
| Cierre de caja | **Caja**: abrir con fondo, entradas/salidas de efectivo, conteo por billetes y monedas, cierre impreso |
| Crédito / cuentas por cobrar | **Crédito**: clientes con límite y plazo, ventas a crédito, abonos, estado de cuenta y cobro por WhatsApp |
| Facturas Emitidas | **Comprobantes**: tiquetes, facturas y notas de crédito por fechas, total facturado e IVA, filtro *Con problemas*, enviar de nuevo/consultar, XML y **Descargar en Excel** |

## Cierre de caja

En la pestaña **Caja**, arriba:

1. **Abrir caja** al empezar el día con el **fondo** (el efectivo con que arranca la gaveta). Sugiere lo que se contó en el último cierre.
2. Durante el día, **Entrada o salida de efectivo** para lo que no es una venta: pago a un proveedor, retiro para depositar, cambio que se trae. Cada una con su motivo.
3. El panel va mostrando las ventas del turno, lo recibido en efectivo, SINPE (y cuánto falta verificar), tarjeta y **el efectivo que debería haber**: fondo + efectivo + entradas − salidas. Los abonos de crédito en efectivo también cuentan.
4. **Cerrar caja:** se cuentan los billetes y monedas (o se escribe el total) y el panel dice si **cuadra, sobra o falta**. Avisa si quedan SINPE sin verificar y recuerda comparar la tarjeta con el cierre del datáfono.
5. Al cerrar, el resumen queda **congelado** (no cambia aunque después se registre algo) y se puede **imprimir** en el mismo papel de los recibos, con línea para firma. En **Cierres anteriores** están los últimos con su sobrante o faltante, y se pueden volver a imprimir.

Solo puede haber una caja abierta. Abrir y cerrar necesita internet.

## Crédito a clientes

- **Crédito → Nuevo cliente:** nombre, teléfono, cédula (opcional), **límite** (vacío = sin límite) y **plazo** en días (30 si no se cambia). Se puede desactivar el crédito de un cliente sin borrarlo.
- **Venta a crédito:** en la venta, **Crédito** y escoger el cliente (por nombre, cédula o teléfono). El panel muestra cuánto debe, el límite y cuándo vence esa venta (fecha de la venta + plazo). **No deja guardar si pasa el límite** y avisa si el cliente tiene algo vencido. La base lo revisa otra vez al guardar.
- **Abonos:** en el cliente, **Registrar abono**. Se reparte solo: primero se paga la venta que vence primero. Cada parte queda como un pago de esa venta, así el saldo, la Caja SINPE y los reportes funcionan igual. Si es SINPE pide el comprobante y queda *Por verificar* hasta tocar **Ya lo vi en el banco**. Un abono mal registrado se **anula** y vuelve a quedar como deuda.
- **Estado de cuenta:** ventas pendientes con saldo y vencimiento (en rojo las vencidas, en amarillo las que vencen en 5 días o menos). **Cobrar por WhatsApp** manda el saldo, el detalle y el número SINPE.
- La pestaña **Crédito** muestra lo que hay por cobrar, lo vencido y cuántos clientes están atrasados (número en la pestaña).
- Con la facturación electrónica encendida, el tiquete o la factura de una venta a crédito sale con condición *crédito* y el plazo hasta el vencimiento.
- Las ventas a crédito necesitan internet. Sin internet se puede vender de contado como siempre.

## Inventario (existencias)

- **Venta guardada** en el panel, pedido de la página o venta sin internet: baja la existencia de cada producto.
- **Venta anulada o borrada, o producto quitado de una venta:** la existencia vuelve.
- **Inventario → Entrada de mercadería:** cuando llega mercadería del proveedor. Se buscan los productos (sirve el lector; pasar el mismo código dos veces suma 1) y se pone cuántos entran. El costo unitario y el precio de venta nuevo son opcionales. Una entrada mal hecha se **anula** y se resta lo que había sumado.
- **Inventario → Movimientos:** cada subida o bajada con su motivo (venta, anulación, entrada, edición, importación), lo que queda y la referencia (la venta se abre con un clic). Se filtra por producto y fechas. También desde **Productos → Editar → Ver movimientos de inventario**.
- Si la existencia llega a 0, el producto queda **agotado** en la tienda. Si vuelve a haber, deja de estarlo.
- **En una venta no se puede poner más de lo que hay:** el buscador no deja agregar más y la cantidad se corrige sola al máximo. Al guardar se revisa otra vez contra la existencia del momento, por si otra compu vendió. Si el conteo está mal, corríjalo en Productos o registre la entrada de mercadería.
- **Menos de 10:** el panel avisa *“Ya casi no quedan”* al agregarlo y el renglón muestra cuántos quedan después de esa venta (o *“Es lo último que hay”*).
- Los pedidos de la página y las ventas sin internet no se bloquean en la base (para no perder un pedido); la revisión es del panel.
- Solo se lleva existencia de los productos que la tienen: los de Moriah o los que reciben una entrada. Para corregir un conteo físico, en **Productos → Editar → Existencia**; queda en Movimientos como "Editado en Productos".

**Mientras se usen Moriah y el panel a la vez:** Moriah no sabe lo que vende el panel, ni el panel lo que vende Moriah. Mientras Moriah sea el principal, importe su Excel con **Actualizar existencias desde el archivo** marcado. El día que el panel pase a ser el principal, haga un conteo, importe una última vez y desde entonces importe con esa casilla **sin marcar**, para no pisar lo que lleva el panel.

## Inventario desde Moriah

0. **Solo la primera vez:** a los productos que ya están en la página con foto, ponerles el código que tienen en Moriah (**Productos → Editar → Código**). Así la importación los actualiza en vez de crear otro igual sin foto. Si ya se importó y quedó repetido: borrar el que vino de Moriah y poner su código en el que tiene foto.
1. En Moriah, exportar el inventario a Excel (el archivo trae *Tip-Cod*, *Codigo*, *Codigo Cabys*, el nombre, *Unidad*, *Precio* y *Exist 1*).
2. Panel → **Productos → Importar de Excel** → escoger ese archivo tal cual, sin arreglarlo. El panel lo reconoce solo y muestra una vista previa antes de importar.
3. **Productos nuevos:** se crean con su código, precio y existencia. Como Moriah no usa categorías, se les pone una según el nombre (Electricidad, Fontanería, Pesca…). Se puede cambiar después en cada producto.
4. **Productos que ya existen** (mismo código): se actualizan precio, existencia y agotado. No se tocan el nombre, la foto, la descripción, la categoría ni si se muestra o no en la tienda: lo que se arregló en el panel se respeta.
5. Existencia 0 o menos → **agotado** (se ve en la tienda, pero al final y marcado). Precio 0 → **a consultar**.
6. Se salta: productos con "(prueba)" en el nombre y códigos repetidos dentro del archivo.
7. Con `v15_mas_vendidos.sql` corrido, también se anota lo vendido de cada producto (columna *Monto V*). No se publica: solo sirve para ordenar en el panel.

Para tener precios y existencias al día, repetir la importación cada semana (o cuando cambien precios en Moriah). La existencia **no** se publica en la tienda: solo la ve el panel.

Con miles de productos, la tienda muestra 48 a la vez con **Ver más productos**, y el buscador encuentra por nombre o por código de barras. En una venta del panel, el producto se agrega escribiendo parte del nombre o el código (sirve el lector de código de barras: lee y da Enter).

## Preguntas de clientes

En la tienda, la sección **¿Tiene una pregunta?** (y el enlace *Dejar una pregunta sobre este producto* en cada ficha) guarda nombre, teléfono, asunto y la pregunta. Llegan a la pestaña **Preguntas** del panel y, si están encendidos, por Telegram. **Responder por WhatsApp** abre el chat del cliente con su pregunta y la marca como respondida. Freno de spam: 5 preguntas por teléfono al día y 30 en total cada 10 minutos.

## Respaldo

**Datos del negocio → Respaldo en esta compu → Descargar respaldo.** Baja un ZIP con todas las tablas (cada una en CSV para Excel, y `respaldo.json` con todo junto) y, si se marca la casilla, las fotos de comprobantes y productos. No incluye contraseñas ni el token de Telegram. Hacerlo al menos una vez al mes y guardar una copia fuera de la compu (USB o Drive). El panel avisa cuando ya pasaron 30 días.

## Fotos de los productos (buscar en Google y pegar)

**Productos → Fotos** muestra los productos sin foto, empezando por los **más vendidos** (necesita `v15_mas_vendidos.sql` y haber importado el inventario de Moriah). Arriba dice cuántos de los 150 más vendidos ya tienen foto.

1. En el producto marcado (borde amarillo), **Buscar en Google**: abre otra pestaña con fotos de ese producto.
2. Abrir la foto que sirva y, sobre la **foto grande**, clic derecho → **Copiar imagen**. (Copiarla desde la cuadrícula da una foto chica; el panel avisa si pasa.)
3. Volver al panel y **Ctrl + V**. La foto se sube y queda marcado el siguiente, sin esperar a que termine.

Si la foto es de catálogo (fondo blanco), el panel le quita los bordes y la centra en un cuadro blanco, para que todas se vean parejas en la tienda. Una foto tomada en el almacén se deja como viene. Para cambiar una foto: tocar el producto y pegar otra. También se puede escoger un **Archivo** de la compu o arrastrarlo encima.

Ojo: las fotos de Google son de otros (fábricas y tiendas). Mejor usar las de la marca del producto, no las de otra ferretería, y con el tiempo cambiarlas por fotos propias.

## Espacio de fotos

- Las fotos no van en la base de datos sino en el almacenamiento de archivos (1 GB en el plan gratis). Cada comprobante se achica antes de subirse (1200 px, WebP): pesa unos 100–150 KB.
- **Fotos de productos:** el panel las sube en dos tamaños, 800 px para la ficha del producto y 400 px para las listas (tienda y panel), en WebP. Juntas pesan unos 60–120 KB, así la tienda carga rápido con datos móviles y caben miles de productos con foto. Al cambiar o borrar la foto se borran las dos. Las fotos subidas antes siguen sirviendo igual (un solo tamaño); si se quieren más livianas, basta con volver a subirlas.
- **Datos del negocio → Espacio de fotos** muestra cuánto se ha usado; se pone rojo al pasar del 80 %.
- **Limpiar comprobantes viejos:** escoja de hace cuántos meses → *Buscar fotos viejas* → **1. Descargar ZIP** (guárdelo) → **2. Borrar del sistema**. Solo se pueden borrar fotos de ventas ya pagadas, entregadas o anuladas de hace más de 3 meses; el pago queda registrado con monto, número de comprobante y fecha.

## Sin internet

- **Tienda:** la página y el catálogo abren aunque no haya señal (con los precios de la última visita). Si el cliente envía el pedido sin internet, queda guardado en su teléfono y se manda solo cuando vuelve la conexión; ahí recibe su código.
- **Panel:** si se va el internet se pueden hacer **ventas nuevas**, anotarles pagos e **imprimir el recibo** (sale con un número temporal `SIN-0001`). Quedan en la lista como *Por enviar* y se mandan solas cuando vuelve la conexión, cada una con su código real. Si una no se puede enviar (por ejemplo, un comprobante repetido) queda marcada en rojo para corregirla.
- Las ventas que ya existían se pueden **ver** sin internet (las que se abrieron antes en esa compu), pero no cambiar. Verificar pagos, anular, entregar, productos y reportes necesitan internet.
- Para abrir el panel sin internet, en esa compu se tuvo que entrar con internet (contraseña + código) en las últimas 12 horas. Para mandar las ventas guardadas hay que volver a entrar con internet.
- **Salir** borra de la compu la copia de ventas y clientes; las ventas sin enviar no se borran.

**Rutina diaria:** Caja SINPE → comparar el total con la app del banco → verificar uno por uno → no entregar lo que esté *Por verificar*. Fin de mes: **Descargar mes (CSV)**.

---

## Publicar cambios (Windows CMD)
```cmd
git clone https://github.com/JohanCubillo/almacen-la-campina.git
cd almacen-la-campina
git add .
git commit -m "cambio"
git push
```
GitHub Pages actualiza en 1–2 minutos. Probar local: `python -m http.server 8080`.

**Cuando el dueño apruebe el sitio:** quitar en `index.html` la línea `<meta name="robots" content="noindex, nofollow" />`.

## Estructura
```
index.html, pedido.html, admin.html
assets/css/        styles.css (tienda), pedido.css, admin.css
assets/js/         config.js (URL + publishable key, utilidades), app.js, pedido.js, admin.js, xlsx-mini.js (Excel sin librerías)
assets/productos/  fotos de productos (WebP 800×800)
assets/vendor/     supabase-js 2.119.2 (local, sin CDN)
assets/fonts/      Barlow / Barlow Condensed (OFL)
assets/img/        logo, íconos de la app, og.jpg (imagen para compartir)
supabase/          schema.sql, v4_mejoras.sql, productos_iniciales.sql, precios_aproximados.sql, v4_datos.sql, v5_sin_internet.sql, v6_espacio.sql, v7_monto_completo.sql, v8_consultas.sql, v9_inventario.sql, v10_facturacion.sql, v11_precios.sql, v12_inventario.sql, v13_credito.sql, v14_caja.sql, v15_mas_vendidos.sql
supabase/functions/facturar/   función que firma y envía los comprobantes a Hacienda
herramientas/      prueba de facturación en la compu (prueba-hacienda.mjs)
sw.js              copia de la página para abrirla sin internet
panel.webmanifest  app instalable del panel
SEGURIDAD.md, FACTURACION.md, GOOGLE-Y-DOMINIO.md
```

## Pendiente con el dueño
- Confirmar precios de las láminas (vienen de anuncios, + IVA) y poner precio a los demás.
- Número SINPE, titular y horario.
- Logo original en buena resolución.
- Aprobación del sitio → quitar `noindex` (ver **GOOGLE-Y-DOMINIO.md**).
- Zonas y precios de envío, y si quiere avisos por Telegram.
- Medidas reales de las láminas que vende (largo y ancho útil) para afinar la calculadora.
