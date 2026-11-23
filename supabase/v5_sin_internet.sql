-- =====================================================================
-- ALMACÉN LA CAMPIÑA · v5 · VENTAS HECHAS SIN INTERNET
-- Corra este archivo DESPUÉS de schema.sql y v4_mejoras.sql.
-- Se puede correr las veces que quiera.
--
-- El panel guarda en la compu las ventas que se hacen sin internet y,
-- cuando vuelve la conexión, las manda con esta función.
-- Cada venta lleva un identificador único creado en la compu: si el envío
-- se corta a medias y se repite, la venta NO se duplica.
-- Todo entra en una sola operación: o se guarda la venta completa (con sus
-- productos y pagos) o no se guarda nada.
-- =====================================================================

alter table public.pedidos add column if not exists offline_id uuid;
create unique index if not exists pedidos_offline_id_unico on public.pedidos (offline_id) where offline_id is not null;

create or replace function public.registrar_venta_sin_internet(p_id uuid, p_venta jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id     bigint;
  v_codigo text;
  v_fecha  timestamptz;
  it       jsonb;
  pg       jsonb;
begin
  if not public.is_admin() then
    raise exception 'No autorizado.' using errcode = '42501';
  end if;
  if p_id is null or jsonb_typeof(p_venta) <> 'object' then
    raise exception 'Venta inválida.' using errcode = 'P0001';
  end if;

  -- ya se había recibido (el envío anterior se cortó después de guardar)
  select id, codigo into v_id, v_codigo from public.pedidos where offline_id = p_id;
  if found then
    return jsonb_build_object('id', v_id, 'codigo', v_codigo, 'repetida', true);
  end if;

  if jsonb_typeof(p_venta->'items') <> 'array' or jsonb_array_length(p_venta->'items') = 0 then
    raise exception 'La venta no tiene productos.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_venta->'items') > 200 then
    raise exception 'La venta tiene demasiados renglones.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_venta->'pagos', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_venta->'pagos', '[]'::jsonb)) > 20 then
    raise exception 'Los pagos de la venta no son válidos.' using errcode = 'P0001';
  end if;

  -- la fecha real de la venta (cuando se hizo sin internet), nunca futura ni de hace más de 30 días
  begin
    v_fecha := (p_venta->>'fecha')::timestamptz;
  exception when others then
    v_fecha := null;
  end;
  v_fecha := least(now(), greatest(coalesce(v_fecha, now()), now() - interval '30 days'));

  insert into public.pedidos (cliente_nombre, cliente_telefono, nota, origen, revisado, offline_id, created_at)
  values (
    left(trim(p_venta->>'cliente_nombre'), 80),
    nullif(trim(coalesce(p_venta->>'cliente_telefono', '')), ''),
    nullif(left(trim(coalesce(p_venta->>'nota', '')), 500), ''),
    'panel', true, p_id, v_fecha)
  returning id, codigo into v_id, v_codigo;

  for it in select * from jsonb_array_elements(p_venta->'items') loop
    insert into public.pedido_items (pedido_id, producto_id, descripcion, cantidad, precio_unit)
    values (
      v_id,
      (select x.id from public.productos x where x.id = nullif(it->>'producto_id', '')::bigint),
      left(trim(it->>'descripcion'), 120),
      (it->>'cantidad')::numeric,
      coalesce((it->>'precio_unit')::numeric, 0));
  end loop;

  for pg in select * from jsonb_array_elements(coalesce(p_venta->'pagos', '[]'::jsonb)) loop
    insert into public.pagos (pedido_id, metodo, monto, referencia, telefono_origen, nombre_origen, fecha, verificado, nota)
    values (
      v_id,
      pg->>'metodo',
      (pg->>'monto')::numeric,
      nullif(upper(trim(coalesce(pg->>'referencia', ''))), ''),
      nullif(trim(coalesce(pg->>'telefono_origen', '')), ''),
      nullif(left(trim(coalesce(pg->>'nombre_origen', '')), 100), ''),
      least(now(), greatest(coalesce((pg->>'fecha')::timestamptz, v_fecha), now() - interval '30 days')),
      coalesce((pg->>'verificado')::boolean, false),
      'Registrado sin internet');
  end loop;

  perform public.recalcular_pedido(v_id);
  return jsonb_build_object('id', v_id, 'codigo', v_codigo, 'repetida', false);
exception
  when unique_violation then
    if sqlerrm like '%pagos_referencia_unica%' then
      raise exception 'Ese número de comprobante ya está registrado en otra venta.' using errcode = 'P0001';
    end if;
    raise;
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'La venta tiene un número inválido (cantidad, precio o monto).' using errcode = 'P0001';
end $$;

revoke all on function public.registrar_venta_sin_internet(uuid, jsonb) from public, anon;
grant execute on function public.registrar_venta_sin_internet(uuid, jsonb) to authenticated;
