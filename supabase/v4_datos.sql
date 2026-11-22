-- =====================================================================
-- ALMACÉN LA CAMPIÑA · DATOS PARA LO NUEVO (v4)
-- Corra este archivo DESPUÉS de v4_mejoras.sql (SQL Editor → Run).
-- Se puede correr las veces que quiera: solo actualiza los datos.
--
-- Qué hace:
--   1. Activa el envío a domicilio.
--   2. Carga los barrios y pueblos de Cariari con un precio de envío
--      APROXIMADO según la distancia desde el centro de Cariari.
--      Los nombres salen de la lista oficial de comunidades del distrito.
--      Ajuste los precios en el panel → Datos del negocio → Envío.
--   3. Deja ejemplos (comentados) de oferta, agotado y avisos por Telegram.
-- =====================================================================

do $$
begin
  if to_regclass('public.avisos') is null then
    raise exception 'Primero corra supabase/v4_mejoras.sql y después este archivo.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1 y 2. ENVÍO A DOMICILIO
--   Una zona por línea: Nombre = precio en colones (0 = gratis).
--   En la tienda salen en orden alfabético para que el cliente encuentre
--   su barrio rápido; aquí van agrupadas por precio para editarlas fácil.
--
--   ₡2 000  Cariari centro y barrios pegados (hasta ~1,5 km)
--   ₡3 000  de 1,5 a 3 km
--   ₡4 000  de 3 a 5 km
--   ₡6 000  de 6 a 10 km
--   ₡8 000  de 12 a 18 km
--   ₡10 000 unos 20 km
-- ---------------------------------------------------------------------
insert into public.ajustes (clave, valor) values
  ('envio_activo', 'si'),
  ('envio_nota',   'Precio aproximado del envío. Si el pedido es grande (muchas láminas, sacos o varilla) coordinamos el viaje por WhatsApp.'),
  ('envio_zonas',
'Cariari centro = 2000
San Marcos = 2000
San Juan = 2000
España = 2000
Kennedy = 2000
La Cruz = 2000
La Guaria = 2000
Las Torres = 2000
La Floresta = 2000
Los Hermanos = 2000
El Llano = 2000
El Carmen = 2000
Las Flores = 2000
Cristo Rey = 2000
La Mundial = 2000
Palermo = 2000
La Rivera = 3000
Pueblo Triste (Campo de Aterrizaje) = 3000
El Nuevo Caribe = 3000
Formosa = 3000
Astúa-Pirie = 3000
Puerta del Sol = 3000
Los Lagos = 3000
San Alberto = 3000
El Progreso = 3000
Campo Tres Oeste = 3000
El Bosque = 3000
Los Laureles = 3000
Campo Uno = 3000
Sagrada Familia = 3000
Las Orquídeas = 3000
San Miguel = 3000
Las Brisas = 3000
Pueblo Nuevo = 4000
Campo Tres = 4000
Las Gaviotas = 4000
La Sole = 4000
Campo Cinco (Semillero) = 4000
Villa Hermosa = 4000
El Encanto = 4000
Nazareth = 4000
Colonia Zeledón = 4000
Roxanita = 4000
El Infiernillo = 4000
Banamola = 4000
Hojancha = 4000
Los Ángeles = 6000
Campo Cuatro = 6000
Campo Dos = 6000
Carolina = 6000
Palmitas = 6000
La Esperanza (Cantarrana) = 6000
Cuatro Esquinas = 8000
Jodema = 8000
El Maná = 8000
Monterrey = 8000
La Lucha = 8000
El Ceibo = 8000
Canta Gallo = 8000
Vegas del Palacio = 10000
Casas Verdes (La Geest) = 10000')
on conflict (clave) do update set valor = excluded.valor;

-- Revisión: debe salir una fila por barrio con su precio
select nombre, precio from public.zonas_envio() order by precio, nombre;

-- ---------------------------------------------------------------------
-- 3. EJEMPLOS (quite los dos guiones -- del inicio para usarlos)
-- ---------------------------------------------------------------------

-- Poner un producto en oferta hasta una fecha (vuelve solo a su precio
-- normal al día siguiente). La oferta tiene que ser menor que el precio.
-- update public.productos
--    set precio_oferta = 4900, oferta_hasta = date '2026-12-24'
--  where nombre = 'Lámina ondulada para techo #32';

-- Quitar la oferta
-- update public.productos set precio_oferta = null, oferta_hasta = null
--  where nombre = 'Lámina ondulada para techo #32';

-- Marcar un producto como agotado (sigue saliendo, pero no se puede pedir)
-- update public.productos set agotado = true  where nombre = 'Soldadora inversora Total 200 A';
-- update public.productos set agotado = false where nombre = 'Soldadora inversora Total 200 A';

-- Avisos por Telegram (más fácil desde el panel → Datos del negocio).
-- El token lo da @BotFather y el Id lo da @userinfobot. El token es privado:
-- no lo suba a GitHub ni lo mande por chat.
-- update public.avisos
--    set telegram_token = 'TOKEN_DEL_BOT', telegram_chat = 'SU_ID', activo = true;
-- select public._avisar('Prueba de avisos de Almacén La Campiña.', true);
