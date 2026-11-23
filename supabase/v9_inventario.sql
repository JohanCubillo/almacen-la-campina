-- =====================================================================
-- ALMACÉN LA CAMPIÑA · v9 · INVENTARIO DESDE MORIAH
-- Corra este archivo DESPUÉS de schema.sql y v4_mejoras.sql.
-- Se puede correr las veces que quiera.
--
-- - productos: código (el de Moriah o el código de barras), existencia y
--   código CABYS.
-- - importar_productos(): reconoce cada producto por su CÓDIGO (si viene)
--   y si no, por el nombre. Así el inventario de Moriah se puede volver a
--   importar cada semana para actualizar precios y existencias sin
--   duplicar nada ni tocar nombres, fotos, descripciones o categorías
--   que ya se arreglaron en el panel.
-- - Si viene la existencia y no viene "Agotado", el producto queda
--   agotado cuando la existencia es 0 o menos.
-- - La existencia NO es pública: la página solo sabe si hay o no hay.
-- =====================================================================

alter table public.productos add column if not exists codigo     text;
alter table public.productos add column if not exists existencia numeric(12,2);
alter table public.productos add column if not exists cabys      text;

alter table public.productos drop constraint if exists producto_codigo_valido;
alter table public.productos add constraint producto_codigo_valido
  check (codigo is null or (char_length(codigo) between 1 and 40 and codigo !~ '\s'));
alter table public.productos drop constraint if exists producto_cabys_valido;
alter table public.productos add constraint producto_cabys_valido
  check (cabys is null or cabys ~ '^[0-9]{13}$');

create unique index if not exists productos_codigo_unico on public.productos (codigo) where codigo is not null;
create index if not exists productos_nombre_minus on public.productos (lower(nombre));

-- La existencia y el CABYS solo los ve el administrador
revoke select on public.productos from anon;
grant select (id, nombre, descripcion, precio, unidad, categoria_id, imagen_url, destacado, activo,
              created_at, updated_at, agotado, precio_oferta, oferta_hasta, codigo)
  on public.productos to anon;

create or replace function public.importar_productos(p_filas jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f jsonb; v_nombre text; v_cat_id bigint; v_cat text; v_id bigint; v_precio numeric;
  v_codigo text; v_exist numeric; v_cabys text; v_agotado boolean;
  ins int := 0; act int := 0; cats int := 0; errores jsonb := '[]'::jsonb; v_fila int;
  v_cat_nueva boolean;
begin
  if not public.is_admin() then raise exception 'No autorizado.' using errcode = '42501'; end if;
  if p_filas is null or jsonb_typeof(p_filas) <> 'array' then
    raise exception 'El archivo no trae filas.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_filas) > 3000 then
    raise exception 'Máximo 3000 productos por envío.' using errcode = 'P0001';
  end if;

  for f in select * from jsonb_array_elements(p_filas) loop
    v_fila := coalesce((f ->> 'fila')::int, 0);
    begin
      v_nombre := left(trim(regexp_replace(coalesce(f ->> 'nombre', ''), '\s+', ' ', 'g')), 100);
      if char_length(v_nombre) < 2 then raise exception 'Falta el nombre.'; end if;

      v_codigo := nullif(regexp_replace(coalesce(f ->> 'codigo', ''), '[\s''"]', '', 'g'), '');
      if v_codigo is not null and char_length(v_codigo) > 40 then raise exception 'Código muy largo: %', v_codigo; end if;

      v_cabys := nullif(regexp_replace(coalesce(f ->> 'cabys', ''), '\D', '', 'g'), '');
      if v_cabys is not null and v_cabys !~ '^[0-9]{13}$' then v_cabys := null; end if;

      v_exist := null;
      if nullif(trim(coalesce(f ->> 'existencia', '')), '') is not null then
        if trim(f ->> 'existencia') !~ '^-?[0-9]{1,10}(\.[0-9]{1,4})?$' then raise exception 'Existencia no válida: %', f ->> 'existencia'; end if;
        v_exist := round((f ->> 'existencia')::numeric, 2);
      end if;

      -- precio: vacío = "a consultar"
      v_precio := null;
      if f ? 'precio' and nullif(trim(f ->> 'precio'), '') is not null then
        if trim(f ->> 'precio') !~ '^[0-9]{1,10}(\.[0-9]{1,4})?$' then raise exception 'Precio no válido: %', f ->> 'precio'; end if;
        v_precio := round((f ->> 'precio')::numeric, 2);
        if v_precio = 0 then v_precio := null; end if;
      end if;

      -- agotado: el que venga escrito, o por existencia
      v_agotado := case when f ? 'agotado' then (f ->> 'agotado')::boolean
                        when v_exist is not null then v_exist <= 0
                        else null end;

      -- categoría: se crea si no existe; vacía = no se cambia
      v_cat_id := null; v_cat_nueva := false;
      v_cat := left(trim(coalesce(f ->> 'categoria', '')), 60);
      if char_length(v_cat) >= 2 and lower(v_cat) not in ('sin categoria', 'sin categoría', 'general') then
        select id into v_cat_id from public.categorias where lower(nombre) = lower(v_cat) limit 1;
        if v_cat_id is null then
          insert into public.categorias (nombre, orden)
          values (v_cat, coalesce((select max(orden) from public.categorias), 0) + 1)
          returning id into v_cat_id;
          v_cat_nueva := true;
        end if;
      end if;

      v_id := null;
      if v_codigo is not null then
        select id into v_id from public.productos where codigo = v_codigo;
      end if;
      if v_id is null then
        -- sin código conocido: por nombre, pero solo productos que todavía no tienen código
        -- (o el mismo), para no mezclar dos productos distintos con el mismo nombre
        select id into v_id from public.productos
         where lower(nombre) = lower(v_nombre) and (codigo is null or codigo = v_codigo)
         order by id limit 1;
      end if;

      if v_id is null then
        insert into public.productos (nombre, codigo, cabys, existencia, categoria_id, precio, unidad, descripcion,
                                      imagen_url, activo, destacado, agotado)
        values (v_nombre, v_codigo, v_cabys, v_exist, v_cat_id, v_precio,
                nullif(left(trim(coalesce(f ->> 'unidad', '')), 30), ''),
                nullif(left(trim(coalesce(f ->> 'descripcion', '')), 500), ''),
                nullif(trim(coalesce(f ->> 'imagen_url', '')), ''),
                coalesce((f ->> 'activo')::boolean, true),
                coalesce((f ->> 'destacado')::boolean, false),
                coalesce(v_agotado, false));
        ins := ins + 1;
      else
        update public.productos set
          codigo       = coalesce(codigo, v_codigo),
          cabys        = coalesce(v_cabys, cabys),
          existencia   = coalesce(v_exist, existencia),
          categoria_id = coalesce(v_cat_id, categoria_id),
          precio       = case when f ? 'precio' then v_precio else precio end,
          unidad       = case when f ? 'unidad' and nullif(trim(coalesce(f ->> 'unidad', '')), '') is not null
                              then left(trim(f ->> 'unidad'), 30) else unidad end,
          descripcion  = case when f ? 'descripcion' and nullif(trim(coalesce(f ->> 'descripcion', '')), '') is not null
                              then left(trim(f ->> 'descripcion'), 500) else descripcion end,
          imagen_url   = case when f ? 'imagen_url' and nullif(trim(coalesce(f ->> 'imagen_url', '')), '') is not null
                              then trim(f ->> 'imagen_url') else imagen_url end,
          activo       = case when f ? 'activo' then coalesce((f ->> 'activo')::boolean, activo) else activo end,
          destacado    = case when f ? 'destacado' then coalesce((f ->> 'destacado')::boolean, destacado) else destacado end,
          agotado      = coalesce(v_agotado, agotado),
          updated_at   = now()
        where id = v_id;
        act := act + 1;
      end if;
      if v_cat_nueva then cats := cats + 1; end if;
    exception when others then
      errores := errores || jsonb_build_object('fila', v_fila, 'error',
        case when sqlstate = '23514' then 'Algún dato no cumple las reglas (precio de oferta, enlace de foto, código o largo del texto).'
             when sqlstate = '23505' then 'Ese código ya lo tiene otro producto.'
             when sqlstate = '22P02' then 'Un valor de Sí/No no se entendió.'
             else sqlerrm end);
    end;
  end loop;

  return jsonb_build_object('insertados', ins, 'actualizados', act, 'categorias_nuevas', cats, 'errores', errores);
end $$;
revoke all on function public.importar_productos(jsonb) from public, anon;
grant execute on function public.importar_productos(jsonb) to authenticated;
