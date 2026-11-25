# Facturación electrónica (Hacienda 4.4)

El panel emite **tiquetes**, **facturas** y **notas de crédito** directamente con Hacienda. El trabajo se reparte así:

- **Panel (admin.html):** botones en cada venta y los datos del emisor en *Datos del negocio*.
- **Función de Supabase `facturar`** (`supabase/functions/facturar/`): arma el XML 4.4, lo valida, lo firma con la llave criptográfica, lo envía a Hacienda y guarda la respuesta. Solo la puede usar un administrador con verificación en 2 pasos.
- **Base de datos:** guarda cada comprobante con su XML firmado y la respuesta de Hacienda en `fe_documentos`, y lleva la numeración en `fe_consecutivos`.

La parte técnica de Hacienda (XML, firma XAdES-EPES, token y envío) la hace [`@dojocoding/hacienda-sdk`](https://github.com/DojoCodingLabs/hacienda-cr). Es código abierto con licencia MIT y no cobra nada. Está fijada la versión **0.13.0**; solo se cambia cuando Hacienda cambie algo y después de probar.

> **La llave criptográfica (.p12), su PIN y el usuario y la contraseña de Hacienda no van en el código, en GitHub, en la base de datos ni en un chat.** Se guardan solo como **secretos de la función** en Supabase.

---

## 1. Lo que hay que sacar en TRIBU-CR

Se hace en https://ovitribucr.hacienda.go.cr con el usuario **del dueño del almacén**. Hacienda solo da credenciales, incluso las de pruebas, a quien está inscrito con una actividad económica. El ambiente de pruebas puede tardar en reconocer una inscripción nueva: mientras tanto rechaza con "condición diferente a Inscrito", "provincia, cantón y distrito no concuerdan" y "actividad no registrada" aunque la consulta pública ya diga *Inscrito*. Para el ambiente de pruebas está la opción *“Necesito un usuario de pruebas”* (en *Mi perfil → Credenciales pruebas*), que da su propio usuario, contraseña y llave. Hay dos juegos de credenciales:

| | Pruebas (*sandbox*) | Producción |
|---|---|---|
| Usuario de comprobantes | `…@stag.comprobanteselectronicos.go.cr` | `…@prod.comprobanteselectronicos.go.cr` |
| Contraseña de ese usuario | sí | sí |
| Llave criptográfica (.p12) y su PIN | la de pruebas | la de producción |

Primero se trabaja **solo con las de pruebas**.

También hacen falta estos datos del almacén, tal como están inscritos en Hacienda:

- Cédula y nombre o razón social.
- Código de actividad económica **tal como sale en la consulta pública de TRIBU-CR**, con el punto (ej. `6201.0`). Con el catálogo nuevo (CAECR) Hacienda rechaza el formato viejo de 6 dígitos sin punto. Necesita `v20_actividad_caecr.sql`.
- Provincia, cantón y distrito.
- Dirección y correo.

## 2. Probar en la compu (antes de tocar Supabase)

Hace lo mismo que la función: arma un tiquete, lo valida contra el esquema 4.4, lo firma y lo envía al ambiente de **pruebas**. Si aquí sale *ACEPTADO*, la función también sirve.

Requisitos: **Node 22.18 o más nuevo**. En la carpeta del repo, en CMD:

```bat
npm install
copy herramientas\prueba-emisor.ejemplo.json herramientas\prueba-emisor.json
notepad herramientas\prueba-emisor.json
```

En `prueba-emisor.json` ponga los datos del almacén. En `proveedor_sistemas` va la cédula de quien da el sistema (Johan). Este archivo no se sube a GitHub. Después, **en la misma ventana de CMD**:

```bat
set HACIENDA_USUARIO=cpj-3-101-xxxxxx@stag.comprobanteselectronicos.go.cr
set HACIENDA_CLAVE=contraseña-de-pruebas
set HACIENDA_P12=C:\ruta\llave-de-pruebas.p12
set HACIENDA_PIN=1234

node herramientas\prueba-hacienda.mjs
node herramientas\prueba-hacienda.mjs --enviar
node herramientas\prueba-hacienda.mjs --enviar --factura
node herramientas\prueba-hacienda.mjs --enviar --anular
```

- **Primer comando:** arma, valida y firma; no envía nada.
- **`--enviar`:** además lo manda a PRUEBAS y espera la respuesta.
- **`--enviar --factura`:** lo mismo, pero con una factura; usa el `receptor` del json.
- **`--enviar --anular`:** emite un tiquete y después una nota de crédito que lo anula.

**Sin credenciales todavía:** si no pone `HACIENDA_P12`, el script arma un tiquete y una nota de crédito y los revisa contra el esquema 4.4, sin firmar ni enviar. Para eso solo hace falta `prueba-emisor.json`.

Los XML (sin firmar, firmado y la respuesta de Hacienda) quedan en `herramientas\salida\`. Esa carpeta tampoco se sube a GitHub. Cuando termine, cierre la ventana de CMD para que se borren las variables.

## 3. Base de datos

En Supabase, abra **SQL Editor**, pegue `supabase/v10_facturacion.sql` y dele **Run**. Hace falta que `v9_inventario.sql` ya esté corrido, porque los productos necesitan el **CABYS** que trae el inventario de Moriah.

## 4. Publicar la función `facturar`

Con la terminal, en la carpeta del repo. Se usa `npx`, así que no hay que instalar nada:

```bat
npx supabase login
npx supabase functions deploy facturar --project-ref osuhkkojtwweepniwxtp --use-api
```

## 5. Poner los secretos

Primero pase la llave .p12 a texto (base64). En **PowerShell**:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\ruta\llave-de-pruebas.p12")) | Set-Clipboard
```

Eso deja el texto copiado. Después, en Supabase: **Edge Functions → Secrets**. Agregue:

| Nombre | Valor |
|---|---|
| `HACIENDA_USUARIO` | el usuario de comprobantes (pruebas) |
| `HACIENDA_CLAVE` | su contraseña |
| `HACIENDA_P12_BASE64` | pegar el texto copiado |
| `HACIENDA_PIN` | el PIN de la llave |
| `PANEL_ORIGENES` | `https://johancubillo.github.io` (si después hay dominio propio, agréguelo separado por coma) |

Los secretos también se pueden poner con `npx supabase secrets set NOMBRE=valor --project-ref osuhkkojtwweepniwxtp`.

> Desde v17, la función también la pueden usar los empleados: emitir con el permiso "Ventas y cobros" y hacer notas de crédito con "Anular ventas". Si la función ya estaba publicada antes de ese cambio, vuelva a publicarla con el `index.ts` nuevo.

> Desde v20 el código de actividad va con punto (`6201.0`). Corra `v20_actividad_caecr.sql` y vuelva a publicar la función con el `comprobante.ts` nuevo.

> Desde v19 la función también firma y manda los **comprobantes hechos sin internet** (ver *Sin internet* más abajo). Vuelva a publicarla con el `index.ts` y el `comprobante.ts` nuevos después de correr `v19_sin_internet.sql`.

> Desde v18, un pago con **cheque** sale en el comprobante como medio de pago 03 (cheque). Si la función ya estaba publicada, vuelva a publicarla con el `comprobante.ts` nuevo; mientras tanto el cheque sale como "otro medio de pago". Lo *abonado en Moriah* también sale como "otro medio de pago". Los saldos pasados de Moriah no se facturan (ya se facturaron allá).

## 6. Encender en el panel

1. **Datos del negocio → Facturación electrónica:** llene los datos del emisor. Mientras Moriah siga facturando, use **otra terminal**, por ejemplo `00002`, para que los consecutivos no choquen. Si hace envíos a domicilio, ponga el **CABYS del envío**.
2. **Probar conexión con Hacienda.** Abre la llave y entra a Hacienda sin enviar nada.
3. Marque **Facturar desde el panel** con el ambiente en **Pruebas** y guarde.
4. Abra una venta y toque **Emitir tiquete**. Para factura, primero **El cliente pide factura** con los datos del cliente y después **Emitir factura**.

## 7. Pasar a producción

1. Cambie los 4 secretos por los de **producción**: usuario `@prod`, su contraseña, la llave de producción y su PIN.
2. En el panel cambie el ambiente a **Producción** y guarde. El panel pide confirmación.
3. Toque **Probar conexión con Hacienda**.

La numeración de pruebas y la de producción van aparte, así que lo que se hizo en pruebas no gasta números reales.

---

## Cómo funciona cada comprobante

- **Precios:** se toman como **precio final con IVA**, que es como se cobra en el almacén. Para el XML se separa la base y el impuesto. Los productos que digan *"+ IVA"* en *Se vende por* hay que corregirlos antes de facturar: ponerles el precio con IVA y quitar el "+ IVA".
- **IVA de cada producto:** por defecto 13 %. Se cambia en **Productos → Editar → IVA del producto**, por ejemplo al 1 % de insumos agropecuarios. Si hay duda, que la confirme el contador.
- **CABYS:** cada renglón tiene que venir de un producto con CABYS. Los del inventario de Moriah ya lo traen. Un *renglón libre* no se puede facturar, salvo el envío a domicilio.
- **Ventas a crédito** (pestaña Crédito, v13): el comprobante sale con condición 02 y el plazo en días hasta el vencimiento de la venta, sin medio de pago.
- **Medio de pago:** sale de los pagos anotados en la venta: SINPE Móvil 06, efectivo 01, tarjeta 02, cheque 03, transferencia 04. Si no hay pagos, va como efectivo.
- **Si no llega a Hacienda** porque se cayó el internet o Hacienda no respondió, el comprobante queda **guardado y firmado** con su número. **Enviar de nuevo** manda exactamente el mismo XML, sin hacer otro.
- **Si Hacienda lo rechaza,** el panel muestra el motivo. Se corrige el dato y se vuelve a emitir; sale con otro número.
- **Anular con nota de crédito** anula todo el comprobante (código 01). Cuando Hacienda la acepta, la venta se puede volver a facturar.
- **XML:** cada comprobante tiene su botón para descargar el XML firmado y la respuesta de Hacienda. Hacienda pide guardarlos; el **respaldo** del panel los incluye.

## Sin internet (situación 3)

Necesita `supabase/v19_sin_internet.sql` y la función `facturar` publicada otra vez con los archivos nuevos.

- **Cada compu tiene su terminal.** La primera vez que alguien con permiso de ventas entra con internet en una compu, el panel le aparta una terminal propia (00011, 00012, …) y números por adelantado: 50 para tiquetes y 20 para facturas. Se reponen solos cada vez que hay internet y quedan menos de 20 y 8. La terminal 00002 la sigue usando la función con internet, así **ningún número choca**.
- **Sin internet**, en la venta sale **Hacer tiquete sin internet** (o factura). Antes de hacerlo, el panel revisa lo mismo que va a revisar Hacienda: CABYS de cada producto, precios, datos del cliente para factura. El comprobante queda con su **clave de 50 dígitos**, situación **3 = sin internet**, la fecha y hora de la venta y su consecutivo. El recibo impreso lleva la clave y dice *Emitido sin internet: pendiente de envío a Hacienda*.
- **Cuando vuelve la conexión**, la compu lo manda sola: la función arma el XML con **esa misma clave y esa misma fecha**, revisa que el número estuviera apartado para esa compu, lo firma y lo envía. Después sale como cualquier otro (aceptado, rechazado, *Enviar de nuevo*).
- **Plazo:** el reglamento (art. 21) da **2 días hábiles** para que llegue a Hacienda. La banda de arriba y **Ver pendientes** muestran la fecha límite. Si el internet del almacén no vuelve a tiempo, conecte la compu al **hotspot de un celular** un rato para que se envíe.
- **Ojo con la firma:** el reglamento pide que el comprobante sin internet se genere *con su mecanismo de seguridad* en el momento de la venta. Aquí la clave y la fecha se fijan en el momento, pero la **firma se pone al volver la conexión** (la llave solo vive en Supabase, nunca en la compu). **Confírmelo con el contador** antes de usarlo en producción.
- Si se anula sin internet una venta que tiene comprobante, la nota de crédito se hace sola cuando Hacienda acepte el comprobante; después se anula la venta.
- No borre los datos del navegador de la compu de la caja con cosas pendientes: ahí están los comprobantes hechos sin internet hasta que se envían.

## Facturas de proveedores (mensaje de receptor)

Con `v21_compras_ajustes.sql` y la función `facturar` publicada otra vez (`index.ts` y `comprobante.ts` nuevos), en **Compras → Facturas recibidas** se sube el XML de la factura del proveedor y se **acepta**, **acepta en parte** o **rechaza** ante Hacienda.

- La respuesta se firma con la **misma llave y credenciales** de los secretos; va con la clave del comprobante del proveedor y un consecutivo propio: tipo **05** (aceptación), **06** (aceptación parcial) o **07** (rechazo), con la sucursal y terminal del panel.
- Al aceptar se manda la condición del IVA (01 crédito completo, 02 parcial, 03 bienes de capital, 04 gasto sin crédito, 05 proporcionalidad), el IVA que se acredita y el que queda como gasto.
- Se consulta a Hacienda igual que los comprobantes (*Consultar*, *Enviar de nuevo*). Si Hacienda rechaza la respuesta, se puede contestar de nuevo (con otro consecutivo).
- Los tiquetes no se aceptan ni rechazan; solo facturas y notas.
- El XML del proveedor, la respuesta firmada y la de Hacienda quedan en la base y en el respaldo (`facturas-recibidas/`).

## Lo que todavía no hace

- No envía el PDF y el XML al correo del cliente. Por ahora el cliente recibe el recibo impreso y el XML se descarga desde la venta.
- **Contingencia con comprobantes preimpresos** (situación 2): no hace falta mientras la compu funcione; sin internet se usa la situación 3 (arriba).

## Sin facturación encendida

Si **Facturar desde el panel** está apagado, todo sigue como antes: el cliente pide factura desde la tienda o el panel, los datos quedan en `facturas` y se emite en el sistema que el almacén use, anotando el resultado a mano en la venta.

## Exoneración de IVA (v22)

Para clientes con autorización de exoneración de EXONET (número `AL-00012345-24`).

1. Correr `supabase/v22_exoneracion.sql` y volver a publicar la función `facturar`.
2. En la venta, antes de cobrar: **Cliente exonerado…** → escribir el número → **Consultar**. El panel le pregunta a Hacienda (`api.hacienda.go.cr/fe/ex`) el tipo, la institución, la cédula, los puntos de IVA que exonera, el vencimiento y los CABYS que cubre.
3. **Aplicar a la venta**: los productos cubiertos se cobran con el IVA rebajado (13 puntos = sin IVA; 12 puntos = se cobra 1 %). Los que no cubre quedan con IVA completo.
4. Se cobra normal y se toca **Emitir factura**: sale a la cédula del exonerado, con el nodo `Exoneracion` (4.4) en cada renglón cubierto. Con exoneración no se hace tiquete.

La función revisa otra vez que no esté vencida, que la factura vaya a la cédula de la autorización y que cubra al menos un producto. Hacienda valida el número al recibir la factura.
