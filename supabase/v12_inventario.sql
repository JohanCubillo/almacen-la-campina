-- =====================================================================
--  v12 — Inventario: la existencia baja con cada venta y sube con las entradas de mercadería
--  Correr DESPUÉS de v9_inventario.sql (y mejor después de v11_precios.sql). Se puede correr más de una vez.
--
--  - Venta guardada (panel, página o sin internet) → baja la existencia de sus productos
--  - Venta anulada o borrada, o producto quitado de la venta → la existencia vuelve
--  - entradas + entrada_items: mercadería que llega del proveedor (suma existencia; costo y precio nuevo opcionales)
--  - inventario_movimientos: cada cambio de existencia con su motivo (kardex)
--  - Si la existencia llega a 0 el producto queda "agotado"; si vuelve a haber, deja de estarlo
--  Solo se lleva existencia de los productos que la tienen (los de Moriah o los que reciben una entrada).
--  Las ventas hechas antes de correr este archivo no se descuentan (la existencia de Moriah ya las incluye).
-- =====================================================================

alter table public.productos add column if not exists costo numeric(12,2);
alter table public.productos drop constraint if exists productos_costo_valido;
alter table public.productos add constraint productos_costo_valido check (costo is null or costo >= 0);
-- (anon no ve costo ni existencia: v9 dejó a la tienda solo las columnas públicas)

-- ---------- historial (kardex) ----------
create table if not exists public.inventario_movimientos (
  id                  bigint generated always as identity primary key,
  producto_id         bigint not null references public.productos(id) on delete cascade,
  cantidad            numeric(12,2) not null,            -- + entra, − sale
  existencia_antes    numeric(12,2),
  existencia_despues  numeric(12,2),
  origen              text not null check (origen in ('venta','venta_cambio','venta_borrada','anulacion',
                                                      'entrada','entrada_anulada','producto','importacion')),
  pedido_id           bigint,
  entrada_id          bigint,
  nota                text check (char_length(nota) <= 300),
  hecho_por           uuid default auth.uid(),
  created_at          timestamptz not null default now()
);
create index if not exists inv_mov_fecha on public.inventario_movimientos (created_at desc);
create index if not exists inv_mov_producto on public.inventario_movimientos (producto_id, created_at desc);

alter table public.inventario_movimientos enable row level security;
drop policy if exists "inv_mov_admin" on public.inventario_movimientos;
create policy "inv_mov_admin" on public.inventario_movimientos for select to authenticated using (public.is_admin());
revoke all on public.inventario_movimientos from anon, authenticated;
grant select on public.inventario_movimientos to authenticated;

-- ---------- entradas de mercadería ----------
create table if not exists public.entradas (
  id                bigint generated always as identity primary key,
  fecha             date not null default ((now() at time zone 'America/Costa_Rica')::date),
  proveedor         text check (char_length(proveedor) <= 100),
  documento         text check (char_length(documento) <= 40),
  nota              text check (char_length(nota) <= 300),
  total_costo       numeric(14,2) not null default 0,
  productos         int not null default 0,
  estado            text not null default 'aplicada' check (estado in ('aplicada','anulada')),
  motivo_anulacion  text check (char_length(motivo_anulacion) <= 300),
  anulada_at        timestamptz,
  hecho_por         uuid default auth.uid(),
  created_at        timestamptz not null default now()
);
create table if not exists public.entrada_items (
  id            bigint generated always as identity primary key,
  entrada_id    bigint not null references public.entradas(id) on delete cascade,
  producto_id   bigint not null references public.productos(id) on delete restrict,
  cantidad      numeric(12,2) not null check (cantidad > 0 and cantidad <= 10000000),
  costo_unit    numeric(12,2) check (costo_unit >= 0),
  precio_nuevo  numeric(12,2) check (precio_nuevo > 0)
);
create index if not exists entrada_items_entrada on public.entrada_items (entrada_id);
create index if not exists entradas_fecha on public.entradas (fecha desc, id desc);

alter table public.entradas enable row level security;
alter table public.entrada_items enable row level security;
drop policy if exists "entradas_admin" on public.entradas;
drop policy if exists "entrada_items_admin" on public.entrada_items;
create policy "entradas_admin" on public.entradas for select to authenticated using (public.is_admin());
create policy "entrada_items_admin" on public.entrada_items for select to authenticated using (public.is_admin());
revoke all on public.entradas, public.entrada_items from anon, authenticated;
grant select on public.entradas, public.entrada_items to authenticated;      -- escribir: solo con las funciones de abajo

-- ---------- anotar cada cambio de existencia ----------
-- El motivo llega por variables de la transacción (las pone _inv_mover); si no hay,
-- es una edición desde Productos o la importación del Excel.
create or replace function public.anotar_cambio_existencia()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_origen text := nullif(current_setting('lc.inv_origen', true), '');
begin
  if new.existencia is distinct from old.existencia then
    insert into public.inventario_movimientos (producto_id, cantidad, existencia_antes, existencia_despues, origen, pedido_id, entrada_id, nota)
    values (new.id, coalesce(new.existencia, 0) - coalesce(old.existencia, 0), old.existencia, new.existencia,
            coalesce(v_origen, case when current_query() ilike '%importar_productos%' then 'importacion' else 'producto' end),
            nullif(current_setting('lc.inv_pedido', true), '')::bigint,
            nullif(current_setting('lc.inv_entrada', true), '')::bigint,
            nullif(current_setting('lc.inv_nota', true), ''));
  end if;
  return new;
end $$;
revoke all on function public.anotar_cambio_existencia() from public, anon, authenticated;
drop trigger if exists trg_productos_existencia on public.productos;
create trigger trg_productos_existencia after update of existencia on public.productos
  for each row execute function public.anotar_cambio_existencia();

-- Agotado automático: al llegar a 0 se marca; al volver a haber se desmarca.
-- Si en el mismo cambio alguien puso "agotado" a mano, se respeta lo que puso.
create or replace function public.agotado_por_existencia()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.existencia is distinct from old.existencia and new.existencia is not null
     and new.agotado is not distinct from old.agotado then
    if new.existencia <= 0 and coalesce(old.existencia, 1) > 0 then new.agotado := true;
    elsif new.existencia > 0 and coalesce(old.existencia, 0) <= 0 then new.agotado := false;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_productos_agotado on public.productos;
create trigger trg_productos_agotado before update of existencia on public.productos
  for each row execute function public.agotado_por_existencia();

-- Mueve la existencia de un producto y deja el motivo para el historial.
-- p_iniciar: si el producto no llevaba existencia, empieza en 0 (las entradas sí la inician; las ventas no).
create or replace function public._inv_mover(p_producto bigint, p_delta numeric, p_origen text,
                                             p_pedido bigint, p_entrada bigint, p_nota text, p_iniciar boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_producto is null or coalesce(p_delta, 0) = 0 then return; end if;
  perform set_config('lc.inv_origen', p_origen, true);
  perform set_config('lc.inv_pedido', coalesce(p_pedido::text, ''), true);
  perform set_config('lc.inv_entrada', coalesce(p_entrada::text, ''), true);
  perform set_config('lc.inv_nota', left(coalesce(p_nota, ''), 300), true);
  if p_iniciar then
    update public.productos set existencia = coalesce(existencia, 0) + p_delta where id = p_producto;
  else
    update public.productos set existencia = existencia + p_delta where id = p_producto and existencia is not null;
  end if;
  perform set_config('lc.inv_origen', '', true);
  perform set_config('lc.inv_pedido', '', true);
  perform set_config('lc.inv_entrada', '', true);
  perform set_config('lc.inv_nota', '', true);
end $$;
revoke all on function public._inv_mover(bigint, numeric, text, bigint, bigint, text, boolean) from public, anon, authenticated;

-- ---------- ventas ----------
create or replace function public.inv_por_renglon()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_pedido bigint := case when tg_op = 'DELETE' then old.pedido_id else new.pedido_id end;
  v_estado text;
begin
  -- al borrar una venta entera, la devolución la hace inv_por_borrado (una sola vez)
  if tg_op = 'DELETE' and position(',' || v_pedido || ',' in coalesce(current_setting('lc.inv_borrando', true), '')) > 0 then return null; end if;
  select estado into v_estado from public.pedidos where id = v_pedido;
  if v_estado = 'anulada' then return null; end if;        -- una venta anulada ya devolvió su mercadería
  if tg_op = 'INSERT' then
    perform public._inv_mover(new.producto_id, -new.cantidad, 'venta', new.pedido_id, null, null, false);
  elsif tg_op = 'DELETE' then
    perform public._inv_mover(old.producto_id, old.cantidad, 'venta_cambio', old.pedido_id, null, null, false);
  elsif new.producto_id is distinct from old.producto_id or new.cantidad <> old.cantidad then
    perform public._inv_mover(old.producto_id, old.cantidad, 'venta_cambio', old.pedido_id, null, null, false);
    perform public._inv_mover(new.producto_id, -new.cantidad, 'venta', new.pedido_id, null, null, false);
  end if;
  return null;
end $$;
revoke all on function public.inv_por_renglon() from public, anon, authenticated;
drop trigger if exists trg_inv_renglon on public.pedido_items;
create trigger trg_inv_renglon after insert or update or delete on public.pedido_items
  for each row execute function public.inv_por_renglon();

create or replace function public.inv_por_anulacion()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if new.estado = 'anulada' and old.estado <> 'anulada' then
    for r in select producto_id, cantidad from public.pedido_items where pedido_id = new.id loop
      perform public._inv_mover(r.producto_id, r.cantidad, 'anulacion', new.id, null, left(new.motivo_anulacion, 300), false);
    end loop;
  elsif old.estado = 'anulada' and new.estado <> 'anulada' then
    for r in select producto_id, cantidad from public.pedido_items where pedido_id = new.id loop
      perform public._inv_mover(r.producto_id, -r.cantidad, 'venta', new.id, null, null, false);
    end loop;
  end if;
  return null;
end $$;
revoke all on function public.inv_por_anulacion() from public, anon, authenticated;
drop trigger if exists trg_inv_anulacion on public.pedidos;
create trigger trg_inv_anulacion after update of estado on public.pedidos
  for each row execute function public.inv_por_anulacion();

create or replace function public.inv_por_borrado()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if old.estado <> 'anulada' then
    for r in select producto_id, cantidad from public.pedido_items where pedido_id = old.id loop
      perform public._inv_mover(r.producto_id, r.cantidad, 'venta_borrada', old.id, null, null, false);
    end loop;
  end if;
  perform set_config('lc.inv_borrando', coalesce(nullif(current_setting('lc.inv_borrando', true), ''), ',') || old.id || ',', true);
  return old;
end $$;
revoke all on function public.inv_por_borrado() from public, anon, authenticated;
drop trigger if exists trg_inv_borrado on public.pedidos;
create trigger trg_inv_borrado before delete on public.pedidos
  for each row execute function public.inv_por_borrado();

-- ---------- registrar y anular entradas ----------
-- p = {"proveedor","documento","fecha":"2026-11-23","nota",
--      "items":[{"producto_id":12,"cantidad":"10","costo":"3500","precio":"4500"}, ...]}
create or replace function public.registrar_entrada(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint; it jsonb; v_prod bigint; v_cant numeric; v_costo numeric; v_precio numeric;
  v_total numeric := 0; n int := 0;
  v_doc text := nullif(left(trim(coalesce(p ->> 'documento', '')), 40), '');
  v_prov text := nullif(left(trim(coalesce(p ->> 'proveedor', '')), 100), '');
  v_nota text := nullif(left(trim(coalesce(p ->> 'nota', '')), 300), '');
  v_fecha date;
  num constant text := '^[0-9]{1,10}(\.[0-9]{1,2})?$';
begin
  if not public.is_admin() then raise exception 'Solo el administrador.' using errcode = '42501'; end if;
  if jsonb_typeof(p -> 'items') <> 'array' or jsonb_array_length(p -> 'items') = 0 then
    raise exception 'Agregue al menos un producto.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p -> 'items') > 500 then
    raise exception 'Máximo 500 productos por entrada.' using errcode = 'P0001';
  end if;
  begin v_fecha := coalesce(nullif(p ->> 'fecha', '')::date, (now() at time zone 'America/Costa_Rica')::date);
  exception when others then raise exception 'Revise la fecha.' using errcode = 'P0001'; end;
  if v_fecha > (now() at time zone 'America/Costa_Rica')::date then
    raise exception 'La fecha no puede ser futura.' using errcode = 'P0001';
  end if;

  insert into public.entradas (fecha, proveedor, documento, nota) values (v_fecha, v_prov, v_doc, v_nota)
  returning id into v_id;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_prod := nullif(it ->> 'producto_id', '')::bigint;
    if v_prod is null or not exists (select 1 from public.productos where id = v_prod) then
      raise exception 'Un producto de la lista ya no existe.' using errcode = 'P0001';
    end if;
    if coalesce(it ->> 'cantidad', '') !~ num or (it ->> 'cantidad')::numeric <= 0 then
      raise exception 'Revise las cantidades (mayores que 0, hasta 2 decimales).' using errcode = 'P0001';
    end if;
    v_cant := (it ->> 'cantidad')::numeric;
    v_costo := null; v_precio := null;
    if coalesce(it ->> 'costo', '') <> '' then
      if (it ->> 'costo') !~ num then raise exception 'Revise los costos.' using errcode = 'P0001'; end if;
      v_costo := (it ->> 'costo')::numeric;
    end if;
    if coalesce(it ->> 'precio', '') <> '' then
      if (it ->> 'precio') !~ num or (it ->> 'precio')::numeric <= 0 then raise exception 'Revise los precios de venta.' using errcode = 'P0001'; end if;
      v_precio := (it ->> 'precio')::numeric;
    end if;

    insert into public.entrada_items (entrada_id, producto_id, cantidad, costo_unit, precio_nuevo)
    values (v_id, v_prod, v_cant, v_costo, v_precio);
    perform public._inv_mover(v_prod, v_cant, 'entrada', null, v_id, coalesce(v_doc, v_prov), true);
    if v_costo is not null then update public.productos set costo = v_costo where id = v_prod; end if;
    if v_precio is not null then
      -- queda en el historial de precios (v11) como ajuste con el documento de la entrada
      perform set_config('lc.precio_origen', 'ajuste', true);
      perform set_config('lc.precio_documento', coalesce(v_doc, 'Entrada ' || v_id), true);
      perform set_config('lc.precio_nota', 'Entrada de mercadería', true);
      update public.productos set precio = v_precio, updated_at = now() where id = v_prod and precio is distinct from v_precio;
      perform set_config('lc.precio_origen', '', true);
      perform set_config('lc.precio_documento', '', true);
      perform set_config('lc.precio_nota', '', true);
    end if;
    v_total := v_total + v_cant * coalesce(v_costo, 0);
    n := n + 1;
  end loop;

  update public.entradas set total_costo = round(v_total, 2), productos = n where id = v_id;
  return jsonb_build_object('id', v_id, 'productos', n, 'total_costo', round(v_total, 2));
end $$;
revoke all on function public.registrar_entrada(jsonb) from public, anon;
grant execute on function public.registrar_entrada(jsonb) to authenticated;

create or replace function public.anular_entrada(p_id bigint, p_motivo text)
returns void language plpgsql security definer set search_path = '' as $$
declare r record; v_estado text;
begin
  if not public.is_admin() then raise exception 'Solo el administrador.' using errcode = '42501'; end if;
  if char_length(trim(coalesce(p_motivo, ''))) < 3 then raise exception 'Escriba el motivo.' using errcode = 'P0001'; end if;
  select estado into v_estado from public.entradas where id = p_id for update;
  if v_estado is null then raise exception 'Esa entrada no existe.' using errcode = 'P0001'; end if;
  if v_estado = 'anulada' then raise exception 'Esa entrada ya está anulada.' using errcode = 'P0001'; end if;
  for r in select producto_id, cantidad from public.entrada_items where entrada_id = p_id loop
    perform public._inv_mover(r.producto_id, -r.cantidad, 'entrada_anulada', null, p_id, left(trim(p_motivo), 300), false);
  end loop;
  update public.entradas set estado = 'anulada', motivo_anulacion = left(trim(p_motivo), 300), anulada_at = now() where id = p_id;
end $$;
revoke all on function public.anular_entrada(bigint, text) from public, anon;
grant execute on function public.anular_entrada(bigint, text) to authenticated;
