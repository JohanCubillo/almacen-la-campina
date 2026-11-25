-- ============================================================
--  v26 · Devoluciones sin tener que abrir la caja
--  Correr después de v25. Se puede correr más de una vez.
--
--  Antes, una devolución en efectivo pedía la caja abierta
--  ("Primero abra la caja"). Ahora:
--   - si hay una caja abierta, el efectivo sale de esa caja (igual que antes)
--   - si no hay caja abierta, la devolución se registra igual, sin movimiento de caja
-- ============================================================

create or replace function public.registrar_devolucion(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ped record; v_id bigint; it jsonb; v_item record; v_cant numeric; v_ya numeric; v_total numeric := 0;
  v_items_total numeric; v_dev_prev numeric; v_rei_prev numeric; v_pagado numeric; v_reint numeric;
  v_metodo text := nullif(p ->> 'metodo', ''); v_motivo text := left(trim(coalesce(p ->> 'motivo', '')), 300);
  v_mov bigint; v_fe record; v_fe_activo boolean; v_ambiente text; vistos bigint[] := '{}';
  num constant text := '^[0-9]{1,10}(\.[0-9]{1,2})?$';
begin
  if not public.puede('anular') then raise exception 'No tiene permiso para hacer devoluciones.' using errcode = '42501'; end if;
  if char_length(v_motivo) < 3 then raise exception 'Escriba el motivo de la devolución.' using errcode = 'P0001'; end if;
  select id, codigo, estado, cliente_nombre into v_ped from public.pedidos where id = nullif(p ->> 'pedido_id', '')::bigint for update;
  if v_ped.id is null then raise exception 'La venta no existe.' using errcode = 'P0001'; end if;
  if v_ped.estado = 'anulada' then raise exception 'La venta está anulada.' using errcode = 'P0001'; end if;
  if jsonb_typeof(p -> 'items') <> 'array' or jsonb_array_length(p -> 'items') = 0 then
    raise exception 'Escoja qué productos devuelve.' using errcode = 'P0001';
  end if;

  -- con facturación electrónica, lo devuelto tiene que salir en una nota de crédito del comprobante aceptado
  select activo, ambiente into v_fe_activo, v_ambiente from public.fe_emisor where id = 1;
  select id, estado into v_fe from public.fe_documentos
   where pedido_id = v_ped.id and ambiente = v_ambiente and tipo in ('01','04') and estado <> 'rechazado' and not anulado
   order by id desc limit 1;
  if coalesce(v_fe_activo, false) then
    if v_fe.id is null then
      raise exception 'Primero emita el tiquete o la factura de esta venta: la devolución se hace con nota de crédito.' using errcode = 'P0001';
    end if;
    if v_fe.estado <> 'aceptado' then
      raise exception 'El comprobante de esta venta todavía no está aceptado por Hacienda. Espere y vuelva a intentar.' using errcode = 'P0001';
    end if;
  end if;

  perform set_config('lc.bitacora_origen', 'devolución', true);
  insert into public.devoluciones (pedido_id, motivo, total) values (v_ped.id, v_motivo, 0.01) returning id into v_id;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    select pi.id, pi.producto_id, pi.descripcion, pi.cantidad, pi.precio_unit into v_item
      from public.pedido_items pi where pi.id = nullif(it ->> 'pedido_item_id', '')::bigint and pi.pedido_id = v_ped.id;
    if v_item.id is null then raise exception 'Un producto no es de esta venta.' using errcode = 'P0001'; end if;
    if v_item.id = any (vistos) then raise exception 'Un producto está dos veces.' using errcode = 'P0001'; end if;
    vistos := vistos || v_item.id;
    if coalesce(it ->> 'cantidad', '') !~ num or (it ->> 'cantidad')::numeric <= 0 then
      raise exception 'Revise la cantidad que devuelve de %.', v_item.descripcion using errcode = 'P0001';
    end if;
    v_cant := (it ->> 'cantidad')::numeric;
    select coalesce(sum(di.cantidad), 0) into v_ya from public.devolucion_items di where di.pedido_item_id = v_item.id;
    if v_cant > v_item.cantidad - v_ya then
      raise exception 'De % solo se pueden devolver % (ya devolvieron %).', v_item.descripcion, v_item.cantidad - v_ya, v_ya using errcode = 'P0001';
    end if;
    insert into public.devolucion_items (devolucion_id, pedido_item_id, producto_id, descripcion, cantidad, precio_unit)
    values (v_id, v_item.id, v_item.producto_id, v_item.descripcion, v_cant, v_item.precio_unit);
    v_total := v_total + round(v_cant * v_item.precio_unit, 2);
    perform public._inv_mover(v_item.producto_id, v_cant, 'devolucion', v_ped.id, null,
                              left('Devolución · ' || v_motivo, 300), false);
  end loop;
  if v_total <= 0 then raise exception 'Lo devuelto no tiene valor.' using errcode = 'P0001'; end if;

  -- plata que se le devuelve: lo pagado que pasa del nuevo total
  select coalesce(sum(subtotal), 0) into v_items_total from public.pedido_items where pedido_id = v_ped.id;
  select coalesce(sum(total), 0), coalesce(sum(reintegro), 0) into v_dev_prev, v_rei_prev from public.devoluciones where pedido_id = v_ped.id and id <> v_id;
  select coalesce(sum(monto), 0) into v_pagado from public.pagos where pedido_id = v_ped.id and not anulado;
  v_reint := greatest(0, least(v_total, (v_pagado - v_rei_prev) - greatest(v_items_total - v_dev_prev - v_total, 0)));
  if v_reint > 0 then
    if v_metodo is null or v_metodo not in ('efectivo','sinpe','transferencia','tarjeta') then
      raise exception 'Escoja cómo le devuelve la plata al cliente.' using errcode = 'P0001';
    end if;
    -- en efectivo sale de la caja solo si hay una caja abierta (si no, la devolución igual se registra)
    if v_metodo = 'efectivo' and public.puede('caja')
       and exists (select 1 from public.caja_turnos where estado = 'abierta') then
      v_mov := public.mover_caja('salida', v_reint, left('Devolución de la venta ' || v_ped.codigo || ' · ' || v_motivo, 200));
    end if;
  else
    v_metodo := null;
  end if;
  update public.devoluciones set total = v_total, reintegro = v_reint, metodo = v_metodo, caja_mov_id = v_mov where id = v_id;
  perform public.recalcular_pedido(v_ped.id);
  return jsonb_build_object('id', v_id, 'total', v_total, 'reintegro', v_reint, 'metodo', v_metodo,
                            'fe_documento_id', case when coalesce(v_fe_activo, false) then v_fe.id end);
end $$;
revoke all on function public.registrar_devolucion(jsonb) from public, anon;
grant execute on function public.registrar_devolucion(jsonb) to authenticated;
