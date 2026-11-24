-- =====================================================================
-- ALMACÉN LA CAMPIÑA · v16 · BITÁCORA CON NOMBRES Y CAMBIOS
-- Corra este archivo DESPUÉS de v15_mas_vendidos.sql.
-- Se puede correr las veces que quiera.
--
-- - Cada usuario del panel tiene un nombre (Datos del negocio → Usuarios).
-- - La bitácora guarda QUIÉN (su nombre en ese momento), QUÉ (producto,
--   venta, cliente…) y QUÉ CAMBIÓ (antes → después), y de dónde vino
--   (importación de Excel, ajuste de precios).
-- - También quedan en la bitácora los abonos, las entradas de mercadería
--   y los movimientos de caja.
-- - Nada de esto se puede editar ni borrar desde el panel: solo se lee.
--   Los datos secretos (token de Telegram) se anotan como "(oculto)".
-- - Ventas: NO se borran, se anulan (nota de crédito). Solo un usuario con
--   rol "administrador" puede borrar una venta, escribiendo el motivo, y
--   queda en la bitácora con todo lo que tenía. Nunca se borra una venta
--   con pagos o con comprobante electrónico (Hacienda): esas solo se anulan.
-- - Una venta con tiquete o factura electrónica solo se anula después de
--   emitir su nota de crédito electrónica.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Nombre de cada usuario del panel
-- ---------------------------------------------------------------------
alter table public.admins add column if not exists nombre text;
alter table public.admins drop constraint if exists admin_nombre_valido;
alter table public.admins add constraint admin_nombre_valido
  check (nombre is null or char_length(btrim(nombre)) between 2 and 60);

-- Rol: "administrador" (puede borrar ventas y cambiar roles) o "usuario".
-- Los que ya estaban quedan como administradores; los nuevos entran como usuarios.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'admins' and column_name = 'rol') then
    alter table public.admins add column rol text;
    update public.admins set rol = 'administrador';
  end if;
end $$;
update public.admins set rol = 'usuario' where rol is null;
alter table public.admins alter column rol set default 'usuario';
alter table public.admins alter column rol set not null;
alter table public.admins drop constraint if exists admin_rol_valido;
alter table public.admins add constraint admin_rol_valido check (rol in ('administrador', 'usuario'));

create or replace function public.es_administrador()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_admin()
     and exists (select 1 from public.admins a where a.user_id = auth.uid() and a.rol = 'administrador');
$$;
revoke all on function public.es_administrador() from public;
grant execute on function public.es_administrador() to authenticated;

-- Lista de usuarios del panel con su correo, rol y último ingreso (solo admins)
drop function if exists public.usuarios_panel();
create function public.usuarios_panel()
returns table (user_id uuid, nombre text, correo text, rol text, creado timestamptz, ultimo_ingreso timestamptz, soy_yo boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'No autorizado.' using errcode = '42501'; end if;
  return query
    select a.user_id, a.nombre, u.email::text, a.rol, a.created_at, u.last_sign_in_at, a.user_id = auth.uid()
    from public.admins a
    left join auth.users u on u.id = a.user_id
    order by a.created_at;
end $$;

create or replace function public.poner_rol_usuario(p_user uuid, p_rol text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.es_administrador() then
    raise exception 'Solo un administrador puede cambiar roles.' using errcode = '42501';
  end if;
  if p_rol not in ('administrador', 'usuario') then raise exception 'Rol no válido.' using errcode = 'P0001'; end if;
  perform 1 from public.admins where rol = 'administrador' for update;   -- uno a la vez
  if p_rol = 'usuario' and (select rol from public.admins where user_id = p_user) = 'administrador'
     and (select count(*) from public.admins where rol = 'administrador') <= 1 then
    raise exception 'Tiene que quedar al menos un administrador.' using errcode = 'P0001';
  end if;
  update public.admins set rol = p_rol where user_id = p_user;
  if not found then raise exception 'Ese usuario no está en el panel.' using errcode = 'P0001'; end if;
end $$;
revoke all on function public.poner_rol_usuario(uuid, text) from public, anon;
grant execute on function public.poner_rol_usuario(uuid, text) to authenticated;
revoke all on function public.usuarios_panel() from public, anon;
grant execute on function public.usuarios_panel() to authenticated;

create or replace function public.poner_nombre_usuario(p_user uuid, p_nombre text)
returns void language plpgsql security definer set search_path = '' as $$
declare v text := nullif(regexp_replace(btrim(coalesce(p_nombre, '')), '\s+', ' ', 'g'), '');
begin
  if not public.is_admin() then raise exception 'No autorizado.' using errcode = '42501'; end if;
  if v is null or char_length(v) < 2 or char_length(v) > 60 then
    raise exception 'El nombre debe tener entre 2 y 60 letras.' using errcode = 'P0001';
  end if;
  update public.admins set nombre = v where user_id = p_user;
  if not found then raise exception 'Ese usuario no está en el panel.' using errcode = 'P0001'; end if;
end $$;
revoke all on function public.poner_nombre_usuario(uuid, text) from public, anon;
grant execute on function public.poner_nombre_usuario(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Bitácora: quién, qué, qué cambió y de dónde vino
-- ---------------------------------------------------------------------
alter table public.auditoria add column if not exists quien    text;
alter table public.auditoria add column if not exists etiqueta text;
alter table public.auditoria add column if not exists cambios  jsonb;
alter table public.auditoria add column if not exists origen   text;
alter table public.auditoria add column if not exists motivo   text;

create index if not exists auditoria_creado_idx  on public.auditoria (creado desc);
create index if not exists auditoria_user_idx    on public.auditoria (user_id, creado desc);
create index if not exists auditoria_tabla_idx   on public.auditoria (tabla, creado desc);

-- valor para la bitácora: textos largos recortados
create or replace function public._bitacora_valor(v jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(v) = 'string' and char_length(v #>> '{}') > 300
              then to_jsonb(left(v #>> '{}', 300) || '…') else v end;
$$;

create or replace function public.registrar_auditoria()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  r jsonb := coalesce(n, o);
  -- campos que no dicen nada (o que ya tienen su propio historial, como la existencia)
  ignorar  text[] := array['updated_at', 'created_at', 'creado', 'vendido', 'existencia', 'fts'];
  secretos text[] := array['telegram_token', 'token', 'password', 'contrasena', 'pin'];
  cambios jsonb;
  v_quien text;
  v_origen text;
  v_etiqueta text;
  q text;
begin
  -- en ventas, el total y lo pagado los recalcula el sistema: no son cambios de nadie
  if tg_op = 'UPDATE' and tg_table_name = 'pedidos' then
    ignorar := ignorar || array['total', 'pagado_registrado', 'pagado_verificado', 'estado_pago'];
  end if;

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(e.key,
             case when e.key = any(secretos) then '["(oculto)","(oculto)"]'::jsonb
                  else jsonb_build_array(public._bitacora_valor(o -> e.key), public._bitacora_valor(e.value)) end)
      into cambios
      from jsonb_each(n) e
     where e.key <> all(ignorar) and (o -> e.key) is distinct from e.value;
    if cambios is null then return new; end if;          -- solo cambió algo sin importancia
  else
    select jsonb_object_agg(e.key, case when e.key = any(secretos) then '"(oculto)"'::jsonb else public._bitacora_valor(e.value) end)
      into cambios
      from jsonb_each(r) e
     where e.key <> all(ignorar) and e.value <> 'null'::jsonb;
  end if;

  -- quién y de dónde: se averigua una vez por operación (una importación son miles de filas)
  v_quien := nullif(current_setting('lc.bitacora_quien', true), '');
  if v_quien is null and auth.uid() is not null then
    select coalesce(nullif(a.nombre, ''), u.email::text, 'Usuario sin nombre') into v_quien
    from public.admins a left join auth.users u on u.id = a.user_id
    where a.user_id = auth.uid();
    v_quien := coalesce(v_quien, 'Usuario fuera del panel');
    perform set_config('lc.bitacora_quien', v_quien, true);
  end if;
  v_origen := nullif(current_setting('lc.bitacora_origen', true), '');
  if v_origen is null then
    q := coalesce(current_query(), '');
    v_origen := case
      when q ilike '%importar_productos%' then 'importación de Excel'
      when q ilike '%ajustar_precios%'    then 'ajuste de precios'
      when q ilike '%registrar_abono%'    then 'abono'
      when q ilike '%anular_abono%'       then 'anulación de abono'
      when q ilike '%registrar_entrada%'  then 'entrada de mercadería'
      when q ilike '%anular_entrada%'     then 'anulación de entrada'
      when q ilike '%cerrar_caja%'        then 'cierre de caja'
      else '-' end;
    perform set_config('lc.bitacora_origen', v_origen, true);
  end if;
  if v_origen = '-' then v_origen := null; end if;
  if tg_table_name = 'pedidos' and tg_op = 'UPDATE' and n ->> 'estado' = 'anulada' and o ->> 'estado' <> 'anulada' then
    v_origen := 'venta anulada';
  end if;

  -- cómo se llama lo que cambió (venta por su código, renglón con su venta, etc.)
  -- (cada consulta en su propio IF: así no hace falta que existan las tablas de las otras)
  if tg_table_name = 'pedidos' then
    v_etiqueta := concat_ws(' · ', r ->> 'codigo', r ->> 'cliente_nombre');
  elsif tg_table_name = 'pedido_items' then
    v_etiqueta := concat_ws(' · ', (select p.codigo from public.pedidos p where p.id = (r ->> 'pedido_id')::bigint), r ->> 'descripcion');
  elsif tg_table_name = 'pagos' then
    select concat_ws(' · ', p.codigo, p.cliente_nombre) into v_etiqueta from public.pedidos p where p.id = (r ->> 'pedido_id')::bigint;
  elsif tg_table_name = 'abonos' then
    select c.nombre into v_etiqueta from public.clientes c where c.id = (r ->> 'cliente_id')::bigint;
  else
    v_etiqueta := coalesce(r ->> 'nombre', r ->> 'cliente_nombre', r ->> 'descripcion', r ->> 'codigo', r ->> 'motivo', r ->> 'proveedor', r ->> 'clave');
  end if;

  insert into public.auditoria (user_id, quien, tabla, accion, registro, etiqueta, cambios, origen, motivo)
  values (
    auth.uid(), coalesce(v_quien, 'Sistema'), tg_table_name, tg_op,
    coalesce(r ->> 'id', r ->> 'clave', r ->> 'ambiente', r ->> 'user_id'),
    left(nullif(v_etiqueta, ''), 120),
    coalesce(cambios, '{}'::jsonb),
    case when tg_op = 'DELETE' and tg_table_name in ('pedidos', 'pedido_items')
              and nullif(current_setting('lc.borrar_venta_motivo', true), '') is not null then 'venta borrada'
         else v_origen end,
    case when tg_op = 'DELETE' then nullif(current_setting('lc.borrar_venta_motivo', true), '') end);
  return coalesce(new, old);
end $$;

-- Tablas nuevas que también van a la bitácora (las de antes ya tienen su disparador)
do $$
declare t text;
begin
  foreach t in array array['abonos', 'entradas', 'caja_turnos', 'caja_movimientos'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists trg_auditoria on public.%I', t);
      execute format('create trigger trg_auditoria after insert or update or delete on public.%I
                      for each row when (auth.uid() is not null)
                      execute function public.registrar_auditoria()', t);
    end if;
  end loop;
end $$;

-- La bitácora solo se lee (nadie la cambia ni la borra desde el panel)
revoke insert, update, delete, truncate on public.auditoria from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Ventas: se anulan (nota de crédito); borrar solo el administrador
-- ---------------------------------------------------------------------
-- ¿La venta tiene un tiquete o factura electrónica vivo (sin nota de crédito)?
create or replace function public._venta_con_fe_viva(p_pedido bigint)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare r boolean := false;
begin
  if to_regclass('public.fe_documentos') is null then return false; end if;
  execute $q$
    select exists (
      select 1 from public.fe_documentos d
      where d.pedido_id = $1 and d.tipo in ('01', '04') and d.estado <> 'rechazado' and not d.anulado
        and not exists (select 1 from public.fe_documentos nc
                        where nc.referencia_id = d.id and nc.tipo = '03' and nc.estado <> 'rechazado'))
  $q$ into r using p_pedido;
  return r;
end $$;
revoke all on function public._venta_con_fe_viva(bigint) from public, anon;
grant execute on function public._venta_con_fe_viva(bigint) to authenticated;   -- la usa el disparador de ventas

create or replace function public._venta_con_fe(p_pedido bigint)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare r boolean := false;
begin
  if to_regclass('public.fe_documentos') is null then return false; end if;
  execute 'select exists (select 1 from public.fe_documentos where pedido_id = $1)' into r using p_pedido;
  return r;
end $$;
revoke all on function public._venta_con_fe(bigint) from public, anon;
grant execute on function public._venta_con_fe(bigint) to authenticated;

create or replace function public.validar_pedido()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if nullif(current_setting('lc.borrar_venta_motivo', true), '') is null then
      raise exception 'Las ventas no se borran: anúlela (queda como nota de crédito). Solo el administrador puede borrar, con el botón del panel.' using errcode = 'P0001';
    end if;
    if public._venta_con_fe(old.id) then
      raise exception 'Esta venta tiene comprobante electrónico: no se puede borrar. Anúlela con nota de crédito.' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.pagos where pedido_id = old.id) then
      raise exception 'Esta venta tiene pagos registrados: no se puede borrar, anúlela.' using errcode = 'P0001';
    end if;
    if to_regclass('public.facturas') is not null then
      if exists (select 1 from public.facturas where pedido_id = old.id) then
        raise exception 'Esta venta tiene datos de factura: no se puede borrar, anúlela.' using errcode = 'P0001';
      end if;
    end if;
    return old;
  end if;
  if old.estado = 'anulada' and new.estado <> 'anulada' then
    raise exception 'Una venta anulada no se puede reabrir. Cree una nueva.' using errcode = 'P0001';
  end if;
  if new.estado = 'anulada' and old.estado <> 'anulada' then
    if char_length(coalesce(trim(new.motivo_anulacion), '')) < 5 then
      raise exception 'Escriba el motivo de la anulación.' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.pagos where pedido_id = new.id and not anulado) then
      raise exception 'Primero anule (o devuelva) los pagos de esta venta.' using errcode = 'P0001';
    end if;
    if public._venta_con_fe_viva(new.id) then
      raise exception 'Esta venta tiene tiquete o factura electrónica: primero emita la nota de crédito.' using errcode = 'P0001';
    end if;
  end if;
  if new.estado = 'entregada' and old.estado <> 'entregada' then
    new.entregada_at := now();
  end if;
  return new;
end $$;

-- Borrar una venta: solo el administrador, con motivo; queda en la bitácora
create or replace function public.borrar_venta(p_pedido bigint, p_motivo text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_motivo text := btrim(coalesce(p_motivo, ''));
begin
  if not public.es_administrador() then
    raise exception 'Solo el administrador puede borrar ventas. Anúlela en vez de borrarla.' using errcode = '42501';
  end if;
  if char_length(v_motivo) < 5 then
    raise exception 'Escriba por qué se borra la venta (al menos 5 letras).' using errcode = 'P0001';
  end if;
  perform set_config('lc.borrar_venta_motivo', left(v_motivo, 300), true);
  delete from public.pedidos where id = p_pedido;
  if not found then raise exception 'Esa venta ya no existe.' using errcode = 'P0001'; end if;
  perform set_config('lc.borrar_venta_motivo', '', true);
end $$;
revoke all on function public.borrar_venta(bigint, text) from public, anon;
grant execute on function public.borrar_venta(bigint, text) to authenticated;
