-- =====================================================================
-- ALMACÉN LA CAMPIÑA · v18 · CHEQUE, SALDOS DE MORIAH Y APARTADOS
-- Corra este archivo DESPUÉS de v17_permisos.sql.
-- Se puede correr las veces que quiera.
--
-- 1. CHEQUE como forma de pago (con su número), en ventas, abonos, caja,
--    reportes y factura electrónica.
-- 2. "ABONADO EN MORIAH": para pasar lo que un cliente ya había pagado en
--    Moriah (por ejemplo, de un apartado). No cuenta en la caja de hoy ni en
--    los reportes de cobros. Solo el administrador lo puede usar.
-- 3. SALDOS ANTERIORES DE CRÉDITO: cada deuda que viene de Moriah entra como
--    una venta a crédito de "saldo anterior" (sin productos, no mueve
--    inventario, no cuenta como venta del mes ni en reportes), así los abonos
--    la pagan igual que a las demás. Se cargan a mano o desde el Excel.
-- 4. APARTADOS: el cliente escoge, va pagando y se lo lleva al terminar de
--    pagar. La mercadería queda rebajada del inventario (reservada) desde que
--    se aparta. No se puede entregar hasta que esté pagado completo.
-- =====================================================================

do $$
begin
  if to_regprocedure('public.puede(text)') is null then
    raise exception 'Primero corra v17_permisos.sql.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1 y 2. Formas de pago: cheque y "abonado en Moriah"
-- ---------------------------------------------------------------------
alter table public.pagos drop constraint if exists pagos_metodo_check;
alter table public.pagos add constraint pagos_metodo_check
  check (metodo in ('sinpe','efectivo','tarjeta','transferencia','cheque','anterior'));
alter table public.pagos drop constraint if exists sinpe_con_referencia;
alter table public.pagos add constraint sinpe_con_referencia
  check (metodo not in ('sinpe','transferencia','cheque') or referencia is not null or abono_id is not null);

alter table public.abonos drop constraint if exists abonos_metodo_check;
alter table public.abonos add constraint abonos_metodo_check
  check (metodo in ('sinpe','efectivo','tarjeta','transferencia','cheque'));
alter table public.abonos drop constraint if exists abono_con_referencia;
alter table public.abonos add constraint abono_con_referencia
  check (metodo not in ('sinpe','transferencia','cheque') or referencia is not null);

-- "Abonado en Moriah": solo el administrador, y queda verificado
create or replace function public.pago_anterior()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.metodo = 'anterior' then
    if auth.uid() is not null and not public.is_admin() then
      raise exception 'Solo el administrador puede anotar lo abonado en Moriah.' using errcode = '42501';
    end if;
    new.verificado := true;
  end if;
  return new;
end $$;
drop trigger if exists trg_pago_anterior on public.pagos;
create trigger trg_pago_anterior before insert on public.pagos
  for each row execute function public.pago_anterior();

-- registrar_abono acepta cheque (se cambia solo la lista de métodos y el aviso del número)
do $$
declare f record; def text;
begin
  for f in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
           where s.nspname = 'public' and p.proname = 'registrar_abono' loop
    def := pg_get_functiondef(f.oid);
    if position('''cheque''' in def) > 0 then continue; end if;
    def := replace(def, $r$v_metodo not in ('sinpe','efectivo','tarjeta','transferencia')$r$,
                        $r$v_metodo not in ('sinpe','efectivo','tarjeta','transferencia','cheque')$r$);
    def := replace(def, $r$if v_metodo in ('sinpe','transferencia') and v_ref is null then$r$,
                        $r$if v_metodo in ('sinpe','transferencia','cheque') and v_ref is null then$r$);
    def := replace(def, $r$case v_metodo when 'sinpe' then 'SINPE' else 'depósito' end$r$,
                        $r$case v_metodo when 'sinpe' then 'SINPE' when 'cheque' then 'cheque' else 'depósito' end$r$);
    execute def;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3 y 4. Columnas nuevas de las ventas
-- ---------------------------------------------------------------------
alter table public.pedidos add column if not exists saldo_inicial  boolean not null default false;
alter table public.pedidos add column if not exists ref_anterior   text check (char_length(ref_anterior) <= 60);
alter table public.pedidos add column if not exists apartado       boolean not null default false;
alter table public.pedidos add column if not exists apartado_vence date;

alter table public.pedidos drop constraint if exists pedido_apartado_valido;
alter table public.pedidos add constraint pedido_apartado_valido
  check (not apartado or (not credito and apartado_vence is not null));
alter table public.pedidos drop constraint if exists pedido_saldo_inicial_valido;
alter table public.pedidos add constraint pedido_saldo_inicial_valido
  check (not saldo_inicial or (credito and not apartado));

create unique index if not exists pedidos_saldo_anterior_unico
  on public.pedidos (cliente_id, ref_anterior) where saldo_inicial;
create index if not exists pedidos_apartados on public.pedidos (apartado_vence) where apartado and estado = 'abierta';

-- Reglas: el saldo anterior solo lo pone la importación; el apartado se entrega pagado
create or replace function public.reglas_apartado_saldo()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.saldo_inicial and (tg_op = 'INSERT' or not old.saldo_inicial)
     and coalesce(current_setting('lc.saldo_anterior', true), '') <> '1' then
    raise exception 'Los saldos anteriores solo se cargan desde Crédito → Pasar saldos de Moriah.' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.saldo_inicial and not new.saldo_inicial then
    raise exception 'Un saldo anterior no se convierte en venta normal.' using errcode = 'P0001';
  end if;
  if new.apartado and new.estado = 'entregada' and (tg_op = 'INSERT' or old.estado <> 'entregada')
     and coalesce(new.pagado_verificado, 0) < coalesce(new.total, 0) then
    raise exception 'Este apartado no está pagado completo (falta ₡%). Se entrega cuando termine de pagar.',
      trim(trailing '.' from to_char(new.total - coalesce(new.pagado_verificado, 0), 'FM999999999990.99')) using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_reglas_apartado_saldo on public.pedidos;
create trigger trg_reglas_apartado_saldo before insert or update on public.pedidos
  for each row execute function public.reglas_apartado_saldo();

-- ---------------------------------------------------------------------
-- 3. Pasar saldos anteriores de crédito (uno o muchos, desde el Excel)
-- p_filas = [{"cliente_id"?, "nombre", "identificacion"?, "telefono"?, "limite"?, "plazo_dias"?,
--             "monto", "vence"?, "fecha"?, "documento"?}, ...]
-- Si la misma deuda (cliente + documento, o cliente + vence + monto) ya estaba, no se repite.
-- ---------------------------------------------------------------------
create or replace function public.importar_saldos_anteriores(p_filas jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  e jsonb; i int := 0;
  v_cli bigint; v_nombre text; v_id text; v_tipo text; v_tel text; v_lim numeric; v_plazo int;
  v_monto numeric; v_vence date; v_fecha date; v_doc text; v_ref text; v_ped bigint;
  creados int := 0; repetidos int := 0; clientes_nuevos int := 0; errores jsonb := '[]'::jsonb;
  hoy date := (now() at time zone 'America/Costa_Rica')::date;
begin
  if not public.is_admin() then raise exception 'Solo el administrador pasa saldos de Moriah.' using errcode = '42501'; end if;
  if p_filas is null or jsonb_typeof(p_filas) <> 'array' then raise exception 'No vienen datos.' using errcode = 'P0001'; end if;
  if jsonb_array_length(p_filas) > 3000 then raise exception 'Máximo 3000 saldos por vez.' using errcode = 'P0001'; end if;
  perform set_config('lc.saldo_anterior', '1', true);
  perform set_config('lc.bitacora_origen', 'saldos de Moriah', true);   -- así sale en la bitácora

  for e in select * from jsonb_array_elements(p_filas) loop
    i := i + 1;
    begin
      v_nombre := nullif(left(regexp_replace(btrim(coalesce(e ->> 'nombre', '')), '\s+', ' ', 'g'), 80), '');
      v_id := nullif(regexp_replace(coalesce(e ->> 'identificacion', ''), '[^0-9]', '', 'g'), '');
      if v_id is not null and v_id !~ '^[0-9]{9,12}$' then v_id := null; end if;
      v_tipo := case when v_id is null then null when length(v_id) = 9 then 'fisica'
                     when length(v_id) = 10 then 'juridica' else 'dimex' end;
      v_tel := nullif(btrim(coalesce(e ->> 'telefono', '')), '');
      if v_tel is not null and v_tel !~ '^[0-9 +()-]{8,20}$' then v_tel := null; end if;
      v_lim := case when coalesce(e ->> 'limite', '') ~ '^[0-9]{1,10}(\.[0-9]{1,2})?$' then (e ->> 'limite')::numeric end;
      v_plazo := case when coalesce(e ->> 'plazo_dias', '') ~ '^[0-9]{1,3}$' and (e ->> 'plazo_dias')::int between 1 and 365
                      then (e ->> 'plazo_dias')::int end;
      if coalesce(e ->> 'monto', '') !~ '^[0-9]{1,8}(\.[0-9]{1,2})?$' then
        raise exception 'El saldo no es un número válido.';
      end if;
      v_monto := (e ->> 'monto')::numeric;
      if v_monto <= 0 then raise exception 'El saldo debe ser mayor que cero.'; end if;
      if v_monto > 50000000 then raise exception 'El saldo es demasiado grande.'; end if;
      v_fecha := case when coalesce(e ->> 'fecha', '') ~ '^\d{4}-\d{2}-\d{2}$' then (e ->> 'fecha')::date end;
      v_vence := case when coalesce(e ->> 'vence', '') ~ '^\d{4}-\d{2}-\d{2}$' then (e ->> 'vence')::date end;
      v_doc := nullif(left(btrim(coalesce(e ->> 'documento', '')), 40), '');

      -- el cliente: por id, por cédula, por nombre exacto; si no está, se crea
      v_cli := null;
      if coalesce(e ->> 'cliente_id', '') ~ '^[0-9]+$' then
        select id into v_cli from public.clientes where id = (e ->> 'cliente_id')::bigint;
      end if;
      if v_cli is null and v_id is not null then
        select id into v_cli from public.clientes where identificacion = v_id order by id limit 1;
      end if;
      if v_cli is null and v_nombre is not null then
        select id into v_cli from public.clientes where lower(nombre) = lower(v_nombre) order by id limit 1;
      end if;
      if v_cli is null then
        if v_nombre is null or char_length(v_nombre) < 2 then raise exception 'Falta el nombre del cliente.'; end if;
        insert into public.clientes (nombre, tipo_id, identificacion, telefono, limite, plazo_dias)
        values (v_nombre, v_tipo, v_id, v_tel, v_lim, coalesce(v_plazo, 30))
        returning id into v_cli;
        clientes_nuevos := clientes_nuevos + 1;
      end if;
      select nombre, telefono, coalesce(v_plazo, plazo_dias) into v_nombre, v_tel, v_plazo from public.clientes where id = v_cli;
      v_vence := coalesce(v_vence, coalesce(v_fecha, hoy) + v_plazo);

      v_ref := coalesce(v_doc, to_char(v_vence, 'YYYY-MM-DD') || ' ' || trim(trailing '.' from to_char(v_monto, 'FM99999999990.99')));
      if exists (select 1 from public.pedidos where saldo_inicial and cliente_id = v_cli and ref_anterior = v_ref) then
        repetidos := repetidos + 1;
        continue;
      end if;

      -- con la fecha del documento de Moriah, para que el estado de cuenta quede en orden
      insert into public.pedidos (cliente_nombre, cliente_telefono, cliente_id, credito, vence, saldo_inicial, ref_anterior, created_at, nota)
      values (left(v_nombre, 80), v_tel, v_cli, true, v_vence, true, v_ref,
              coalesce((least(v_fecha, hoy) + time '12:00') at time zone 'America/Costa_Rica', now()),
              'Saldo anterior de Moriah' || coalesce(' · doc. ' || v_doc, '') || coalesce(' · del ' || to_char(v_fecha, 'DD/MM/YYYY'), ''))
      returning id into v_ped;
      insert into public.pedido_items (pedido_id, descripcion, cantidad, precio_unit)
      values (v_ped, left('Saldo anterior de Moriah' || coalesce(' (doc. ' || v_doc || ')', ''), 200), 1, v_monto);
      update public.pedidos set estado = 'entregada', revisado = true where id = v_ped;
      creados := creados + 1;
    exception when others then
      errores := errores || jsonb_build_object('fila', i, 'error', sqlerrm);
    end;
  end loop;

  perform set_config('lc.saldo_anterior', '', true);
  return jsonb_build_object('creados', creados, 'repetidos', repetidos, 'clientes_nuevos', clientes_nuevos, 'errores', errores);
end $$;
revoke all on function public.importar_saldos_anteriores(jsonb) from public, anon;
grant execute on function public.importar_saldos_anteriores(jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Caja y reportes: cheque aparte; saldos anteriores y "abonado en Moriah" no cuentan
-- (mismas funciones de v14 y v4, con el permiso de v17 ya puesto)
-- ---------------------------------------------------------------------
create or replace function public.resumen_caja(p_turno bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  t record; v_hasta timestamptz; v_pagos jsonb; v_ventas jsonb; v_mov jsonb;
  v_efectivo numeric; v_entradas numeric; v_salidas numeric;
begin
  if not (public.puede('caja') or public.puede('reportes')) then raise exception 'No tiene permiso para esto.' using errcode = '42501'; end if;
  select * into t from public.caja_turnos where id = p_turno;
  if t.id is null then raise exception 'Ese turno de caja no existe.' using errcode = 'P0001'; end if;
  if t.estado = 'cerrada' and t.resumen is not null then return t.resumen; end if;   -- lo congelado no cambia
  v_hasta := coalesce(t.cerrada_at, now());

  -- pagos recibidos en el turno (fecha del pago), sin anulados ni lo abonado en Moriah
  select jsonb_build_object(
           'efectivo',            coalesce(sum(monto) filter (where metodo = 'efectivo'), 0),
           'sinpe',               coalesce(sum(monto) filter (where metodo = 'sinpe'), 0),
           'sinpe_sin_verificar', coalesce(sum(monto) filter (where metodo = 'sinpe' and not verificado), 0),
           'tarjeta',             coalesce(sum(monto) filter (where metodo = 'tarjeta'), 0),
           'transferencia',       coalesce(sum(monto) filter (where metodo = 'transferencia'), 0),
           'cheque',              coalesce(sum(monto) filter (where metodo = 'cheque'), 0),
           'cheques',             count(*) filter (where metodo = 'cheque'),
           'abonos_credito',      coalesce(sum(monto) filter (where abono_id is not null), 0),
           'cantidad',            count(*),
           'total',               coalesce(sum(monto), 0)),
         coalesce(sum(monto) filter (where metodo = 'efectivo'), 0)
    into v_pagos, v_efectivo
    from public.pagos
   where not anulado and metodo <> 'anterior' and fecha >= t.abierta_at and fecha < v_hasta;

  -- ventas hechas en el turno (sin los saldos anteriores de Moriah)
  select jsonb_build_object(
           'cantidad',  count(*) filter (where estado <> 'anulada'),
           'total',     coalesce(sum(total) filter (where estado <> 'anulada'), 0),
           'a_credito', coalesce(sum(total) filter (where estado <> 'anulada' and credito), 0),
           'de_contado',coalesce(sum(total) filter (where estado <> 'anulada' and not credito and not apartado), 0),
           'apartados', coalesce(sum(total) filter (where estado <> 'anulada' and apartado), 0),
           'anuladas',  count(*) filter (where estado = 'anulada'),
           'web',       count(*) filter (where estado <> 'anulada' and origen = 'web'))
    into v_ventas
    from public.pedidos
   where not saldo_inicial and created_at >= t.abierta_at and created_at < v_hasta;

  select coalesce(sum(monto) filter (where tipo = 'entrada'), 0), coalesce(sum(monto) filter (where tipo = 'salida'), 0),
         coalesce(jsonb_agg(jsonb_build_object('tipo', tipo, 'monto', monto, 'motivo', motivo, 'fecha', created_at) order by created_at), '[]'::jsonb)
    into v_entradas, v_salidas, v_mov
    from public.caja_movimientos where turno_id = t.id;

  return jsonb_build_object(
    'turno', t.id, 'abierta_at', t.abierta_at, 'hasta', v_hasta, 'fondo', t.fondo,
    'ventas', v_ventas, 'pagos', v_pagos,
    'entradas', v_entradas, 'salidas', v_salidas, 'movimientos', v_mov,
    'efectivo_esperado', t.fondo + v_efectivo + v_entradas - v_salidas);
end $$;
revoke all on function public.resumen_caja(bigint) from public, anon;
grant execute on function public.resumen_caja(bigint) to authenticated;

create or replace function public.reporte_ventas(p_desde date, p_hasta date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare d date := least(p_desde, p_hasta); h date := greatest(p_desde, p_hasta); r jsonb;
begin
  if not public.puede('reportes') then raise exception 'No autorizado.' using errcode = '42501'; end if;
  if h - d > 800 then raise exception 'Escoja un periodo de máximo dos años.' using errcode = 'P0001'; end if;

  with v as (
    select p.* from public.pedidos p
     where p.estado <> 'anulada' and not p.saldo_inicial
       and (p.created_at at time zone 'America/Costa_Rica')::date between d and h
  ),
  meses as (
    select to_char(date_trunc('month', (p.created_at at time zone 'America/Costa_Rica')), 'YYYY-MM') as mes,
           count(*) as ventas, coalesce(sum(p.total), 0) as total, coalesce(sum(p.pagado_verificado), 0) as cobrado
      from public.pedidos p
     where p.estado <> 'anulada' and not p.saldo_inicial
       and p.created_at >= (date_trunc('month', now() at time zone 'America/Costa_Rica') - interval '11 months') at time zone 'America/Costa_Rica'
     group by 1
  ),
  top as (
    select coalesce(pr.nombre, i.descripcion) as nombre, sum(i.cantidad) as cantidad, sum(i.subtotal) as monto
      from public.pedido_items i join v on v.id = i.pedido_id
      left join public.productos pr on pr.id = i.producto_id
     where i.descripcion not like 'Envío a domicilio:%'
     group by 1
  )
  select jsonb_build_object(
    'desde', d, 'hasta', h,
    'ventas', (select count(*) from v),
    'total', (select coalesce(sum(total), 0) from v),
    'cobrado', (select coalesce(sum(pagado_verificado), 0) from v),
    'por_cobrar', (select coalesce(sum(greatest(total - pagado_verificado, 0)), 0) from v),
    'web', (select jsonb_build_object('ventas', count(*), 'total', coalesce(sum(total), 0)) from v where origen = 'web'),
    'panel', (select jsonb_build_object('ventas', count(*), 'total', coalesce(sum(total), 0)) from v where origen = 'panel'),
    'envios', (select count(*) from v where entrega = 'envio'),
    'meses', coalesce((select jsonb_agg(jsonb_build_object('mes', mes, 'ventas', ventas, 'total', total, 'cobrado', cobrado) order by mes) from meses), '[]'::jsonb),
    'top_monto', coalesce((select jsonb_agg(t) from (select nombre, cantidad, monto from top where monto > 0 order by monto desc limit 10) t), '[]'::jsonb),
    'top_cantidad', coalesce((select jsonb_agg(t) from (select nombre, cantidad, monto from top order by cantidad desc limit 10) t), '[]'::jsonb),
    'metodos', coalesce((select jsonb_agg(jsonb_build_object('metodo', metodo, 'total', s) order by s desc) from (
        select pg.metodo, sum(pg.monto) as s from public.pagos pg
         where not pg.anulado and pg.metodo <> 'anterior' and (pg.fecha at time zone 'America/Costa_Rica')::date between d and h
         group by pg.metodo) m), '[]'::jsonb)
  ) into r;
  return r;
end $$;
revoke all on function public.reporte_ventas(date, date) from public, anon;
grant execute on function public.reporte_ventas(date, date) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Marcar o quitar "apartado" en una venta abierta (con fecha límite para pagar)
-- ---------------------------------------------------------------------
create or replace function public.poner_apartado(p_pedido bigint, p_apartado boolean, p_vence date default null)
returns void language plpgsql security definer set search_path = '' as $$
declare p record; hoy date := (now() at time zone 'America/Costa_Rica')::date;
begin
  if not public.puede('ventas') then raise exception 'No tiene permiso para esto.' using errcode = '42501'; end if;
  select * into p from public.pedidos where id = p_pedido for update;
  if p.id is null then raise exception 'Esa venta no existe.' using errcode = 'P0001'; end if;
  if p.estado <> 'abierta' then raise exception 'Solo una venta abierta se puede apartar o dejar de apartar.' using errcode = 'P0001'; end if;
  if p.saldo_inicial then raise exception 'Un saldo anterior no se aparta.' using errcode = 'P0001'; end if;
  perform set_config('lc.bitacora_origen', 'apartado', true);
  if p_apartado then
    if p.credito then raise exception 'Una venta a crédito no puede ser apartado. Quítele el crédito primero.' using errcode = 'P0001'; end if;
    if p_vence is null or p_vence < hoy or p_vence > hoy + 365 then
      raise exception 'Ponga hasta qué fecha tiene para pagar el apartado (máximo un año).' using errcode = 'P0001';
    end if;
    if char_length(coalesce(p.cliente_telefono, '')) < 8 then
      raise exception 'Para un apartado anote el teléfono del cliente.' using errcode = 'P0001';
    end if;
    update public.pedidos set apartado = true, apartado_vence = p_vence where id = p_pedido;
  else
    update public.pedidos set apartado = false, apartado_vence = null where id = p_pedido;
  end if;
end $$;
revoke all on function public.poner_apartado(bigint, boolean, date) from public, anon;
grant execute on function public.poner_apartado(bigint, boolean, date) to authenticated;

-- poner_credito no debe convertir un apartado en crédito (se quita el apartado primero)
do $$
declare f record; def text;
begin
  for f in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
           where s.nspname = 'public' and p.proname = 'poner_credito' loop
    def := pg_get_functiondef(f.oid);
    if position('apartado' in def) > 0 then continue; end if;
    -- el chequeo de la base (pedido_apartado_valido) ya lo impide; aquí solo se da un mensaje claro
    def := regexp_replace(def, '(\nbegin\n)', E'\\1  if p_cliente is not null and exists (select 1 from public.pedidos where id = p_pedido and apartado) then\n    raise exception ''Esta venta es un apartado: quítele el apartado antes de pasarla a crédito.'' using errcode = ''P0001'';\n  end if;\n');
    execute def;
  end loop;
end $$;
