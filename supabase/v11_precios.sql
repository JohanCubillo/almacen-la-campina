-- =====================================================================
--  v11 — Ajuste de precios con historial (como "Ajuste de Precios" y "Movimientos" de Moriah)
--  Correr DESPUÉS de v9_inventario.sql. Se puede correr más de una vez.
--
--  - precios_movimientos: cada cambio de precio, venga de donde venga
--    (ajuste de precios, editar producto o importar el Excel), con el precio anterior y el nuevo
--  - ajustar_precios(): cambia varios precios de una vez con número de documento y observación
-- =====================================================================

create table if not exists public.precios_movimientos (
  id            bigint generated always as identity primary key,
  producto_id   bigint not null references public.productos(id) on delete cascade,
  precio_antes  numeric(12,2),
  precio_nuevo  numeric(12,2),
  origen        text not null default 'producto' check (origen in ('ajuste','producto','importacion')),
  documento     text check (char_length(documento) <= 40),
  nota          text check (char_length(nota) <= 300),
  hecho_por     uuid default auth.uid(),
  created_at    timestamptz not null default now()
);
create index if not exists precios_movimientos_fecha on public.precios_movimientos (created_at desc);
create index if not exists precios_movimientos_producto on public.precios_movimientos (producto_id, created_at desc);

alter table public.precios_movimientos enable row level security;
drop policy if exists "precios_movimientos_admin" on public.precios_movimientos;
create policy "precios_movimientos_admin" on public.precios_movimientos for select to authenticated using (public.is_admin());
revoke all on public.precios_movimientos from anon, authenticated;
grant select on public.precios_movimientos to authenticated;      -- escribir: solo el disparador

-- Anota cada cambio de precio. El origen y el documento llegan por variables de la transacción
-- (las pone ajustar_precios); si no hay, es una edición desde Productos o la importación.
create or replace function public.anotar_cambio_precio()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_origen text := nullif(current_setting('lc.precio_origen', true), '');
begin
  if new.precio is distinct from old.precio then
    insert into public.precios_movimientos (producto_id, precio_antes, precio_nuevo, origen, documento, nota)
    values (new.id, old.precio, new.precio,
            coalesce(v_origen, case when current_query() ilike '%importar_productos%' then 'importacion' else 'producto' end),
            nullif(current_setting('lc.precio_documento', true), ''),
            nullif(current_setting('lc.precio_nota', true), ''));
  end if;
  return new;
end $$;
revoke all on function public.anotar_cambio_precio() from public, anon, authenticated;

drop trigger if exists trg_productos_precio on public.productos;
create trigger trg_productos_precio after update of precio on public.productos
  for each row execute function public.anotar_cambio_precio();

-- Cambia varios precios de una vez: p_cambios = [{"id": 12, "precio": 4500}, ...]
create or replace function public.ajustar_precios(p_cambios jsonb, p_documento text default null, p_nota text default null)
returns int language plpgsql security definer set search_path = '' as $$
declare
  c jsonb; n int := 0; v_precio numeric; v_id bigint;
  v_doc text := left(trim(coalesce(p_documento, '')), 40);
  v_nota text := left(trim(coalesce(p_nota, '')), 300);
begin
  if not public.is_admin() then raise exception 'Solo el administrador.' using errcode = '42501'; end if;
  if jsonb_typeof(p_cambios) <> 'array' or jsonb_array_length(p_cambios) = 0 then
    raise exception 'No hay precios para cambiar.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_cambios) > 500 then
    raise exception 'Máximo 500 productos por ajuste.' using errcode = 'P0001';
  end if;
  perform set_config('lc.precio_origen', 'ajuste', true);
  perform set_config('lc.precio_documento', v_doc, true);
  perform set_config('lc.precio_nota', v_nota, true);
  for c in select * from jsonb_array_elements(p_cambios) loop
    v_id := (c ->> 'id')::bigint;
    if coalesce(c ->> 'precio', '') = '' then v_precio := null;
    elsif (c ->> 'precio') !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$' then
      raise exception 'Precio no válido: %', c ->> 'precio' using errcode = 'P0001';
    else v_precio := (c ->> 'precio')::numeric;
      if v_precio = 0 then v_precio := null; end if;
    end if;
    update public.productos set precio = v_precio, updated_at = now()
     where id = v_id and precio is distinct from v_precio;
    if found then n := n + 1; end if;
  end loop;
  perform set_config('lc.precio_origen', '', true);
  perform set_config('lc.precio_documento', '', true);
  perform set_config('lc.precio_nota', '', true);
  return n;
end $$;
revoke all on function public.ajustar_precios(jsonb, text, text) from public, anon;
grant execute on function public.ajustar_precios(jsonb, text, text) to authenticated;
