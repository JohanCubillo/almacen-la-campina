-- =====================================================================
--  v24 — Precio 2 y descuento por cliente (y precios permitidos en la venta)
--  Requiere v13, v17, v19 y v22. Se puede correr más de una vez.
--
--  - productos.precio2: segundo precio (mayoreo, constructores…)
--  - clientes.tipo_precio (1 o 2) y clientes.descuento (% general, 0 a 50)
--  - En la venta, quien no tiene permiso de "precios" puede cobrar el precio que le toca al cliente
--    (precio 2, su descuento) y el IVA rebajado de una exoneración, pero no menos.
--  - registrar_venta_sin_internet recibe la exoneración y pone el cliente antes de los renglones.
-- =====================================================================

alter table public.productos add column if not exists precio2 numeric(12,2);
alter table public.productos drop constraint if exists productos_precio2_valido;
alter table public.productos add constraint productos_precio2_valido check (precio2 is null or precio2 > 0);

alter table public.clientes add column if not exists tipo_precio smallint not null default 1;
alter table public.clientes drop constraint if exists clientes_tipo_precio_valido;
alter table public.clientes add constraint clientes_tipo_precio_valido check (tipo_precio in (1, 2));
alter table public.clientes add column if not exists descuento numeric(5,2) not null default 0;
alter table public.clientes drop constraint if exists clientes_descuento_valido;
alter table public.clientes add constraint clientes_descuento_valido check (descuento >= 0 and descuento <= 50);
grant insert (tipo_precio, descuento) on public.clientes to authenticated;
grant update (tipo_precio, descuento) on public.clientes to authenticated;

-- la vista de clientes de crédito trae también su precio y descuento
create or replace view public.v_clientes_credito with (security_invoker = true) as
select c.id, c.nombre, c.tipo_id, c.identificacion, c.telefono, c.correo, c.limite, c.plazo_dias, c.activo, c.nota,
       c.created_at, c.updated_at,
       coalesce(s.saldo, 0)    as saldo,
       coalesce(s.vencido, 0)  as vencido,
       coalesce(s.abiertas, 0) as abiertas,
       s.vence_primero,
       s.ultima_compra,
       case when c.limite is null then null else greatest(c.limite - coalesce(s.saldo, 0), 0) end as disponible,
       c.tipo_precio, c.descuento, c.exoneracion
  from public.clientes c
  left join lateral (
    select sum(greatest(p.total - p.pagado_registrado, 0)) as saldo,
           sum(greatest(p.total - p.pagado_registrado, 0))
             filter (where p.vence < (now() at time zone 'America/Costa_Rica')::date) as vencido,
           count(*) filter (where p.total - p.pagado_registrado > 0) as abiertas,
           min(p.vence) filter (where p.total - p.pagado_registrado > 0) as vence_primero,
           max(p.created_at) as ultima_compra
      from public.pedidos p
     where p.cliente_id = c.id and p.credito and p.estado <> 'anulada'
  ) s on true;
revoke all on public.v_clientes_credito from anon, authenticated;
grant select on public.v_clientes_credito to authenticated;

-- el precio 2 también es precio: solo quien tiene permiso de "precios" lo pone o cambia
create or replace function public.permiso_precios()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.uid() is null or public.puede('precios') then return new; end if;
  if tg_op = 'INSERT' then
    if new.precio is not null or new.precio_oferta is not null or new.costo is not null or new.precio2 is not null then
      raise exception 'No tiene permiso para poner precios: deje el precio vacío y el administrador lo pone.' using errcode = '42501';
    end if;
  elsif (new.precio, new.precio_oferta, new.oferta_hasta, new.costo, new.precio2)
        is distinct from (old.precio, old.precio_oferta, old.oferta_hasta, old.costo, old.precio2) then
    raise exception 'No tiene permiso para cambiar precios.' using errcode = '42501';
  end if;
  return new;
end $$;

-- precio más bajo que se le puede cobrar a este producto en esta venta (sin permiso de "precios")
create or replace function public.precio_minimo_venta(p_producto bigint, p_pedido bigint)
returns numeric language plpgsql stable security definer set search_path = '' as $$
declare pr record; v_min numeric; c record; v_exo jsonb; t numeric; pts numeric;
begin
  select precio, precio2, precio_oferta, oferta_hasta, cabys, iva_codigo into pr from public.productos where id = p_producto;
  if pr.precio is null then return null; end if;
  v_min := case when pr.precio_oferta is not null and pr.oferta_hasta is not null
                     and pr.oferta_hasta >= (now() at time zone 'America/Costa_Rica')::date
                then least(pr.precio, pr.precio_oferta) else pr.precio end;
  select cl.tipo_precio, cl.descuento into c
    from public.pedidos pe join public.clientes cl on cl.id = pe.cliente_id where pe.id = p_pedido;
  if c.tipo_precio = 2 and pr.precio2 is not null then v_min := least(v_min, pr.precio2); end if;
  if coalesce(c.descuento, 0) > 0 then v_min := v_min * (1 - c.descuento / 100); end if;
  select exoneracion into v_exo from public.pedidos where id = p_pedido;
  if jsonb_typeof(v_exo) = 'object'
     and (jsonb_typeof(v_exo->'cabys') is distinct from 'array' or jsonb_array_length(v_exo->'cabys') = 0
          or (pr.cabys is not null and (v_exo->'cabys') ? pr.cabys)) then
    t := case coalesce(pr.iva_codigo, '08') when '02' then 1 when '03' then 2 when '04' then 4 when '06' then 4
                                            when '07' then 8 when '08' then 13 when '09' then 0.5 else 0 end;
    pts := least(coalesce((v_exo->>'porcentaje')::numeric, 0), t);
    if t > 0 and pts > 0 then v_min := v_min / (1 + t / 100) * (1 + (t - pts) / 100); end if;
  end if;
  return round(v_min, 2) - 0.01;          -- un céntimo de holgura por redondeos
end $$;
revoke all on function public.precio_minimo_venta(bigint, bigint) from public, anon, authenticated;

create or replace function public.permiso_precio_venta()
returns trigger language plpgsql set search_path = '' as $$
declare v_min numeric;
begin
  if auth.uid() is null or new.producto_id is null or public.puede('precios') then return new; end if;
  if tg_op = 'UPDATE' and new.precio_unit is not distinct from old.precio_unit
     and new.producto_id is not distinct from old.producto_id then return new; end if;
  v_min := public.precio_minimo_venta(new.producto_id, new.pedido_id);
  if v_min is not null and new.precio_unit < v_min then
    raise exception 'No tiene permiso para bajar precios: % va a ₡%.', new.descripcion, trim(trailing '.' from to_char(v_min + 0.01, 'FM999999999990.99'))
      using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public.registrar_venta_sin_internet(p_id uuid, p_venta jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id     bigint;
  v_codigo text;
  v_fecha  timestamptz;
  v_dia    date;
  it       jsonb;
  pg       jsonb;
  c        record;
  v_cli    bigint;
  v_vence  date;
  v_saldo  numeric;
  v_total  numeric;
  v_avisos text[] := '{}';
  v_fac    jsonb;
  v_exo    jsonb;
  v_cli0   bigint;
begin
  if not public.puede('ventas') then
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
  if p_venta ? 'credito' and jsonb_typeof(p_venta->'credito') = 'object' and not public.puede('credito') then
    raise exception 'No tiene permiso para vender a crédito.' using errcode = '42501';
  end if;

  -- la fecha real de la venta (cuando se hizo sin internet), nunca futura ni de hace más de 30 días
  begin
    v_fecha := (p_venta->>'fecha')::timestamptz;
  exception when others then
    v_fecha := null;
  end;
  v_fecha := least(now(), greatest(coalesce(v_fecha, now()), now() - interval '30 days'));
  v_dia := (v_fecha at time zone 'America/Costa_Rica')::date;

  -- v24: el cliente (crédito) y la exoneración van desde el principio: de ellos depende el precio permitido de cada renglón
  -- (con internet el panel manda "cliente_precio" y pone el crédito después, con su revisión del límite)
  v_cli0 := (select x.id from public.clientes x
              where x.id = coalesce(nullif(p_venta->>'cliente_precio', ''), nullif(p_venta->'credito'->>'cliente_id', ''))::bigint);
  v_exo := p_venta->'exoneracion';
  if jsonb_typeof(v_exo) = 'object' then
    perform public._exoneracion_valida(v_exo);
    if (v_exo->>'vence')::date < v_dia then
      raise exception 'La exoneración de esta venta ya venció.' using errcode = 'P0001';
    end if;
  else
    v_exo := null;
  end if;

  insert into public.pedidos (cliente_nombre, cliente_telefono, nota, origen, revisado, offline_id, created_at, cliente_id, exoneracion)
  values (
    left(trim(p_venta->>'cliente_nombre'), 80),
    nullif(trim(coalesce(p_venta->>'cliente_telefono', '')), ''),
    nullif(left(trim(coalesce(p_venta->>'nota', '')), 500), ''),
    'panel', true, p_id, v_fecha, v_cli0, v_exo)
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
  select coalesce(sum(subtotal), 0) into v_total from public.pedido_items where pedido_id = v_id;

  -- a crédito: con el plazo del cliente desde el día de la venta
  if jsonb_typeof(p_venta->'credito') = 'object' then
    v_cli := nullif(p_venta->'credito'->>'cliente_id', '')::bigint;
    select * into c from public.clientes where id = v_cli;
    if c.id is null then
      raise exception 'El cliente de crédito de esta venta ya no existe. Ábrala y escoja otro (o pásela a contado).' using errcode = 'P0001';
    end if;
    begin
      v_vence := (p_venta->'credito'->>'vence')::date;
    exception when others then
      v_vence := null;
    end;
    if v_vence is null or v_vence < v_dia or v_vence > v_dia + 400 then v_vence := v_dia + c.plazo_dias; end if;
    if not c.activo then v_avisos := array_append(v_avisos, format('El crédito de %s estaba desactivado.', c.nombre)::text); end if;
    select coalesce(sum(greatest(total - pagado_registrado, 0)), 0) into v_saldo
      from public.pedidos where cliente_id = c.id and credito and estado <> 'anulada';
    if c.limite is not null and v_saldo + v_total > c.limite then
      v_avisos := array_append(v_avisos, format('Con esta venta %s pasa su límite de crédito (₡%s).', c.nombre, public._colones(c.limite))::text);
    end if;
    update public.pedidos set credito = true, cliente_id = c.id, vence = v_vence where id = v_id;
  elsif nullif(p_venta->>'apartado_vence', '') is not null then
    begin
      v_vence := (p_venta->>'apartado_vence')::date;
    exception when others then
      v_vence := null;
    end;
    if v_vence is null or v_vence < v_dia or v_vence > v_dia + 365 then
      v_avisos := array_append(v_avisos, 'La fecha del apartado no era válida: quedó de contado. Póngale el apartado otra vez.'::text);
    elsif char_length(coalesce(p_venta->>'cliente_telefono', '')) < 8 then
      v_avisos := array_append(v_avisos, 'El apartado no tenía teléfono: quedó de contado. Póngale el teléfono y el apartado otra vez.'::text);
    else
      perform set_config('lc.bitacora_origen', 'apartado', true);
      update public.pedidos set apartado = true, apartado_vence = v_vence where id = v_id;
    end if;
  end if;

  -- datos del cliente para la factura electrónica
  v_fac := p_venta->'factura';
  if jsonb_typeof(v_fac) = 'object' then
    begin
      insert into public.facturas (pedido_id, tipo_id, identificacion, nombre, correo, estado, solicitada_por)
      values (v_id, v_fac->>'tipo_id', regexp_replace(coalesce(v_fac->>'identificacion', ''), '\D', '', 'g'),
              left(trim(v_fac->>'nombre'), 100), lower(trim(v_fac->>'correo')), 'pendiente', 'panel');
    exception when others then
      v_avisos := array_append(v_avisos, ('No se guardaron los datos para la factura: ' || sqlerrm)::text);
    end;
  end if;

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
  if array_length(v_avisos, 1) > 0 then
    update public.pedidos
       set nota = left(concat_ws(' · ', nota, 'Al llegar sin internet: ' || array_to_string(v_avisos, ' ')), 500)
     where id = v_id;
  end if;
  return jsonb_build_object('id', v_id, 'codigo', v_codigo, 'repetida', false, 'avisos', to_jsonb(v_avisos));
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
