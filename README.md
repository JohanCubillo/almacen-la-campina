# Almacén La Campiña — sitio web, cotizaciones y control de ventas SINPE

Sitio estático en **GitHub Pages** con base de datos en **Supabase** (plan gratis).

- **Sitio público** (`index.html`): catálogo, “Mi lista” para cotizar por WhatsApp, horario con *Abierto ahora / Cerrado*, mapa.
- **Panel** (`admin.html`): cotizaciones, **ventas con cobro por SINPE Móvil**, caja diaria, productos, categorías y datos del negocio. Entra con contraseña + código del celular (MFA).

Sin credenciales de Supabase el sitio funciona con un **catálogo de muestra**, así se puede enseñar antes de conectar la base.

---

## 1. Supabase (una sola vez)

1. Crear proyecto en supabase.com (Free). Región: la más cercana (us-east).
2. **SQL Editor → New query** → pegar todo `supabase/schema.sql` → **Run**. Se puede volver a correr sin perder datos.
3. **Authentication → Users → Add user → Create new user**: correo y una contraseña larga (12+ caracteres). Marcar *Auto Confirm User*.
4. Registrar ese usuario como administrador (SQL Editor):
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'correo-del-admin@ejemplo.com'
   on conflict do nothing;
   ```
5. Hacer los ajustes de seguridad del panel de Supabase de **SEGURIDAD.md** (sobre todo: **desactivar registros nuevos**).
6. **Project Settings → API**: copiar *Project URL* y la clave **anon public**.

## 2. Conectar

Editar `assets/js/config.js`:
```js
SUPABASE_URL: "https://xxxxxxxx.supabase.co",
SUPABASE_ANON_KEY: "eyJhbGciOi...",
```
La anon key es pública por diseño (la protegen las reglas RLS). **Nunca** poner la `service_role`.

## 3. Primer ingreso al panel

Abrir `/admin.html` → correo y contraseña → el panel pide **activar la verificación en 2 pasos**: escanear el QR con Google Authenticator o Microsoft Authenticator y escribir el código. A partir de ahí cada ingreso pide el código del celular. Sin ese paso la base de datos **no deja modificar nada**, aunque la contraseña sea correcta.

Luego, en **Datos del negocio**: número **SINPE Móvil**, titular, horario por día y teléfonos.

## 4. Publicar (Windows CMD)

```cmd
git clone https://github.com/JohanCubillo/almacen-la-campina.git
cd almacen-la-campina
:: editar assets\js\config.js
git add .
git commit -m "Conectar Supabase"
git push
```
GitHub Pages publica solo en 1–2 minutos: https://johancubillo.github.io/almacen-la-campina/

Probar local: `python -m http.server 8080` → http://localhost:8080

**Cuando el dueño apruebe el sitio**, quitar en `index.html` la línea `<meta name="robots" content="noindex, nofollow" />` para que Google lo indexe.

---

## Control de ventas por SINPE Móvil

```
Cotización (cliente arma su lista)
   └─► Crear venta ──► se asigna código único (ej. LC7K2QF) y precios
          └─► Enviar cobro por WhatsApp: total + número SINPE + "en el detalle escriba LC7K2QF"
                 └─► Cliente paga y manda comprobante
                        └─► Registrar pago: monto, Nº de comprobante, quién pagó, foto
                               │   (o pegar el mensaje del banco → se llena solo)
                               └─► Estado “Por verificar”
                                      └─► Ver el dinero en la app del banco → “Ya lo vi en el banco”
                                             └─► Estado “Pagada” ──► Entregar mercadería
```

### Reglas que hace cumplir la base de datos (no se pueden saltar desde el navegador)
| Riesgo | Cómo se controla |
|---|---|
| Mandar el **mismo comprobante** dos veces (o en dos ventas) | El Nº de comprobante es único; el sistema avisa en qué venta ya se usó |
| **Comprobante falso o editado** (captura de pantalla) | Una venta solo queda *Pagada* cuando el pago se marca **“Ya lo vi en el banco”**. Queda guardado quién y cuándo |
| Cambiar montos o “borrar” un pago | Los pagos **no se editan ni se borran**: solo se anulan con **motivo** |
| Bajar precios después de cobrar | Con pagos verificados los productos de la venta quedan **congelados** |
| Total mal sumado | El **total y el saldo los calcula la base de datos**, no la página |
| Anular una venta ya cobrada | No deja anular si tiene pagos activos (primero se anula/devuelve el pago) |
| Fotos de comprobantes expuestas | Bucket **privado**; se ven con enlaces que vencen en 2 minutos, solo el admin |
| Saber quién hizo qué | **Bitácora** automática de cada cambio (Datos del negocio → Actividad reciente) |

### Rutina diaria (2 minutos)
1. Panel → **Caja SINPE** → día de hoy.
2. Abrir la app del banco → movimientos **SINPE recibidos** de hoy.
3. Comparar el total. Marcar **“Ya lo vi en el banco”** solo en los que aparecen allá.
4. Lo que quede en *Por verificar* **no se entrega** hasta confirmarlo.
5. Fin de mes: **Descargar mes (CSV)** para contabilidad / Hacienda.

---

## Estructura
```
index.html, admin.html
assets/css/        styles.css (sitio), admin.css (panel)
assets/js/         config.js (⚠️ credenciales), app.js (sitio), admin.js (panel)
assets/vendor/     supabase-js 2.119.2 (local, sin CDN)
assets/fonts/      Barlow / Barlow Condensed (local, licencia OFL)
assets/img/        logo.png, emblema.png  → reemplazar por el logo original en buena resolución
supabase/schema.sql
SEGURIDAD.md
```

## Pendiente con el dueño
- Logo original en alta resolución (el actual viene de una captura).
- Número SINPE, titular y horario reales.
- Fotos reales de productos y precios.
- Aprobación del sitio → quitar `noindex`.
