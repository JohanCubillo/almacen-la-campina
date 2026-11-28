# Facturas por correo al cliente (Resend + dominio propio)

Cuando Hacienda **acepta** una factura o una nota de crédito y el cliente dejó su correo, el cliente recibe un correo con:

- el **PDF** de la factura,
- el **XML** firmado (el que vale ante Hacienda),
- la **respuesta de Hacienda**.

Los tiquetes no se mandan solos (no llevan correo), pero cualquier comprobante aceptado tiene en la venta el botón **Enviar por correo** para mandarlo a la dirección que se escriba.

Los correos salen con **Resend** desde un correo del dominio del almacén, por ejemplo `facturas@lacampina.cr`. El plan gratis de Resend permite **3.000 correos al mes y 100 al día**. Si se llega al límite, el panel lo avisa arriba en rojo, las facturas siguen saliendo bien con Hacienda y los correos pendientes se mandan solos cuando Resend vuelve a dejar.

Mientras no estén puestos los secretos de abajo, **no se manda nada** y todo funciona como antes.

---

## 1. Comprar el dominio

Es el nombre que va después de la @ y que también puede usar la página (`lacampina.cr` en vez de `johancubillo.github.io/...`).

- **.cr**: en NIC Costa Rica, <https://www.nic.cr>. Se paga por año.
- **.com**: en cualquier registrador. **Cloudflare** (<https://www.cloudflare.com/products/registrar/>) lo vende a precio de costo (unos US$10 al año) y tiene el DNS más fácil de usar.

Cómprelo **a nombre del dueño del almacén** y con su correo, no a nombre de quien hace el sistema.

## 2. Crear la cuenta en Resend y verificar el dominio

1. Entre a <https://resend.com> y cree la cuenta (con el correo del almacén).
2. **Domains → Add Domain** → escriba el dominio (ej. `lacampina.cr`). Región: la que sugiere.
3. Resend le muestra unos registros **DNS** (tipo MX y TXT: SPF y DKIM). Cópielos **tal cual** en el DNS del dominio:
   - En Cloudflare: el dominio → **DNS → Records → Add record**, uno por cada fila que da Resend.
   - En NIC.cr u otro: en la parte de DNS o "zona" del dominio.
4. En Resend toque **Verify DNS Records**. Puede tardar de unos minutos a unas horas. Cuando diga **Verified**, ya se puede mandar.
5. Recomendado: agregue también el registro **DMARC** que sugiere Resend (ayuda a que no caigan en spam).

## 3. Sacar la llave de Resend

**API Keys → Create API Key** → nombre `panel-la-campina`, permiso **Sending access**, dominio el del almacén. Copie la llave (empieza con `re_`). **Solo se ve una vez.** No la mande por chat ni correo: va directo a Supabase.

## 4. Poner los secretos en Supabase

Supabase → **Edge Functions → Secrets** → agregue:

| Nombre | Valor |
|---|---|
| `RESEND_API_KEY` | la llave `re_…` |
| `CORREO_REMITENTE` | `Almacén La Campiña <facturas@lacampina.cr>` (con su dominio) |
| `CORREO_RESPONDER` | *(opcional)* el correo donde quiere recibir las respuestas de los clientes, ej. el Gmail del almacén |
| `CORREO_LIMITE_MES` | *(opcional)* `3000`. Cámbielo si pasa a un plan pagado (ej. `50000`) |
| `CORREO_LIMITE_DIA` | *(opcional)* `100`. En los planes pagados no hay límite por día: ponga `100000` |

## 5. Base de datos y función

1. Supabase → **SQL Editor** → pegar `supabase/v29_correos.sql` → **Run**.
2. Publicar otra vez la función `facturar` (trae `correo.ts` y `pdf.ts` nuevos):

```bat
npx supabase functions deploy facturar --project-ref osuhkkojtwweepniwxtp --use-api
```

## 6. Probar

Con la facturación en **Pruebas**: haga una venta, toque **Emitir factura** con **su propio correo** y espere a que Hacienda la acepte. Le debe llegar el correo con el PDF y los dos XML (el asunto dice **[PRUEBAS]**). En la venta, debajo del comprobante, sale *Enviado por correo a …*.

---

## Cómo funciona el límite

- Cada correo queda anotado (tabla `fe_correos`): a quién, si salió y, si no, por qué.
- Resend dice en cada envío cuántos lleva usados del plan; el panel usa ese número.
- **Al 90 %** del mes sale un aviso amarillo arriba del panel: *"van 2.700 de 3.000 correos este mes"*.
- **Al llegar al límite**, Resend rechaza el correo y el panel pone un aviso **rojo**: *"Los correos de las facturas no se están enviando…"*. La factura **no se afecta**: ya está aceptada por Hacienda.
- Los que no salieron (de los últimos 30 días) se reintentan solos: el panel prueba a lo sumo una vez por hora mientras dure el límite. El de **por día** se renueva a las **6 p. m.** (medianoche en UTC); el del **mes**, cuando empieza el ciclo nuevo de Resend.
- Para no esperar: pasar a un plan pagado en Resend (**Pro**, US$20 al mes por 50.000 correos) y cambiar `CORREO_LIMITE_MES` y `CORREO_LIMITE_DIA`.
- También sale en rojo si la llave no sirve o el dominio deja de estar verificado.
