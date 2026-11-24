-- =====================================================================
-- ALMACÉN LA CAMPIÑA · v15 · LOS MÁS VENDIDOS (PARA PONERLES FOTO)
-- Corra este archivo DESPUÉS de v9_inventario.sql.
-- Se puede correr las veces que quiera.
--
-- - productos.vendido: cuánto se ha vendido de cada producto (en colones),
--   según la columna "Monto V" del inventario de Moriah. Se llena cada vez
--   que se importa ese archivo en el panel.
-- - Sirve para ordenar en el panel (Productos → Fotos) y ponerle foto
--   primero a lo que más se vende.
-- - NO es público: la tienda no lo puede leer (las columnas públicas de
--   productos se dieron una por una en v9).
-- =====================================================================

alter table public.productos add column if not exists vendido numeric(14,2);

alter table public.productos drop constraint if exists producto_vendido_valido;
alter table public.productos add constraint producto_vendido_valido
  check (vendido is null or vendido >= 0);

create index if not exists productos_vendido_idx on public.productos (vendido desc nulls last);

-- anota lo vendido por código: p_filas = [{"codigo": "29001", "vendido": 847900}, ...]
create or replace function public.anotar_vendido(p_filas jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'No autorizado.' using errcode = '42501'; end if;
  if p_filas is null or jsonb_typeof(p_filas) <> 'array' then
    raise exception 'No vienen datos.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_filas) > 20000 then
    raise exception 'Máximo 20000 productos por envío.' using errcode = 'P0001';
  end if;

  update public.productos p set vendido = x.vendido
  from (
    select distinct on (codigo) codigo, vendido from (
      select regexp_replace(coalesce(e ->> 'codigo', ''), '[\s''"]', '', 'g') as codigo,
             case when trim(coalesce(e ->> 'vendido', '')) ~ '^[0-9]{1,12}(\.[0-9]{1,4})?$'
                  then round(trim(e ->> 'vendido')::numeric, 2) end as vendido
      from jsonb_array_elements(p_filas) e
    ) y
    where codigo <> ''
    order by codigo, vendido desc nulls last
  ) x
  where p.codigo = x.codigo
    and p.vendido is distinct from x.vendido;

  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.anotar_vendido(jsonb) from public, anon;
grant execute on function public.anotar_vendido(jsonb) to authenticated;
