-- =====================================================================
-- ALMACÉN LA CAMPIÑA · v19 · TRABAJAR SIN INTERNET
-- Corra este archivo DESPUÉS de v18_cheque_saldos_apartados.sql.
-- Se puede correr las veces que quiera.
--
-- Sin internet la compu de la caja sigue trabajando y guarda todo; cuando
-- vuelve la señal lo manda en orden. Aquí está lo que la base necesita:
--
-- 1. VENTAS HECHAS SIN INTERNET que llegan a crédito, como apartado o con
--    los datos para factura (todo junto, en una sola operación).
-- 2. CAJA: abrir, entradas/salidas y cerrar con la hora real en que se
--    hicieron (aunque lleguen después).
-- 3. NADA SE REPITE: lo que se mandó y no llegó la respuesta se puede mandar
--    otra vez sin duplicar (pagos, abonos y caja llevan su número de envío).
-- 4. COMPROBANTES ELECTRÓNICOS SIN INTERNET (situación 3 de Hacienda):
--    cada compu tiene su propia terminal y se le reservan números por
--    adelantado, así la clave de 50 dígitos se arma en la compu en el
--    momento de la venta y nunca choca con otra. La función "facturar" los
--    firma y los manda cuando vuelve la conexión.
-- =====================================================================

do $$
begin
  if to_regprocedure('public.poner_apartado(bigint,boolean,date)') is null then
    raise exception 'Primero corra v18_cheque_saldos_apartados.sql.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Ventas hechas sin internet
-- ---------------------------------------------------------------------
-- Además de productos y pagos, una venta puede llegar con:
--   "credito":  { "cliente_id": 12, "vence": "2026-12-24" }   (vence es opcional: fecha + plazo)
--   "apartado_vence": "2026-12-24"
--   "factura":  { "tipo_id": "fisica", "identificacion": "...", "nombre": "...", "correo": "..." }
-- Lo que ya se revisó en la compu no se rechaza al llegar (la venta ya se hizo):
-- si algo cambió mientras tanto (pasó el límite, el cliente se desactivó), la venta
-- entra igual y se devuelve un aviso que queda en la nota.
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

-- ---------------------------------------------------------------------
-- 2. Caja con la hora real (para lo que se hizo sin internet)
--    p_cuando: cuándo se hizo de verdad (nunca en el futuro ni de hace más de 7 días)
--    p_id:     número de envío; si ya llegó, no se hace otra vez
-- ---------------------------------------------------------------------
alter table public.caja_turnos add column if not exists offline_id uuid;
alter table public.caja_turnos add column if not exists cierre_id uuid;
alter table public.caja_movimientos add column if not exists offline_id uuid;
create unique index if not exists caja_turnos_offline_unico on public.caja_turnos (offline_id) where offline_id is not null;
create unique index if not exists caja_turnos_cierre_unico on public.caja_turnos (cierre_id) where cierre_id is not null;
create unique index if not exists caja_movimientos_offline_unico on public.caja_movimientos (offline_id) where offline_id is not null;

drop function if exists public.abrir_caja(numeric);
drop function if exists public.mover_caja(text, numeric, text);
drop function if exists public.cerrar_caja(bigint, numeric, jsonb, text);
drop function if exists public.abrir_caja(numeric, timestamptz);
drop function if exists public.mover_caja(text, numeric, text, timestamptz);
drop function if exists public.cerrar_caja(bigint, numeric, jsonb, text, timestamptz);

create or replace function public.abrir_caja(p_fondo numeric, p_cuando timestamptz default null, p_id uuid default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint; v_cuando timestamptz;
begin
  if not public.puede('caja') then raise exception 'No tiene permiso para esto.' using errcode = '42501'; end if;
  if p_id is not null then
    select id into v_id from public.caja_turnos where offline_id = p_id;
    if v_id is not null then return v_id; end if;
  end if;
  if p_fondo is null or p_fondo < 0 or p_fondo > 10000000 then raise exception 'Revise el fondo de caja.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.caja_turnos where estado = 'abierta') then
    raise exception 'Ya hay una caja abierta. Ciérrela antes de abrir otra.' using errcode = 'P0001';
  end if;
  v_cuando := least(now(), greatest(coalesce(p_cuando, now()), now() - interval '7 days',
                                    coalesce((select max(cerrada_at) from public.caja_turnos), '-infinity')));
  insert into public.caja_turnos (fondo, abierta_at, offline_id) values (round(p_fondo, 2), v_cuando, p_id) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'Ya hay una caja abierta. Ciérrela antes de abrir otra.' using errcode = 'P0001';
end $$;
revoke all on function public.abrir_caja(numeric, timestamptz, uuid) from public, anon;
grant execute on function public.abrir_caja(numeric, timestamptz, uuid) to authenticated;

create or replace function public.mover_caja(p_tipo text, p_monto numeric, p_motivo text, p_cuando timestamptz default null, p_id uuid default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare t record; v_id bigint; v_motivo text := left(trim(coalesce(p_motivo, '')), 200);
begin
  if not public.puede('caja') then raise exception 'No tiene permiso para esto.' using errcode = '42501'; end if;
  if p_id is not null then
    select id into v_id from public.caja_movimientos where offline_id = p_id;
    if v_id is not null then return v_id; end if;
  end if;
  if p_tipo not in ('entrada','salida') then raise exception 'Tipo no válido.' using errcode = 'P0001'; end if;
  if p_monto is null or p_monto <= 0 or p_monto > 10000000 then raise exception 'Revise el monto.' using errcode = 'P0001'; end if;
  if char_length(v_motivo) < 3 then raise exception 'Escriba el motivo.' using errcode = 'P0001'; end if;
  select id, abierta_at into t from public.caja_turnos where estado = 'abierta';
  if t.id is null then raise exception 'Primero abra la caja.' using errcode = 'P0001'; end if;
  insert into public.caja_movimientos (turno_id, tipo, monto, motivo, created_at, offline_id)
  values (t.id, p_tipo, round(p_monto, 2), v_motivo, least(now(), greatest(coalesce(p_cuando, now()), t.abierta_at)), p_id)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.mover_caja(text, numeric, text, timestamptz, uuid) from public, anon;
grant execute on function public.mover_caja(text, numeric, text, timestamptz, uuid) to authenticated;

-- p_turno vacío = la caja que esté abierta (cuando se abrió sin internet todavía no tenía número)
create or replace function public.cerrar_caja(p_turno bigint, p_contado numeric, p_conteo jsonb default null, p_nota text default null,
                                              p_cuando timestamptz default null, p_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t record; v_res jsonb; v_esperado numeric; v_ahora timestamptz;
begin
  if not public.puede('caja') then raise exception 'No tiene permiso para esto.' using errcode = '42501'; end if;
  if p_id is not null then
    select * into t from public.caja_turnos where cierre_id = p_id;
    if t.id is not null then
      return t.resumen || jsonb_build_object('turno', t.id, 'efectivo_contado', t.efectivo_contado, 'diferencia', t.diferencia,
                                             'cerrada_at', t.cerrada_at, 'repetido', true);
    end if;
  end if;
  if p_turno is null then
    select * into t from public.caja_turnos where estado = 'abierta' for update;
    if t.id is null then raise exception 'No hay una caja abierta para cerrar.' using errcode = 'P0001'; end if;
  else
    select * into t from public.caja_turnos where id = p_turno for update;
    if t.id is null then raise exception 'Ese turno de caja no existe.' using errcode = 'P0001'; end if;
  end if;
  if t.estado = 'cerrada' then raise exception 'Esa caja ya está cerrada.' using errcode = 'P0001'; end if;
  if p_contado is null or p_contado < 0 or p_contado > 100000000 then raise exception 'Revise el efectivo contado.' using errcode = 'P0001'; end if;
  if p_conteo is not null and jsonb_typeof(p_conteo) <> 'object' then raise exception 'Conteo no válido.' using errcode = 'P0001'; end if;

  v_ahora := least(now(), greatest(coalesce(p_cuando, now()), t.abierta_at));
  update public.caja_turnos set cerrada_at = v_ahora where id = t.id;   -- el resumen llega hasta este momento
  v_res := public.resumen_caja(t.id);
  v_esperado := (v_res ->> 'efectivo_esperado')::numeric;
  update public.caja_turnos
     set estado = 'cerrada', cerrada_por = auth.uid(), resumen = v_res,
         efectivo_esperado = v_esperado, efectivo_contado = round(p_contado, 2),
         diferencia = round(p_contado, 2) - v_esperado, conteo = p_conteo,
         nota = nullif(left(trim(coalesce(p_nota, '')), 500), ''), cierre_id = p_id
   where id = t.id;
  return v_res || jsonb_build_object('turno', t.id, 'efectivo_contado', round(p_contado, 2), 'diferencia', round(p_contado, 2) - v_esperado,
                                     'cerrada_at', v_ahora);
end $$;
revoke all on function public.cerrar_caja(bigint, numeric, jsonb, text, timestamptz, uuid) from public, anon;
grant execute on function public.cerrar_caja(bigint, numeric, jsonb, text, timestamptz, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Pagos y abonos que se mandan otra vez no se repiten
-- ---------------------------------------------------------------------
alter table public.pagos add column if not exists offline_id uuid;
create unique index if not exists pagos_offline_unico on public.pagos (offline_id) where offline_id is not null;
grant insert (offline_id) on public.pagos to authenticated;

alter table public.abonos add column if not exists offline_id uuid;
create unique index if not exists abonos_offline_unico on public.abonos (offline_id) where offline_id is not null;
-- registrar_abono lee p->>'offline_id': si ese abono ya llegó, no lo vuelve a aplicar
create or replace function public._abono_offline() returns trigger language plpgsql set search_path = '' as $$
begin
  new.offline_id := coalesce(new.offline_id, nullif(current_setting('lc.abono_offline', true), '')::uuid);
  return new;
end $$;
drop trigger if exists trg_abono_offline on public.abonos;
create trigger trg_abono_offline before insert on public.abonos for each row execute function public._abono_offline();
do $$
declare f record; def text;
begin
  for f in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
           where s.nspname = 'public' and p.proname = 'registrar_abono' loop
    def := pg_get_functiondef(f.oid);
    if position('lc.abono_offline' in def) > 0 then continue; end if;
    def := regexp_replace(def, '(\nbegin\n)', E'\\1  if nullif(p->>''offline_id'', '''') is not null then\n    if exists (select 1 from public.abonos where offline_id = (p->>''offline_id'')::uuid) then\n      return jsonb_build_object(''repetido'', true, ''aplicado'', ''[]''::jsonb);\n    end if;\n    perform set_config(''lc.abono_offline'', p->>''offline_id'', true);\n  end if;\n');
    execute def;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. Comprobantes electrónicos sin internet
-- ---------------------------------------------------------------------
-- Cada compu que puede facturar sin internet tiene su terminal (00011, 00012, …).
-- La terminal 00002 la sigue usando la función "facturar" con internet.
create table if not exists public.fe_dispositivos (
  id          uuid primary key,
  terminal    text not null unique check (terminal ~ '^[0-9]{5}$'),
  nombre      text check (char_length(nombre) <= 60),
  creado_por  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  usado_at    timestamptz
);
-- números reservados para cada compu (se usan en orden; los que no se usan no salen en Hacienda)
create table if not exists public.fe_bloques (
  id          bigint generated always as identity primary key,
  dispositivo uuid not null references public.fe_dispositivos(id) on delete restrict,
  ambiente    text not null check (ambiente in ('pruebas','produccion')),
  tipo        text not null check (tipo in ('01','04')),
  sucursal    text not null,
  terminal    text not null,
  desde       bigint not null,
  hasta       bigint not null check (hasta >= desde),
  creado_por  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists fe_bloques_busca on public.fe_bloques (terminal, tipo, ambiente, desde);
alter table public.fe_dispositivos enable row level security;
alter table public.fe_bloques enable row level security;
drop policy if exists "fe_dispositivos_admin" on public.fe_dispositivos;
drop policy if exists "fe_bloques_admin" on public.fe_bloques;
create policy "fe_dispositivos_admin" on public.fe_dispositivos for select to authenticated using (public.is_admin());
create policy "fe_bloques_admin" on public.fe_bloques for select to authenticated using (public.is_admin());
revoke all on public.fe_dispositivos, public.fe_bloques from anon, authenticated;
grant select on public.fe_dispositivos, public.fe_bloques to authenticated;      -- escribir: solo con la función de abajo

drop trigger if exists trg_fe_dispositivos_auditoria on public.fe_dispositivos;
create trigger trg_fe_dispositivos_auditoria after insert or update or delete on public.fe_dispositivos
  for each row execute function public.registrar_auditoria();

-- situación del comprobante: 1 normal, 2 contingencia, 3 sin internet
alter table public.fe_documentos add column if not exists situacion text not null default '1';
alter table public.fe_documentos drop constraint if exists fe_documentos_situacion_valida;
alter table public.fe_documentos add constraint fe_documentos_situacion_valida check (situacion in ('1','2','3'));
alter table public.fe_documentos add column if not exists dispositivo uuid references public.fe_dispositivos(id) on delete restrict;

create or replace view public.v_fe_documentos with (security_invoker = true) as
select id, pedido_id, tipo, ambiente, clave, consecutivo, fecha_emision, receptor, total, impuesto,
       estado, detalle, referencia_id, anulado, intentos, created_at, updated_at, situacion
  from public.fe_documentos;
revoke all on public.v_fe_documentos from anon, authenticated;
grant select on public.v_fe_documentos to authenticated;

-- La compu pide (con internet) su terminal y números para usar cuando se vaya la señal.
-- p_tiquetes / p_facturas: cuántos números nuevos quiere (0 a 100 de cada uno).
create or replace function public.fe_preparar_sin_internet(p_dispositivo uuid, p_nombre text default null,
                                                          p_tiquetes int default 0, p_facturas int default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  e record; d record; v_terminal text; n int; v_ult bigint; v_tipo text;
  v_bloques jsonb := '{}'::jsonb;
begin
  if not public.puede('ventas') then raise exception 'No tiene permiso para esto.' using errcode = '42501'; end if;
  if p_dispositivo is null then raise exception 'Falta el identificador de la compu.' using errcode = 'P0001'; end if;
  select * into e from public.fe_emisor where id = 1;
  if e.id is null or not e.activo or e.identificacion is null then
    return jsonb_build_object('activo', false);
  end if;

  select * into d from public.fe_dispositivos where id = p_dispositivo;
  if d.id is null then
    for i in 1..5 loop
      select lpad((greatest(coalesce(max(terminal::int), 0), 10, e.terminal::int) + 1)::text, 5, '0') into v_terminal
        from public.fe_dispositivos;
      begin
        insert into public.fe_dispositivos (id, terminal, nombre) values (p_dispositivo, v_terminal, nullif(left(trim(coalesce(p_nombre, '')), 60), ''))
        returning * into d;
        exit;
      exception when unique_violation then
        if exists (select 1 from public.fe_dispositivos where id = p_dispositivo) then
          select * into d from public.fe_dispositivos where id = p_dispositivo; exit;
        end if;
      end;
    end loop;
    if d.id is null then raise exception 'No se pudo apartar una terminal para esta compu. Intente de nuevo.' using errcode = 'P0001'; end if;
  end if;

  foreach v_tipo in array array['04','01'] loop
    n := least(greatest(coalesce(case v_tipo when '04' then p_tiquetes else p_facturas end, 0), 0), 100);
    if n > 0 then
      insert into public.fe_consecutivos as c (ambiente, tipo, sucursal, terminal, ultimo)
      values (e.ambiente, v_tipo, e.sucursal, d.terminal, n)
      on conflict (ambiente, tipo, sucursal, terminal) do update set ultimo = c.ultimo + n
      returning ultimo into v_ult;
      insert into public.fe_bloques (dispositivo, ambiente, tipo, sucursal, terminal, desde, hasta)
      values (d.id, e.ambiente, v_tipo, e.sucursal, d.terminal, v_ult - n + 1, v_ult);
      v_bloques := v_bloques || jsonb_build_object(v_tipo, jsonb_build_array(v_ult - n + 1, v_ult));
    end if;
  end loop;

  return jsonb_build_object('activo', true, 'terminal', d.terminal, 'sucursal', e.sucursal, 'ambiente', e.ambiente,
                            'identificacion', e.identificacion, 'bloques', v_bloques);
end $$;
revoke all on function public.fe_preparar_sin_internet(uuid, text, int, int) from public, anon;
grant execute on function public.fe_preparar_sin_internet(uuid, text, int, int) to authenticated;
