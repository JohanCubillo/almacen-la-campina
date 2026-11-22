# Factura electrónica

La página **no emite** facturas ante Hacienda. Lo que hace es recoger la solicitud del cliente y llevar el control en el panel. La factura se emite con el sistema de facturación del almacén, a mano o conectado.

## Cómo llega una solicitud

- **Desde la tienda:** en el carrito, el cliente abre “¿Necesita factura electrónica?” y pone el tipo de identificación, el número, el nombre o razón social y el correo. La base de datos valida el número: física 9 dígitos, jurídica 10, DIMEX 11 o 12, NITE 10.
- **Desde el panel:** en una venta, botón **El cliente pide factura**.

Los datos quedan en la tabla `facturas`, que solo ve el administrador con su código de 6 dígitos.

## Opción A: a mano (para empezar)

1. Abra la venta. En **Factura electrónica** están los datos del cliente.
2. Emita la factura en su sistema de facturación con esos datos y los renglones de la venta.
3. En el panel cambie el **Estado** a *Aceptada por Hacienda* y, si quiere, anote el **consecutivo** (20 dígitos) y la **clave** (50 dígitos).
4. El cliente ve en “Mi pedido”: *Factura electrónica: emitida y enviada a su correo*.

## Opción B: conectar un sistema de facturación

Un programa que corra **en un servidor o en la computadora del almacén, nunca en la página** puede:

1. Leer las pendientes de la vista `v_facturas_pendientes`. Trae receptor, código de pedido, total y renglones en `lineas` (JSON).
2. Emitir ante Hacienda.
3. Actualizar la tabla `facturas`: `estado` (`enviada`, `aceptada`, `rechazada`, `error`), `clave`, `consecutivo` y `mensaje`.

Ejemplo con la API REST de Supabase:

```bash
# pendientes
curl "https://osuhkkojtwweepniwxtp.supabase.co/rest/v1/v_facturas_pendientes?select=*" \
  -H "apikey: $SUPABASE_SECRET" -H "Authorization: Bearer $SUPABASE_SECRET"

# marcar como aceptada
curl -X PATCH "https://osuhkkojtwweepniwxtp.supabase.co/rest/v1/facturas?id=eq.15" \
  -H "apikey: $SUPABASE_SECRET" -H "Authorization: Bearer $SUPABASE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"estado":"aceptada","clave":"5060…","consecutivo":"0010000101…"}'
```

> ⚠️ `$SUPABASE_SECRET` es la llave **secreta** (`sb_secret_…` / service_role). Solo va en la configuración de ese programa en el servidor. Nunca en `config.js`, nunca en GitHub y nunca en un mensaje. Si se filtra, revóquela en **Project Settings → API keys**.

## Lo que la página no hace (a propósito)

- No guarda la llave criptográfica (.p12) ni el usuario de Hacienda: eso vive solo en el sistema de facturación.
- No calcula impuestos por renglón. Los precios del catálogo son los que se cobran; el sistema de facturación desglosa el IVA según la actividad del almacén.
