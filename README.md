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
15. **SQL Editor → New query** → pegar `supabase/v16_bitacora.sql` → **Run**. Bitácora con nombres y "antes → después", pestaña *Bitácora*, usuarios con rol, y las ventas ya no se borran: se anulan (con nota de crédito si tienen comprobante electrónico). Solo el administrador borra, con motivo.
16. **SQL Editor → New query** → pegar `supabase/v17_permisos.sql` → **Run**. Empleados con usuario y permisos (el administrador les marca qué pueden usar). Después publique la función **`usuarios`** (ver *Usuarios y permisos* más abajo).
17. **SQL Editor → New query** → pegar `supabase/v18_cheque_saldos_apartados.sql` → **Run** (después de v17). Pago con **cheque**, **pasar los saldos de crédito de Moriah** y **apartados**. Ver *Pasar de Moriah: saldos de crédito y apartados* más abajo.
18. **SQL Editor → New query** → pegar `supabase/v19_sin_internet.sql` → **Run** (después de v18). Trabajar **sin internet**: crédito, apartados, abonos, caja y comprobantes electrónicos que se mandan solos al volver la conexión. Ver *Sin internet* más abajo.
18b. **SQL Editor → New query** → pegar `supabase/v20_actividad_caecr.sql` → **Run**. Acepta el código de actividad como lo da TRIBU-CR (ej. `6201.0`).
18c. **SQL Editor → New query** → pegar `supabase/v21_compras_ajustes.sql` → **Run** (después de v20). Salidas y conteos de inventario, compras a crédito y proveedores, facturas recibidas y la lista para dejar Moriah. Si algún día vuelve a correr v12 o v17, corra otra vez v21 al final.
19. *(Cuando se vaya a facturar desde el panel)* **SQL Editor → New query** → pegar `supabase/v10_facturacion.sql` → **Run**, y seguir **FACTURACION.md** (función `facturar` y secretos de Hacienda).
20. **Authentication → Users → Add user** (correo + contraseña de 12+ caracteres, *Auto Confirm*).
21. Registrar al administrador (el dueño):
   ```sql
   insert into public.admins (user_id, rol)
   select id, 'administrador' from auth.users where email = 'correo-del-admin@ejemplo.com'
   on conflict (user_id) do update set rol = excluded.rol;
   ```
   Los empleados ya no se agregan así: el administrador los crea desde el panel (ver *Usuarios y permisos*). (Antes de correr v16 se usa el SQL viejo, sin `rol`.)
22. Ajustes de seguridad del Dashboard: ver **SEGURIDAD.md** (sobre todo **desactivar registros nuevos**).
23. `assets/js/config.js` lleva la **Project URL** y la **Publishable key** (`sb_publishable_…`). **Nunca** la secret / service_role.

## 2. Primer ingreso al panel

`/admin.html` → correo y contraseña → escanear el QR con Google/Microsoft Authenticator → código de 6 dígitos. (Los empleados escriben su **usuario** en vez del correo y, si no se les pide código, entran directo.) Sin ese paso la base de datos no deja modificar nada.

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
| Borrar una venta para esconderla | No se borran: se **anulan** con motivo (con nota de crédito electrónica si tenía tiquete o factura). Solo el **administrador** puede borrar una venta sin pagos ni comprobante electrónico, escribiendo el motivo, y queda en la bitácora con todo lo que tenía |
| No saber quién hizo qué | **Bitácora**: quién, cuándo y qué cambió (antes → después). No se puede editar ni borrar |
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
| Crédito / cuentas por cobrar | **Crédito**: clientes con límite y plazo, ventas a crédito, abonos, estado de cuenta y cobro por WhatsApp. Los saldos que venían de Moriah se pasan con **Pasar saldos de Moriah** |
| Apartados | **Ventas → Apartado**: se guarda la mercadería, el cliente abona y se entrega al terminar de pagar (filtro **Apartados**) |
| Facturas Emitidas | **Comprobantes**: tiquetes, facturas y notas de crédito por fechas, total facturado e IVA, filtro *Con problemas*, enviar de nuevo/consultar, XML y **Descargar en Excel** |

## Cierre de caja

En la pestaña **Caja**, arriba:

1. **Abrir caja** al empezar el día con el **fondo** (el efectivo con que arranca la gaveta). Sugiere lo que se contó en el último cierre.
2. Durante el día, **Entrada o salida de efectivo** para lo que no es una venta: pago a un proveedor, retiro para depositar, cambio que se trae. Cada una con su motivo.
3. El panel va mostrando las ventas del turno, lo recibido en efectivo, SINPE (y cuánto falta verificar), tarjeta, **cheques** (aparte: no se cuentan con el efectivo) y **el efectivo que debería haber**: fondo + efectivo + entradas − salidas. Los abonos de crédito en efectivo también cuentan. Lo *abonado en Moriah* no entra en la caja.
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

## Pasar de Moriah: saldos de crédito y apartados

Necesita `supabase/v18_cheque_saldos_apartados.sql` (después de v17).

**Saldos de crédito (lo que los clientes debían en Moriah).** Solo el administrador.
1. En Moriah, sacar el reporte de **cuentas por cobrar** (el saldo de cada factura, o de cada cliente) y exportarlo a Excel.
2. **Crédito → Pasar saldos de Moriah** → subir el archivo tal cual. Se buscan solas las columnas de cliente, cédula, teléfono, documento, fecha, vencimiento y saldo; se saltan los totales, las facturas en cero y los saldos a favor. Si el reporte viene agrupado por cliente (el nombre arriba y las facturas debajo), también sirve.
3. Revisar la lista (cada fila dice si el cliente es nuevo o si se suma a uno que ya existe) y tocar **Pasar saldos**. También se pueden agregar uno por uno con **Agregar un saldo a mano**.
- Cada saldo queda en la cuenta del cliente como una deuda a crédito, con la fecha y el vencimiento de Moriah (sin vencimiento: fecha + plazo del cliente). Los abonos lo rebajan como a cualquier venta a crédito.
- **No cuenta** como venta del mes, ni en la caja, ni en los reportes, y no se le hace factura electrónica (ya se facturó en Moriah). No sale en la lista de **Ventas**; está en **Crédito**.
- Si se sube el mismo archivo dos veces, lo que ya se pasó **no se repite** (se reconoce por cliente + documento).
- Conviene pasarlos el mismo día que se deja de usar Moriah, con el reporte de ese día.

**Apartados.**
- En la venta, **Apartado** (al lado de Contado y Crédito) y la fecha hasta la que se le guarda (un mes si no se cambia; máximo un año). Pide el teléfono del cliente.
- El cliente va abonando como en cualquier venta (**Registrar un pago**). El panel muestra lo abonado y lo que falta; si se pasa la fecha lo marca en rojo.
- **No se puede entregar** hasta que esté pagado y verificado completo. Al terminar de pagar sale en **Pagadas sin entregar**.
- En **Ventas** está el filtro **Apartados** (con el número de los que ya se pasaron de la fecha) y la cifra de lo que falta cobrar en apartados. El recibo dice hasta cuándo se le guarda.
- Si el cliente se arrepiente: quitarle el apartado (Contado) o anular la venta.
- **Apartados que venían de Moriah:** hacer la venta aquí con los productos, ponerla como apartado y registrar lo que ya había abonado con la forma de pago **Abonado en Moriah** (solo el administrador). Eso rebaja lo que debe pero no entra en la caja de hoy ni en los reportes.

**Cheques.** Forma de pago **Cheque** en ventas y abonos de crédito: pide el número del cheque y queda *por verificar* hasta que el banco lo pague. En la caja sale aparte del efectivo. En la factura electrónica va como medio de pago *cheque*.

## Inventario (existencias)

- **Venta guardada** en el panel, pedido de la página o venta sin internet: baja la existencia de cada producto.
- **Venta anulada o borrada, o producto quitado de una venta:** la existencia vuelve.
- **Inventario → Entrada de mercadería:** cuando llega mercadería del proveedor. Se buscan los productos (sirve el lector; pasar el mismo código dos veces suma 1) y se pone cuántos entran. El costo unitario y el precio de venta nuevo son opcionales. Una entrada mal hecha se **anula** y se resta lo que había sumado.
- **Inventario → Movimientos:** cada subida o bajada con su motivo (venta, anulación, entrada, edición, importación), lo que queda y la referencia (la venta se abre con un clic). Se filtra por producto y fechas. También desde **Productos → Editar → Ver movimientos de inventario**.
- Si la existencia llega a 0, el producto queda **agotado** en la tienda. Si vuelve a haber, deja de estarlo.
- **En una venta no se puede poner más de lo que hay:** el buscador no deja agregar más y la cantidad se corrige sola al máximo. Al guardar se revisa otra vez contra la existencia del momento, por si otra compu vendió. Si el conteo está mal, corríjalo en Productos o registre la entrada de mercadería.
- **Menos de 10:** el panel avisa *“Ya casi no quedan”* al agregarlo y el renglón muestra cuántos quedan después de esa venta (o *“Es lo último que hay”*).
- Los pedidos de la página y las ventas sin internet no se bloquean en la base (para no perder un pedido); la revisión es del panel.
- Solo se lleva existencia de los productos que la tienen: los de Moriah, los que reciben una entrada o los que se cuentan.
- **Inventario → Salida o conteo** (con v21):
  - **Sale mercadería:** dañada o quebrada, perdida o robada, usada en el almacén, vencida o devuelta al proveedor. Se resta de la existencia con su motivo.
  - **Conteo físico:** se escribe lo que hay en el estante y la existencia queda en eso; se ve cuánto faltaba o sobraba y cuánto vale al costo. Sirve también para empezar a llevar existencia de un producto.
  - Se ven en **Inventario → Salidas y conteos**, con sus productos. Uno mal hecho se **anula** y la existencia vuelve a como estaba.
  - Sin v21, el conteo se corrige en **Productos → Editar → Existencia** (queda como "Editado en Productos").

**Mientras se usen Moriah y el panel a la vez:** Moriah no sabe lo que vende el panel, ni el panel lo que vende Moriah. Mientras Moriah sea el principal, importe su Excel con **Actualizar existencias desde el archivo** marcado. El día que el panel pase a ser el principal, haga un conteo, importe una última vez y desde entonces importe con esa casilla **sin marcar**, para no pisar lo que lleva el panel.

## CABYS de los productos

Para facturar, cada producto necesita su **CABYS** (el código de Hacienda que dice qué es y qué IVA lleva).

- **Productos → Sin CABYS:** los que están a la venta y no lo tienen.
- **Productos → Poner CABYS:** va uno por uno, empezando por los más vendidos. Para cada producto muestra:
  - **Parecidos que ya tienen CABYS:** productos del mismo almacén con nombre parecido (útil para la misma familia: láminas, tubos, clavos…).
  - **Buscar en el catálogo de Hacienda:** busca por palabras (*qué es*, no la marca) o por el código de 13 números, con su IVA.
  - Al escoger uno se puede poner **el mismo CABYS a los parecidos** que todavía no tienen (se marcan solos los más parecidos; revíselos).
  - El IVA del producto se pone según el CABYS. Si sale **0 %**, revíselo a mano.
- En **Productos → Editar** también está el campo **CABYS** con **Buscar en Hacienda**.
- **Al facturar una venta:** si algún producto no tiene CABYS, se abre ahí mismo para escogerlo; queda guardado en el producto y la factura sigue sola. (Solo con internet y con permiso de productos; si el empleado no tiene ese permiso, le avisa que se lo pida al administrador.)
- Al importar el Excel de Moriah, el CABYS viene de la columna *Codigo Cabys*; si en Moriah está vacío, queda sin CABYS.

Necesita la función `facturar` publicada otra vez (la búsqueda en Hacienda pasa por ella).

## Paquete del mes para el contador

**Reportes → Paquete del mes para el contador:** se escoge el mes (sale el mes pasado) y baja un ZIP con:

- **`contador-AAAA-MM.xlsx`**, con estas hojas:
  - **Resumen IVA:** ventas por tarifa (base e IVA) de los comprobantes **aceptados** por Hacienda, ya restadas las notas de crédito; compras por tarifa de las facturas de proveedores (sin las rechazadas); IVA acreditable según lo contestado a Hacienda; la resta como referencia; avisos de comprobantes rechazados o sin respuesta, facturas sin contestar y entradas sin factura; cobros del mes por medio de pago.
  - **Ventas:** cada tiquete, factura y nota de crédito del mes, con base e IVA por tarifa, estado en Hacienda y si cuenta o no.
  - **Compras:** cada factura de proveedor con base e IVA por tarifa (leído de su XML), en colones aunque venga en dólares, la respuesta del almacén y el IVA acreditable.
  - **Clientes** y **Proveedores:** totales del mes por cédula (para la declaración informativa).
  - **Entradas sin factura:** mercadería que entró sin factura electrónica (no da crédito de IVA).
  - **Por cobrar**, **Por pagar** e **Inventario** valorizado al costo, al momento de descargar (para el cierre del año, descárguelo el 31 de diciembre).
- **`emitidos/`** y **`recibidos/`**: los XML del mes con las respuestas de Hacienda (se puede desmarcar *Incluir los XML*).

Es una ayuda: el contador revisa y presenta la declaración. Si la facturación está en **Pruebas**, el paquete lo dice.

Para darle acceso al contador: **Usuarios → Agregar** con la plantilla **Contador** (solo el permiso *Reportes*).

## Compras y proveedores (v21)

Pestaña **Compras** (administrador o empleado con permiso *Compras y proveedores*):

- **Entrada de mercadería** (Inventario): ahora se escoge el **proveedor** de la lista (si es nuevo, se agrega solo al guardar) y si se pagó **de contado** o **a crédito**. A crédito se pone el **total de la factura** (con IVA) y el **vencimiento**, que sale solo con los días de crédito del proveedor.
- **Por pagar:** lo que se le debe a cada proveedor, con las facturas vencidas en rojo y las que vencen en 5 días en amarillo. **Pagar** anota el pago (transferencia, SINPE, efectivo, cheque…); si es en efectivo, puede salir de la caja abierta y queda como salida en el cierre. Se puede pagar por partes.
- **Pagos hechos:** todos los pagos; uno mal anotado se **anula** (vuelve a quedar la deuda y, si salió de la caja, el efectivo vuelve a la caja abierta).
- **Proveedores:** nombre, cédula, teléfono, vendedor y días de crédito. Se ve cuánto se le debe a cada uno.
- Una compra con pagos no se puede anular: primero se anulan los pagos.

**Facturas recibidas (las facturas electrónicas de los proveedores):**

1. El proveedor manda al correo dos XML: la factura y la respuesta de Hacienda. En **Compras → Subir factura del proveedor (XML)** se escoge el de la **factura** (se pueden escoger varios). El panel lee el proveedor, el total, el IVA y los productos; si el proveedor no existe, lo crea.
2. **Aceptar o rechazar:** se le contesta a Hacienda (*mensaje de receptor*): **Aceptar**, **Aceptar en parte** (con el motivo) o **Rechazar** (con el motivo). Al aceptar se escoge cómo cuenta el IVA; para mercadería que se vende es *“Da crédito de IVA completo”*. Si tiene dudas, pregúntele al contador. Hace falta la facturación electrónica configurada (no hace falta tener encendido *Facturar desde el panel*).
3. **Hacer la entrada:** arma la entrada de mercadería con los datos de la factura. Cada línea se une con el producto que tenga el **mismo código** (o el mismo CABYS, si solo hay uno); las que no se unen salen en rojo para buscarlas a mano. Una factura solo puede tener una entrada.

## Lista para dejar Moriah (v21)

**Datos del negocio → Lista para dejar Moriah → Revisar ahora.** El panel revisa solo: archivos SQL, administrador y empleados, permisos delicados sin código del celular, datos del negocio, productos sin precio, sin CABYS o sin existencia, saldos de crédito, si ya se cerró una caja, la facturación (emisor, un comprobante aceptado, producción), comprobantes sin terminar, facturas de proveedores sin contestar, compras vencidas y el último respaldo. Lo que no se puede revisar solo (apagar registros nuevos, revocar la llave secreta, impresora, prueba con Marvin, importar Moriah el día del cambio, credenciales de producción, contador) sale como casillas para marcar a mano.

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

## Bitácora y usuarios

- **Pestaña Bitácora:** todo lo que se hace en el panel, del más nuevo al más viejo, por día. Dice **quién** (el nombre del usuario), **qué** (producto, venta, cliente, caja…) y **qué cambió**: "Precio: ₡7 900 → ₡8 200". Si vino de una importación de Excel o de un ajuste de precios, también lo dice.
- Filtros: por persona, por fechas, por tipo (ventas y pagos, **ventas borradas o anuladas**, productos y precios, clientes y crédito, caja e inventario, configuración) y buscador por producto, cliente o motivo.
- Nadie la puede editar ni borrar desde el panel. Va en el respaldo.
- No anota cada cambio de existencia (para eso está *Inventario → Movimientos*) ni los totales que el sistema recalcula solo.
- **Datos del negocio → Usuarios del panel:** el nombre de cada uno (el que sale en la bitácora), con qué entra, el rol y su último ingreso. Solo un **administrador** cambia roles; siempre queda al menos uno.

## Usuarios y permisos (v17)

**Dos tipos de usuario:**
- **Administrador** (el dueño, y usted para soporte): entra con **correo + contraseña + código del autenticador**. Puede todo: datos del negocio, usuarios, bitácora, respaldo, borrar ventas.
- **Empleado** (Marvin, Thomas…): entra con **usuario + contraseña** (por ejemplo `marvin`) y solo ve lo que el administrador le marque. Si se le marca **Pide el código del autenticador**, también tiene que usar la app del celular.

**Lo que se le puede marcar a un empleado:**

| Casilla | Qué puede |
|---|---|
| Ventas y cobros | Hacer ventas, cobrar, verificar SINPE, tiquete/factura electrónica |
| Anular ventas | Anular ventas y pagos (con nota de crédito si hace falta) |
| Caja | Abrir, mover y cerrar la caja |
| Crédito y abonos | Clientes, ventas a crédito, abonos |
| Inventario (entradas) | Entradas de mercadería, salidas y conteos |
| Productos y fotos | Crear y editar productos, categorías y fotos |
| Cambiar precios | Precios en el producto, ajuste de precios, importar el Excel de Moriah (con *Productos*). Sin esta casilla, en una venta no se puede bajar el precio de un producto del catálogo |
| Reportes | Reportes y comprobantes emitidos |
| Preguntas de clientes | Contestar preguntas de la tienda |
| Compras y proveedores | Proveedores, pagos a proveedores y facturas recibidas (aceptar o rechazar ante Hacienda) |

Botones rápidos: **Caja** (ventas, caja y crédito) e **Inventario** (inventario y productos). Todo esto lo revisa la base de datos, no solo el panel: aunque alguien sepa de sistemas, no se puede saltar los permisos. Todo lo que hace cada uno queda en la bitácora con su nombre.

**Puesta en marcha (una sola vez):**
1. Correr `supabase/v17_permisos.sql` (después de v16).
2. Publicar la función **usuarios**: Supabase → **Edge Functions → Deploy a new function → Via Editor** → nombre `usuarios` → pegar todo `supabase/functions/usuarios/index.ts` → **Deploy**. No lleva secretos (Supabase ya le da sus llaves). Si ya existe el secreto `PANEL_ORIGENES` de la facturación, sirve igual.
3. **Don Roberto como administrador:** Supabase → **Authentication → Users → Add user** con **su correo** y una contraseña (*Auto Confirm*), y en el SQL Editor el paso "Registrar al administrador" con su correo. La primera vez que entre, el panel le pide configurar el autenticador en su celular.
4. Don Roberto (o usted) entra al panel → **Datos del negocio → Usuarios del panel → Agregar empleado**: nombre, usuario (minúscula, sin espacios), contraseña (*Inventar contraseña* da una fácil de dictar) y las casillas. Se la da en persona.

**Después:** en la misma pantalla se cambia el nombre, los permisos, la contraseña o el usuario, y se **desactiva** a alguien (ya no puede entrar, pero lo que hizo queda en la bitácora). Si un empleado olvida la contraseña, el administrador le pone otra. El administrador cambia la suya desde Supabase o con "olvidé la contraseña" en su correo.

Por dentro, el usuario `marvin` es la cuenta `marvin@usuarios.lacampina.local` (no recibe correos). Si Supabase no aceptara ese correo al crear empleados, ponga en la función `usuarios` el secreto `DOMINIO_PERSONAL` con un dominio propio y el mismo valor en `assets/js/config.js` (`DOMINIO_PERSONAL`).

**Ventas: anular, no borrar.**
- *Anular venta* pide el motivo y la venta queda marcada como anulada (con lo que tenía). Si tiene pagos, primero se anulan los pagos.
- Si la venta tiene **tiquete o factura electrónica**, al anularla el panel emite primero la **nota de crédito** ante Hacienda y después anula la venta. Si Hacienda todavía no aceptó el comprobante, hay que esperar.
- *Borrar venta* solo le sale al **administrador**, y solo en ventas sin pagos, sin comprobante electrónico y sin datos de factura (por ejemplo, una venta repetida por error). Pide el motivo y queda en la bitácora con todos sus productos.

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
- **Panel:** si se va el internet (aunque el router siga prendido), arriba sale una banda negra y se sigue trabajando. Todo queda en la compu y se **manda solo, en orden**, cuando vuelve la conexión. Con v19:
  - **Ventas nuevas** de contado, **a crédito** (revisa el límite con lo último que se bajó) o **apartadas**, con sus pagos y el recibo impreso (número temporal `SIN-0001`; el código real llega al enviarla).
  - **Comprobante electrónico sin internet** (tiquete o factura) con su clave de 50 dígitos: ver **FACTURACION.md → Sin internet**.
  - En ventas que ya existían (las abiertas se copian solas a la compu cada 10 minutos): **cobrar**, marcar **visto en el banco**, **entregar** y **anular** (si tiene comprobante, la nota de crédito se hace sola al volver la señal).
  - **Abonos** de crédito y marcarlos vistos en el banco. El saldo del cliente se ve con lo pendiente ya rebajado.
  - **Caja:** abrir, entradas y salidas, y **cerrar** con el conteo. Sin internet las cifras son aproximadas (la última copia más lo hecho en la compu); al volver la señal se guardan con la hora real y el cuadre exacto queda en **Cierres anteriores**.
- **Ver pendientes** (en la banda) lista todo lo que falta enviar, con lo que no se pudo enviar en rojo y el motivo: se corrige y se toca **Intentar otra vez**, o se descarta. Nada se repite si un envío se corta a medio camino.
- Lo que sigue necesitando internet: editar productos de una venta ya enviada, pasarla a crédito o apartado, anular pagos o abonos, inventario, productos, reportes, bitácora y usuarios.
- Para abrir el panel sin internet, en esa compu se tuvo que entrar con internet (contraseña + código) en los **últimos 3 días**. Ojo: sin internet no se puede saber si a un empleado lo desactivaron; esa compu lo deja entrar hasta que vuelva la conexión.
- **Salir** borra de la compu la copia de ventas y clientes; lo que falta enviar no se borra.
- **Recomendado:** un celular con datos para compartir internet (hotspot). Si el internet del almacén se cae por mucho tiempo, conecte la compu un rato para que todo se envíe (los comprobantes tienen 2 días hábiles).

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
supabase/          schema.sql, v4_mejoras.sql, productos_iniciales.sql, precios_aproximados.sql, v4_datos.sql, v5_sin_internet.sql, v6_espacio.sql, v7_monto_completo.sql, v8_consultas.sql, v9_inventario.sql, v10_facturacion.sql, v11_precios.sql, v12_inventario.sql, v13_credito.sql, v14_caja.sql, v15_mas_vendidos.sql, v16_bitacora.sql, v17_permisos.sql, v18_cheque_saldos_apartados.sql, v19_sin_internet.sql, v20_actividad_caecr.sql, v21_compras_ajustes.sql
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
