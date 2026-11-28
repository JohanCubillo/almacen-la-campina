-- =====================================================================
-- ALMACÉN LA CAMPIÑA · v28 · CUÁNTO SE PUEDE BAJAR UN PRECIO EN LA VENTA
-- Corra este archivo DESPUÉS de v27_cobra_admin.sql.
-- Se puede correr las veces que quiera. Si algún día vuelve a correr
-- v17 o v24, corra otra vez este al final.
--
-- Datos del negocio → "Descuento máximo en la venta" (15 % si no se cambia).
-- - En la venta el precio de un producto del catálogo ya no se escribe
--   directo: se toca el lápiz ✎ del renglón.
-- - Quien tiene permiso de "precios" puede bajarlo hasta ese porcentaje
--   (contando la oferta, el precio 2 y el descuento del cliente, y la
--   exoneración). Más abajo, no: la base lo rechaza.
-- - Quien no tiene permiso de "precios" sigue sin poder bajarlo (como antes).
-- - El administrador puede bajarlo más, pero el panel le pide confirmar.
-- - Con 0 % nadie (salvo el administrador) baja precios en la venta.
-- =====================================================================

do $$
begin
  if to_regprocedure('public.precio_minimo_venta(bigint,bigint)') is null then
    raise exception 'Primero corra v24_precios_cliente.sql.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. El porcentaje (una sola fila)
-- ---------------------------------------------------------------------
create table if not exists public.config_ventas (
  id            smallint primary key default 1 check (id = 1),
  descuento_max numeric(5,2) not null default 15 check (descuento_max >= 0 and descuento_max <= 90),
  cambiado_por  uuid,
  cambiado_at   timestamptz
);
insert into public.config_ventas (id) values (1) on conflict (id) do nothing;

alter table public.config_ventas enable row level security;
drop policy if exists "config_ventas_ver" on public.config_ventas;
create policy "config_ventas_ver" on public.config_ventas for select to authenticated using (public.es_personal());
revoke all on public.config_ventas from anon, authenticated;
grant select on public.config_ventas to authenticated;          -- cambiar: solo con la función de abajo

drop trigger if exists trg_auditoria on public.config_ventas;
create trigger trg_auditoria after insert or update or delete on public.config_ventas
  for each row when (auth.uid() is not null) execute function public.registrar_auditoria();

create or replace function public.poner_descuento_max(p_pct numeric)
returns numeric language plpgsql security definer set search_path = '' as $$
begin
  if not public.es_administrador() then
    raise exception 'Solo el administrador cambia esto.' using errcode = '42501';
  end if;
  if p_pct is null or p_pct < 0 or p_pct > 90 then
    raise exception 'El descuento máximo va de 0 a 90 %%.' using errcode = 'P0001';
  end if;
  update public.config_ventas set descuento_max = round(p_pct, 2), cambiado_por = auth.uid(), cambiado_at = now() where id = 1;
  return round(p_pct, 2);
end $$;
revoke all on function public.poner_descuento_max(numeric) from public, anon;
grant execute on function public.poner_descuento_max(numeric) to authenticated;

-- ---------------------------------------------------------------------
-- 2. La regla en cada renglón de venta
-- ---------------------------------------------------------------------
create or replace function public.permiso_precio_venta()
returns trigger language plpgsql set search_path = '' as $$
declare v_min numeric; v_lim numeric; v_pct numeric;
begin
  if auth.uid() is null or new.producto_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.precio_unit is not distinct from old.precio_unit
     and new.producto_id is not distinct from old.producto_id then return new; end if;
  if public.es_administrador() then return new; end if;          -- el panel le pide confirmar
  v_min := public.precio_minimo_venta(new.producto_id, new.pedido_id);   -- precio que le toca (ya con un céntimo de holgura)
  if v_min is null then return new; end if;                       -- producto "a consultar": lo pone quien vende

  if not public.puede('precios') then
    if new.precio_unit < v_min then
      raise exception 'No tiene permiso para bajar precios: % va a ₡%.', new.descripcion, trim(trailing '.' from to_char(v_min + 0.01, 'FM999999999990.99'))
        using errcode = '42501';
    end if;
    return new;
  end if;

  v_pct := coalesce((select descuento_max from public.config_ventas where id = 1), 15);
  v_lim := round((v_min + 0.01) * (1 - v_pct / 100), 2) - 0.01;
  if new.precio_unit < v_lim then
    raise exception '% no se puede bajar más de % %% (mínimo ₡%). Pídale al administrador.',
      new.descripcion, trim(trailing '.' from to_char(v_pct, 'FM990.99')), trim(trailing '.' from to_char(v_lim + 0.01, 'FM999999999990.99'))
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_permiso_precio_venta on public.pedido_items;
create trigger trg_permiso_precio_venta before insert or update on public.pedido_items
  for each row execute function public.permiso_precio_venta();
