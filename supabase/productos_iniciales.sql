-- =====================================================================
--  Almacén La Campiña — Productos iniciales (fotos de su Facebook)
--  Correr DESPUÉS de schema.sql:  SQL Editor > New query > pegar > Run
--  Se puede volver a correr: no duplica productos.
--
--  ⚠️ Revisar en el panel: las láminas de techo tienen el precio del
--     anuncio ("+ IVA"); los demás son precios APROXIMADOS (IVA incluido)
--     tomados de otras ferreterías de Costa Rica en noviembre 2026.
-- =====================================================================

-- Categorías (crea las que falten y ordena)
insert into public.categorias (nombre, orden)
select v.nombre, v.orden from (values
  ('Materiales de construcción', 1),
  ('Herramientas eléctricas',    2),
  ('Ferretería',                 3),
  ('Acabados y paredes',         4),
  ('Agro y jardín',              5),
  ('Mascotas',                   6),
  ('Pesca',                      7),
  ('Cuidado del auto',           8)
) v(nombre, orden)
where not exists (select 1 from public.categorias c where c.nombre = v.nombre);

update public.categorias c set orden = v.orden
from (values
  ('Materiales de construcción', 1), ('Herramientas eléctricas', 2), ('Ferretería', 3),
  ('Acabados y paredes', 4), ('Agro y jardín', 5), ('Mascotas', 6), ('Pesca', 7), ('Cuidado del auto', 8)
) v(nombre, orden)
where c.nombre = v.nombre;

-- Productos
with base as (select 'https://johancubillo.github.io/almacen-la-campina/assets/productos/' as url),
datos (nombre, descripcion, precio, unidad, categoria, foto, destacado) as (values
  ('Lámina ondulada para techo #32',
   'Lámina galvanizada ondulada calibre 32, espesor 0.24 mm, largo 3.66 m.', 5300, 'lámina + IVA',
   'Materiales de construcción', 'lamina-ondulada-32.webp', true),
  ('Lámina aluminizada ondulada #28',
   'Lámina aluminizada ondulada calibre 28, espesor 0.32 mm.', 6500, 'lámina + IVA',
   'Materiales de construcción', 'lamina-aluminizada-28.webp', true),

  ('Taladro inalámbrico Total 20 V (P20S)',
   'Incluye batería de 1.5 Ah y cargador rápido. Usa la misma batería de la línea 20 V de Total.', 50000, 'unidad',
   'Herramientas eléctricas', 'taladro-total-p20s.webp', true),
  ('Sierra circular Total 1600 W',
   'Disco de 7-1/4" (185 mm), profundidad ajustable y corte en bisel de 0° a 45°. 110-120 V.', 58000, 'unidad',
   'Herramientas eléctricas', 'sierra-circular-total-1600w.webp', false),
  ('Soldadora inversora Total 200 A',
   'MMA / TIG lift. Incluye careta, cepillo, pinza de tierra, porta electrodo y cable de extensión.', 115000, 'unidad',
   'Herramientas eléctricas', 'soldadora-total-200a.webp', true),
  ('Pistola para pintar Total 450 W',
   'Recipiente de 800 ml, flujo regulable y tres modos de rocío. 110-120 V.', 19500, 'unidad',
   'Herramientas eléctricas', 'pistola-pintar-total-450w.webp', false),
  ('Sopladora y aspiradora Total 400 W',
   'Sopla y aspira: para limpiar talleres, motores y equipos.', 25000, 'unidad',
   'Herramientas eléctricas', 'sopladora-total-400w.webp', false),

  ('Careta para soldar fotosensible Total',
   'Oscurece sola al soldar. Área de visión de 100 × 67 mm, uso industrial.', 22000, 'unidad',
   'Ferretería', 'careta-soldar-total.webp', false),
  ('Encendedores y sopletes Floppi',
   'Sopletes de cocina y encendedores recargables en varios colores. El precio es del modelo más sencillo; los sopletes grandes cuestan más.', 1500, 'unidad',
   'Ferretería', 'encendedores-floppi.webp', false),

  ('Pulverizador de presión Total 5 L',
   'Boquilla ajustable y gatillo con seguro. Presión de 2.5 bar.', 9000, 'unidad',
   'Agro y jardín', 'pulverizador-total-5l.webp', false),
  ('Bomba de mochila Carpi Spray-Mec',
   'Aspersora manual de mochila marca Carpi.', 78000, 'unidad',
   'Agro y jardín', 'bomba-mochila-carpi.webp', false),

  ('Lámina PVC marmoleada negro y blanco (KL8008)',
   'Lámina decorativa de PVC con acabado brillante tipo mármol, para paredes.', 16500, 'lámina',
   'Acabados y paredes', 'pvc-kl8008.webp', true),
  ('Lámina PVC mármol verde con dorado (LWM-010)',
   'Lámina decorativa de PVC con acabado brillante tipo mármol, para paredes.', 16500, 'lámina',
   'Acabados y paredes', 'pvc-lwm-010.webp', false),
  ('Lámina PVC mármol blanco con vetas doradas (KSJ243252)',
   'Lámina decorativa de PVC con acabado brillante tipo mármol, para paredes.', 16500, 'lámina',
   'Acabados y paredes', 'pvc-ksj243252.webp', false),
  ('Lámina PVC mármol blanco con vetas naranja (LMHH24221)',
   'Lámina decorativa de PVC con acabado brillante tipo mármol, para paredes.', 16500, 'lámina',
   'Acabados y paredes', 'pvc-lmhh24221.webp', false),
  ('Lámina PVC mármol blanco, gris y dorado (LM1914-1)',
   'Lámina decorativa de PVC con acabado brillante tipo mármol, para paredes.', 16500, 'lámina',
   'Acabados y paredes', 'pvc-lm1914-1.webp', false),
  ('Lámina PVC mármol blanco gris suave (LMLJ24804)',
   'Lámina decorativa de PVC con acabado brillante tipo mármol, para paredes.', 16500, 'lámina',
   'Acabados y paredes', 'pvc-lmlj24804.webp', false),
  ('Lámina PVC marmoleada beige y café (KL8033-1)',
   'Lámina decorativa de PVC con acabado brillante tipo mármol, para paredes.', 16500, 'lámina',
   'Acabados y paredes', 'pvc-kl8033-1.webp', false),
  ('Lámina PVC marmoleada blanco y gris (MMS0001)',
   'Lámina decorativa de PVC con acabado brillante tipo mármol, para paredes.', 16500, 'lámina',
   'Acabados y paredes', 'pvc-mms0001.webp', false),
  ('Lámina PVC marmoleada gris claro texturada (E-3733)',
   'Lámina decorativa de PVC con acabado texturado tipo piedra, para paredes.', 16500, 'lámina',
   'Acabados y paredes', 'pvc-e-3733.webp', false)
)
insert into public.productos (nombre, descripcion, precio, unidad, categoria_id, imagen_url, destacado, activo)
select d.nombre, d.descripcion, d.precio, d.unidad, c.id, base.url || d.foto, d.destacado, true
from datos d
cross join base
join public.categorias c on c.nombre = d.categoria
where not exists (select 1 from public.productos p where p.nombre = d.nombre);

-- Ocultar los 7 productos de ejemplo (no se borran; se pueden reactivar en el panel)
update public.productos set activo = false
where imagen_url is null
  and nombre in ('Cemento gris','Varilla corrugada','Block de concreto','Juego de herramientas',
                 'Alimento para perro','Carrete y caña','Limpiador de focos');

select count(*) filter (where activo) as productos_visibles, count(*) as total from public.productos;
