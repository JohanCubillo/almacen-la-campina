# Google, dominio propio y app del panel

## 1. Antes de mostrarlo en Google

El sitio todavía tiene `noindex` (Google no lo muestra). Cuando el dueño apruebe la página:

1. En `index.html` borre la línea `<meta name="robots" content="noindex, nofollow" />`.
2. Suba el cambio (`git add . && git commit -m "Publicar en Google" && git push`).

Ya quedó listo lo que Google y Facebook leen:

- Ficha del negocio para Google (tipo ferretería, dirección, teléfono, Facebook) dentro de `index.html`.
- Imagen para compartir en WhatsApp y Facebook: `assets/img/og.jpg` (1200 × 630).
- `sitemap.xml` con la página principal. Las páginas del panel y de “Mi pedido” no se indexan.

## 2. Perfil de Google (Google Maps)

Es lo que más clientes trae en un pueblo: aparece cuando alguien busca “ferretería Cariari”.

1. Entre a <https://business.google.com> con la cuenta de Google del dueño.
2. Busque “Almacén La Campiña”. Si ya existe, pida administrarlo. Si no, créelo como **Ferretería**.
3. Dirección: 150 m noreste del cruce de Perdiz, Barrio San Marcos, Cariari. Ponga el pin exacto en el mapa.
4. Teléfono 4711-8869, horario y el sitio web (la dirección de GitHub Pages o el dominio propio).
5. Google pide verificar el negocio (por video, llamada o carta). Siga sus pasos.
6. Suba fotos del local, de la entrada y de los productos.

## 3. Google Search Console

1. Entre a <https://search.google.com/search-console> y agregue la propiedad con el prefijo de la URL del sitio.
2. Verifíquela con la opción de etiqueta HTML (se agrega una línea `<meta>` en `index.html`).
3. En **Sitemaps** envíe `sitemap.xml`.

## 4. Dominio propio (opcional)

Con un dominio el sitio queda en algo como `lacampina.cr` o `almacenlacampina.com` en vez de `johancubillo.github.io/...`.

1. Compre el dominio: `.cr` en NIC Costa Rica (<https://www.nic.cr>) o `.com` en cualquier registrador.
2. En el registrador, configure el DNS:

   | Tipo | Nombre | Valor |
   |---|---|---|
   | A | @ | 185.199.108.153 |
   | A | @ | 185.199.109.153 |
   | A | @ | 185.199.110.153 |
   | A | @ | 185.199.111.153 |
   | CNAME | www | johancubillo.github.io |

3. En GitHub: repositorio → **Settings → Pages → Custom domain** → escriba el dominio → **Save**. Cuando GitHub termine, marque **Enforce HTTPS**.
4. Cambie la dirección vieja por la nueva en:
   - `index.html`: `og:url`, `og:image`, `canonical` y la ficha `application/ld+json`.
   - `sitemap.xml` y `robots.txt`.
   - `supabase/productos_iniciales.sql`, solo si va a volver a cargar las fotos con ese archivo.
   - Supabase → **Authentication → URL Configuration**: *Site URL* y *Redirect URLs*.
   - Panel → **Datos del negocio → Avisos por Telegram**: el enlace del panel. Desde el SQL Editor:
     `update public.avisos set panel_url = 'https://SU-DOMINIO/admin.html' where id = 1;`
5. Las fotos cargadas con `productos_iniciales.sql` tienen la dirección vieja, y la regla de seguridad del sitio (CSP) solo deja cargar imágenes del mismo dominio. Cámbielas en el SQL Editor:
   ```sql
   update public.productos
      set imagen_url = replace(imagen_url, 'https://johancubillo.github.io/almacen-la-campina/', 'https://SU-DOMINIO/')
    where imagen_url like 'https://johancubillo.github.io/almacen-la-campina/%';
   ```
   Las fotos subidas desde el panel están en Supabase y no cambian.

## 5. El panel como app en el celular

El panel ya se puede instalar como app:

- **Android (Chrome):** abra `.../admin.html` → menú ⋮ → **Agregar a la pantalla principal** o **Instalar app**.
- **iPhone (Safari):** abra `.../admin.html` → botón **Compartir** → **Agregar a inicio**.

Queda con su ícono y se abre sin la barra del navegador. Pide el mismo correo, contraseña y código de 6 dígitos.
