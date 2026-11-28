# Respaldo automático en Google Drive

Cada noche, a la **1:37 a. m.**, GitHub saca una copia completa de la base de datos (productos, ventas, pagos, crédito, inventario, compras, comprobantes electrónicos con sus XML, bitácora) y la sube a una carpeta de Google Drive:

```
Respaldos La Campina/
  diarios/     ← una copia por día; las de más de 30 días se borran solas
  mensuales/   ← la copia del día 1 de cada mes; no se borran nunca
```

- **No depende de ninguna compu del almacén**: funciona aunque todo esté apagado.
- **No incluye las fotos** (comprobantes SINPE y productos): solo la base de datos. Pesa pocos MB.
- La copia **no queda en GitHub** (el repositorio es público): solo va a Drive.
- El panel del administrador muestra en **Datos del negocio → Respaldo** cuándo fue el último, y pone un **aviso rojo arriba** si falló o si hace más de un día y medio que no se hace. GitHub también le manda un correo al dueño del repositorio cuando falla.

Se prepara una sola vez (unos 15 minutos):

---

## 1. La cuenta de Google

Use una cuenta de Google **del almacén o del dueño**, no la de quien hace el sistema. Si quieren una aparte solo para esto, creen por ejemplo `almacenlacampina.respaldos@gmail.com` **con el dueño como dueño** y con verificación en 2 pasos. Drive gratis trae 15 GB: alcanza para muchos años de respaldos.

## 2. La conexión con la base de datos (`SUPABASE_DB_URL`)

1. Supabase → el proyecto → botón **Connect** (arriba) → pestaña **Connection string** → **Session pooler** → copie la dirección **URI**. Se ve así:
   `postgresql://postgres.osuhkkojtwweepniwxtp:[YOUR-PASSWORD]@aws-0-us-west-2.pooler.supabase.com:5432/postgres`
2. Cambie `[YOUR-PASSWORD]` por la **contraseña de la base de datos**.
   - Si no la sabe: **Project Settings → Database → Reset database password**. Póngale una de **solo letras y números** (sin @ : / # ?), larga. Cambiarla **no afecta** al panel ni a la tienda (esos usan otras llaves).
3. Guarde esa dirección completa para el paso 4. **No la mande por chat ni correo.**

## 3. La conexión con Drive (`DRIVE_TOKEN`)

Se hace una vez en una compu con Windows:

1. Descargue **rclone** de <https://rclone.org/downloads/> → *Windows* → *Intel/AMD 64 Bit*. Descomprima el ZIP (por ejemplo en el Escritorio).
2. Abra la carpeta descomprimida, escriba `cmd` en la barra de la dirección de la carpeta y dé Enter: se abre la ventana negra en esa carpeta.
3. Escriba y dé Enter:
   ```bat
   rclone authorize "drive"
   ```
4. Se abre el navegador: entre con **la cuenta de Google del paso 1** y toque **Permitir**. Cuando diga *Success*, vuelva a la ventana negra.
5. Ahí aparece un texto entre `--->` y `<---End paste`, que empieza con `{"access_token":` y termina con `}`. **Cópielo completo** (solo lo que está entre las flechas). Ese es el `DRIVE_TOKEN`.
6. Cierre la ventana. Ya puede borrar la carpeta de rclone.

## 4. Poner los secretos en GitHub

GitHub → el repositorio → **Settings → Secrets and variables → Actions → New repository secret**:

| Nombre | Valor |
|---|---|
| `SUPABASE_DB_URL` | la dirección del paso 2 (con la contraseña) |
| `DRIVE_TOKEN` | el texto del paso 3 |
| `RESPALDO_CLAVE` | *(opcional)* una frase para **cifrar** el respaldo. Si la pone, el archivo queda como `.tar.gz.gpg` y sin esa frase nadie lo puede abrir, ni siquiera quien entre al Drive. **Si la pierde, los respaldos no sirven**: guárdela en un lugar seguro. |

*(Opcional)* Para otro nombre de carpeta: pestaña **Variables** → `RESPALDO_CARPETA`.

## 5. Base de datos

Supabase → **SQL Editor** → pegar `supabase/v30_respaldo_nube.sql` → **Run** (para que el panel vea si salió bien).

## 6. Probar

GitHub → **Actions** → **Respaldo diario** → **Run workflow**. En 2 o 3 minutos debe salir con ✓ verde, y en Drive aparece `Respaldos La Campina/diarios/la-campina_AAAA-MM-DD_HHMM.tar.gz`. En el panel, **Datos del negocio → Respaldo** dice *"el último bueno fue hace …"*.

---

## Si sale el aviso rojo

- **"no se pudo subir a Drive"**: la conexión con Drive se venció o se quitó el permiso (por ejemplo, si se cambió la contraseña de la cuenta de Google). Repita el paso 3 y cambie el secreto `DRIVE_TOKEN`.
- **"no se pudo sacar la copia"**: la contraseña de la base cambió o Supabase está caído. Revise `SUPABASE_DB_URL`.
- **"no se está haciendo"** sin error: GitHub **pausa los trabajos programados de los repositorios públicos que pasan 60 días sin cambios**. Entre a **Actions → Respaldo diario → Enable workflow**.
- Para ver el detalle: **Actions → Respaldo diario** → la corrida en rojo.

## Cómo volver a cargar un respaldo (si algún día hace falta)

Esto lo hace alguien con conocimientos técnicos. El archivo trae:

- `almacen.dump`: todo lo del almacén (formato de `pg_dump`).
- `usuarios.dump`: las cuentas del panel (si Supabase dejó copiarlas).
- `LEAME.txt`.

1. Si está cifrado: `gpg -d la-campina_….tar.gz.gpg > respaldo.tar.gz` (pide la frase).
2. Descomprimir: `tar -xzf respaldo.tar.gz`.
3. En un proyecto de Supabase nuevo (o el mismo, vacío): primero crear los usuarios o cargar `usuarios.dump`, y después
   `pg_restore --no-owner --no-privileges -d "<SUPABASE_DB_URL del proyecto>" almacen.dump`.
4. Volver a publicar las funciones (`facturar`, `usuarios`) y poner sus secretos.
