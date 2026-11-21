-- =====================================================================
--  Almacén La Campiña — Precios aproximados (noviembre 2026)
--  Correr en Supabase: SQL Editor > New query > pegar > Run
--
--  * Solo llena los productos que todavía están en "precio a consultar":
--    si un precio ya se puso en el panel, NO lo toca.
--  * Son precios de referencia (IVA incluido) de otras ferreterías de
--    Costa Rica para el mismo producto o uno equivalente. El dueño debe
--    revisarlos y ajustarlos en el panel: Productos > editar.
--  * Las láminas de techo (#32 y #28) ya tenían precio del anuncio y no
--    se tocan.
-- =====================================================================

update public.productos p
set precio = v.precio
from (values
  ('Taladro inalámbrico Total 20 V (P20S)',                     50000),
  ('Sierra circular Total 1600 W',                              58000),
  ('Soldadora inversora Total 200 A',                          115000),
  ('Pistola para pintar Total 450 W',                           19500),
  ('Sopladora y aspiradora Total 400 W',                        25000),
  ('Careta para soldar fotosensible Total',                     22000),
  ('Encendedores y sopletes Floppi',                             1500),
  ('Pulverizador de presión Total 5 L',                          9000),
  ('Bomba de mochila Carpi Spray-Mec',                          78000),
  ('Lámina PVC marmoleada negro y blanco (KL8008)',             16500),
  ('Lámina PVC mármol verde con dorado (LWM-010)',              16500),
  ('Lámina PVC mármol blanco con vetas doradas (KSJ243252)',    16500),
  ('Lámina PVC mármol blanco con vetas naranja (LMHH24221)',    16500),
  ('Lámina PVC mármol blanco, gris y dorado (LM1914-1)',        16500),
  ('Lámina PVC mármol blanco gris suave (LMLJ24804)',           16500),
  ('Lámina PVC marmoleada beige y café (KL8033-1)',             16500),
  ('Lámina PVC marmoleada blanco y gris (MMS0001)',             16500),
  ('Lámina PVC marmoleada gris claro texturada (E-3733)',       16500)
) v(nombre, precio)
where p.nombre = v.nombre
  and p.precio is null;

-- Floppi: el precio es del modelo más sencillo; se aclara en la descripción
update public.productos
set descripcion = 'Sopletes de cocina y encendedores recargables en varios colores. El precio es del modelo más sencillo; los sopletes grandes cuestan más.'
where nombre = 'Encendedores y sopletes Floppi'
  and descripcion = 'Sopletes de cocina y encendedores recargables en varios colores.';

-- Resultado: cómo quedaron los productos visibles
select p.nombre, p.precio, p.unidad
from public.productos p
where p.activo
order by p.precio is null, p.nombre;
