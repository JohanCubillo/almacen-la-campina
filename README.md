# Almacén La Campiña — tienda en línea con pedidos y control de pagos SINPE

Sitio estático en **GitHub Pages** con base de datos en **Supabase** (plan gratis).

- **Tienda** (`index.html`): catálogo con fotos, filtros, ofertas con fecha, productos agotados, **calculadora de láminas** (techo y PVC), carrito con **envío a domicilio por zonas** y **solicitud de factura electrónica**, pedido con código y comprobante SINPE opcional.
- **Mi pedido** (`pedido.html`): el cliente ve su pedido con **código + teléfono** (sin crear cuenta), si ya está **listo**, la entrega, la factura, y sube el comprobante.
- **Panel** (`admin.html`): pedidos y ventas, comprobantes, caja SINPE, **reportes**, productos (con **importar/descargar Excel**, agotado y ofertas), categorías y datos del negocio (envío, **avisos por Telegram**). Entra con contraseña + código del celular (MFA). Se instala como app en el celular.

En línea: https://johancubillo.github.io/almacen-la-campina/

---

## 1. Supabase

1. **SQL Editor → New query** → pegar `supabase/schema.sql` → **Run**. Se puede volver a correr (actualiza sin perder ventas ni productos).
2. **SQL Editor → New query** → pegar `supabase/v4_mejoras.sql` → **Run**. Agrega agotado, ofertas, envío, factura, avisos, Excel y reportes. **Siempre después de `schema.sql`** (si vuelve a correr `schema.sql`, corra también este).
3. **SQL Editor → New query** → pegar `supabase/productos_iniciales.sql` → **Run**. Carga los productos con fotos de su Facebook y oculta los de ejemplo. (`precios_aproximados.sql` llena los precios que falten.)
4. **Authentication → Users → Add user** (correo + contraseña de 12+ caracteres, *Auto Confirm*).
5. Registrar al administrador:
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'correo-del-admin@ejemplo.com'
   on conflict do nothing;
   ```
6. Ajustes de seguridad del Dashboard: ver **SEGURIDAD.md** (sobre todo **desactivar registros nuevos**).
7. `assets/js/config.js` lleva la **Project URL** y la **Publishable key** (`sb_publishable_…`). **Nunca** la secret / service_role.

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
6. **Factura electrónica**: ver **FACTURACION.md**.

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
supabase/          schema.sql, v4_mejoras.sql, productos_iniciales.sql, precios_aproximados.sql
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
