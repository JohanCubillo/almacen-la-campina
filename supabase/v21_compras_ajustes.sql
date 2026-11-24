-- =====================================================================
-- ALMACÉN LA CAMPIÑA · v21 · AJUSTES DE INVENTARIO, COMPRAS Y PROVEEDORES,
--                            COMPROBANTES RECIBIDOS Y REVISIÓN DE ARRANQUE
-- Corra este archivo DESPUÉS de v20_actividad_caecr.sql.
-- Se puede correr las veces que quiera.
--
-- 1. Ajustes de inventario: salidas por daño, pérdida, uso interno,
--    vencimiento o devolución al proveedor, y conteo físico (la existencia
--    queda en lo que se contó). Todo queda en Movimientos con su motivo.
-- 2. Proveedores y cuentas por pagar: la entrada de mercadería puede ser
--    de contado o a crédito (con vencimiento). Los pagos al proveedor bajan
--    el saldo y, si son en efectivo, pueden salir de la caja abierta.
-- 3. Comprobantes recibidos: se sube el XML de la factura del proveedor y
--    se acepta, acepta en parte o rechaza ante Hacienda (mensaje receptor).
--    Lo firma y lo manda la función "facturar".
-- 4. revisar_arranque(): lista de lo que falta para dejar Moriah.
--
-- Permiso nuevo para empleados: "compras" (proveedores, pagos a
-- proveedores y comprobantes recibidos). Ajustes de inventario usan
-- el permiso "inventario", igual que las entradas.
-- =====================================================================

do $$
begin
  if to_regclass('public.fe_dispositivos') is null then
    raise exception 'Primero corra v19_sin_internet.sql.';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fe_emisor_actividad_check') then
    raise exception 'Primero corra v20_actividad_caecr.sql.';
  end if;
end $$;

-- Quita las reglas CHECK de una columna (los nombres automáticos cambian entre bases)
create or replace function public._quitar_checks(p_tabla text, p_columna text)
returns void language plpgsql set search_path = '' as $$
declare c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
     where con.conrelid = ('public.' || p_tabla)::regclass and con.contype = 'c' and att.attname = p_columna
  loop
    execute format('alter table public.%I drop constraint %I', p_tabla, c.conname);
  end loop;
end $$;
revoke all on function public._quitar_checks(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 0. Permiso nuevo: compras
-- ---------------------------------------------------------------------
alter table public.admins drop constraint if exists admin_permisos_validos;
alter table public.admins add constraint admin_permisos_validos
  check (permisos <@ array['ventas','anular','caja','credito','inventario','productos','precios','reportes','preguntas','compras']::text[]);

-- ---------------------------------------------------------------------
-- 1. Ajustes de inventario
-- ---------------------------------------------------------------------
select public._quitar_checks('inventario_movimientos', 'origen');
alter table public.inventario_movimientos add constraint inventario_movimientos_origen_check
  check (origen in ('venta','venta_cambio','venta_borrada','anulacion','entrada','entrada_anulada',
                    'producto','importacion','ajuste','ajuste_anulado'));
alter table public.inventario_movimientos add column if not exists ajuste_id bigint;

create table if not exists public.ajustes_inventario (
  id                bigint generated always as identity primary key,
  fecha             date not null default ((now() at time zone 'America/Costa_Rica')::date),
  tipo              text not null check (tipo in ('salida','conteo')),
  motivo            text not null check (motivo in ('danado','perdido','uso_interno','vencido','devolucion','conteo','otro')),
  nota              text check (char_length(nota) <= 300),
  productos         int not null default 0,
  costo_total       numeric(14,2) not null default 0,       -- lo que valía lo que salió (al costo); en conteo, la diferencia
  estado            text not null default 'aplicado' check (estado in ('aplicado','anulado')),
  motivo_anulacion  text check (char_length(motivo_anulacion) <= 300),
  anulado_at        timestamptz,
  hecho_por         uuid default auth.uid(),
  created_at        timestamptz not null default now()
);
create table if not exists public.ajuste_items (
  id           bigint generated always as identity primary key,
  ajuste_id    bigint not null references public.ajustes_inventario(id) on delete cascade,
  producto_id  bigint not null references public.productos(id) on delete restrict,
  antes        numeric(12,2),
  cantidad     numeric(12,2) not null,            -- lo que cambió: − sale, + sobra en el conteo
  despues      numeric(12,2),
  costo_unit   numeric(12,2)
);
create index if not exists ajuste_items_ajuste on public.ajuste_items (ajuste_id);
create index if not exists ajustes_inv_fecha on public.ajustes_inventario (fecha desc, id desc);

alter table public.ajustes_inventario enable row level security;
alter table public.ajuste_items enable row level security;
drop policy if exists "ajustes_inv_ver" on public.ajustes_inventario;
drop policy if exists "ajuste_items_ver" on public.ajuste_items;
create policy "ajustes_inv_ver" on public.ajustes_inventario for select to authenticated
  using (public.puede('inventario') or public.puede('productos') or public.puede('reportes'));
create policy "ajuste_items_ver" on public.ajuste_items for select to authenticated
  using (public.puede('inventario') or public.puede('productos') or public.puede('reportes'));
revoke all on public.ajustes_inventario, public.ajuste_items from anon, authenticated;
grant select on public.ajustes_inventario, public.ajuste_items to authenticated;

-- El historial ahora también anota el ajuste
create or replace function public.anotar_cambio_existencia()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_origen text := nullif(current_setting('lc.inv_origen', true), '');
begin
  if new.existencia is distinct from old.existencia then
    insert into public.inventario_movimientos (producto_id, cantidad, existencia_antes, existencia_despues, origen, pedido_id, entrada_id, ajuste_id, nota)
    values (new.id, coalesce(new.existencia, 0) - coalesce(old.existencia, 0), old.existencia, new.existencia,
            coalesce(v_origen, case when current_query() ilike '%importar_productos%' then 'importacion' else 'producto' end),
            nullif(current_setting('lc.inv_pedido', true), '')::bigint,
            nullif(current_setting('lc.inv_entrada', true), '')::bigint,
            nullif(current_setting('lc.inv_ajuste', true), '')::bigint,
            nullif(current_setting('lc.inv_nota', true), ''));
  end if;
  return new;
end $$;
revoke all on function public.anotar_cambio_existencia() from public, anon, authenticated;

-- p = {"tipo":"salida"|"conteo","motivo":"danado","fecha":"2026-11-24","nota":"…",
--      "items":[{"producto_id":12,"cantidad":"2"}, …]}
--   salida: cantidad = lo que sale (se resta)
--   conteo: cantidad = lo que se contó (la existencia queda en eso)
create or replace function public.ajustar_inventario(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_tipo text := coalesce(p ->> 'tipo', '');
  v_motivo text := coalesce(p ->> 'motivo', '');
  v_nota text := nullif(left(trim(coalesce(p ->> 'nota', '')), 300), '');
  v_fecha date; v_id bigint; it jsonb; v_prod bigint; v_cant numeric; v_delta numeric;
  pr record; n int := 0; v_costo numeric := 0; vistos bigint[] := '{}';
  num constant text := '^[0-9]{1,10}(\.[0-9]{1,2})?$';
  etiquetas constant jsonb := '{"danado":"Dañado","perdido":"Perdido o robado","uso_interno":"Uso del almacén",
                                "vencido":"Vencido","devolucion":"Devuelto al proveedor","conteo":"Conteo físico","otro":"Otro"}';
begin
  if not public.puede('inventario') then raise exception 'No tiene permiso para esto.' using errcode = '42501'; end if;
  if v_tipo not in ('salida','conteo') then raise exception 'Tipo de ajuste no válido.' using errcode = 'P0001'; end if;
  if v_tipo = 'conteo' then v_motivo := 'conteo'; end if;
  if v_motivo not in ('danado','perdido','uso_interno','vencido','devolucion','conteo','otro') or (v_tipo = 'salida' and v_motivo = 'conteo') then
    raise exception 'Escoja el motivo.' using errcode = 'P0001';
  end if;
  if v_motivo = 'otro' and v_nota is null then raise exception 'Con "Otro", escriba en la nota qué pasó.' using errcode = 'P0001'; end if;
  if jsonb_typeof(p -> 'items') <> 'array' or jsonb_array_length(p -> 'items') = 0 then
    raise exception 'Agregue al menos un producto.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p -> 'items') > 1000 then raise exception 'Máximo 1000 productos por ajuste.' using errcode = 'P0001'; end if;
  begin v_fecha := coalesce(nullif(p ->> 'fecha', '')::date, (now() at time zone 'America/Costa_Rica')::date);
  exception when others then raise exception 'Revise la fecha.' using errcode = 'P0001'; end;
  if v_fecha > (now() at time zone 'America/Costa_Rica')::date then raise exception 'La fecha no puede ser futura.' using errcode = 'P0001'; end if;

  perform set_config('lc.bitacora_origen', case when v_tipo = 'conteo' then 'conteo de inventario' else 'ajuste de inventario' end, true);
  insert into public.ajustes_inventario (fecha, tipo, motivo, nota) values (v_fecha, v_tipo, v_motivo, v_nota) returning id into v_id;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_prod := nullif(it ->> 'producto_id', '')::bigint;
    if v_prod = any (vistos) then raise exception 'Un producto está dos veces en la lista.' using errcode = 'P0001'; end if;
    vistos := vistos || v_prod;
    select id, nombre, existencia, costo into pr from public.productos where id = v_prod for update;
    if pr.id is null then raise exception 'Un producto de la lista ya no existe.' using errcode = 'P0001'; end if;
    if coalesce(it ->> 'cantidad', '') !~ num then
      raise exception 'Revise la cantidad de %.', pr.nombre using errcode = 'P0001';
    end if;
    v_cant := (it ->> 'cantidad')::numeric;
    if v_tipo = 'salida' then
      if v_cant <= 0 then raise exception 'La cantidad que sale de % tiene que ser mayor que 0.', pr.nombre using errcode = 'P0001'; end if;
      if pr.existencia is null then
        raise exception '% no lleva existencia: no se le puede restar. Haga un conteo físico primero.', pr.nombre using errcode = 'P0001';
      end if;
      v_delta := -v_cant;
    else
      v_delta := v_cant - coalesce(pr.existencia, 0);
    end if;

    insert into public.ajuste_items (ajuste_id, producto_id, antes, cantidad, despues, costo_unit)
    values (v_id, v_prod, pr.existencia, v_delta,
            case when v_tipo = 'conteo' then v_cant else pr.existencia + v_delta end, pr.costo);
    if v_delta <> 0 or (v_tipo = 'conteo' and pr.existencia is null) then
      perform set_config('lc.inv_ajuste', v_id::text, true);
      if v_delta = 0 then
        perform set_config('lc.inv_origen', 'ajuste', true);
        perform set_config('lc.inv_nota', 'Conteo físico', true);
        update public.productos set existencia = 0 where id = v_prod;          -- empieza a llevar existencia en 0
        perform set_config('lc.inv_origen', '', true);
        perform set_config('lc.inv_nota', '', true);
      else
        perform public._inv_mover(v_prod, v_delta, 'ajuste', null, null,
                                  left(concat_ws(' · ', etiquetas ->> v_motivo, v_nota), 300), v_tipo = 'conteo');
      end if;
      perform set_config('lc.inv_ajuste', '', true);
    end if;
    v_costo := v_costo + v_delta * coalesce(pr.costo, 0);
    n := n + 1;
  end loop;

  update public.ajustes_inventario set productos = n, costo_total = round(v_costo, 2) where id = v_id;
  return jsonb_build_object('id', v_id, 'productos', n, 'costo_total', round(v_costo, 2));
end $$;
revoke all on function public.ajustar_inventario(jsonb) from public, anon;
grant execute on function public.ajustar_inventario(jsonb) to authenticated;

create or replace function public.anular_ajuste(p_id bigint, p_motivo text)
returns void language plpgsql security definer set search_path = '' as $$
declare r record; v_estado text;
begin
  if not public.puede('inventario') then raise exception 'No tiene permiso para esto.' using errcode = '42501'; end if;
  if char_length(trim(coalesce(p_motivo, ''))) < 3 then raise exception 'Escriba el motivo.' using errcode = 'P0001'; end if;
  select estado into v_estado from public.ajustes_inventario where id = p_id for update;
  if v_estado is null then raise exception 'Ese ajuste no existe.' using errcode = 'P0001'; end if;
  if v_estado = 'anulado' then raise exception 'Ese ajuste ya está anulado.' using errcode = 'P0001'; end if;
  perform set_config('lc.bitacora_origen', 'anulación de ajuste de inventario', true);
  perform set_config('lc.inv_ajuste', p_id::text, true);
  for r in select producto_id, cantidad from public.ajuste_items where ajuste_id = p_id and cantidad <> 0 loop
    perform public._inv_mover(r.producto_id, -r.cantidad, 'ajuste_anulado', null, null, left(trim(p_motivo), 300), false);
  end loop;
  perform set_config('lc.inv_ajuste', '', true);
  update public.ajustes_inventario set estado = 'anulado', motivo_anulacion = left(trim(p_motivo), 300), anulado_at = now() where id = p_id;
end $$;
revoke all on function public.anular_ajuste(bigint, text) from public, anon;
grant execute on function public.anular_ajuste(bigint, text) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Proveedores y cuentas por pagar
-- ---------------------------------------------------------------------
create table if not exists public.proveedores (
  id              bigint generated always as identity primary key,
  nombre          text not null check (char_length(nombre) between 2 and 100),
  tipo_id         text check (tipo_id in ('01','02','03','04')),
  identificacion  text check (identificacion ~ '^[0-9]{9,12}$'),
  telefono        text check (char_length(telefono) <= 30),
  correo          text check (char_length(correo) <= 160),
  contacto        text check (char_length(contacto) <= 100),
  dias_credito    int check (dias_credito between 0 and 365),
  nota            text check (char_length(nota) <= 300),
  activo          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists proveedores_identificacion on public.proveedores (identificacion) where identificacion is not null;
create unique index if not exists proveedores_nombre on public.proveedores (lower(nombre));
drop trigger if exists trg_proveedores_updated on public.proveedores;
create trigger trg_proveedores_updated before update on public.proveedores
  for each row execute function public.tocar_updated_at();

alter table public.proveedores enable row level security;
drop policy if exists "proveedores_ver" on public.proveedores;
drop policy if exists "proveedores_crear" on public.proveedores;
drop policy if exists "proveedores_editar" on public.proveedores;
create policy "proveedores_ver" on public.proveedores for select to authenticated
  using (public.puede('inventario') or public.puede('compras') or public.puede('reportes'));
create policy "proveedores_crear" on public.proveedores for insert to authenticated
  with check (public.puede('inventario') or public.puede('compras'));
create policy "proveedores_editar" on public.proveedores for update to authenticated
  using (public.puede('inventario') or public.puede('compras')) with check (public.puede('inventario') or public.puede('compras'));
revoke all on public.proveedores from anon, authenticated;
grant select on public.proveedores to authenticated;
grant insert (nombre, tipo_id, identificacion, telefono, correo, contacto, dias_credito, nota, activo) on public.proveedores to authenticated;
grant update (nombre, tipo_id, identificacion, telefono, correo, contacto, dias_credito, nota, activo) on public.proveedores to authenticated;

alter table public.entradas add column if not exists proveedor_id  bigint references public.proveedores(id) on delete restrict;
alter table public.entradas add column if not exists condicion     text not null default 'contado';
alter table public.entradas add column if not exists vence         date;
alter table public.entradas add column if not exists total_factura numeric(14,2);
alter table public.entradas add column if not exists saldo         numeric(14,2) not null default 0;
alter table public.entradas add column if not exists recibido_id   bigint;
alter table public.entradas drop constraint if exists entradas_condicion_valida;
alter table public.entradas add constraint entradas_condicion_valida check (condicion in ('contado','credito'));
alter table public.entradas drop constraint if exists entradas_saldo_valido;
alter table public.entradas add constraint entradas_saldo_valido check (saldo >= 0 and (total_factura is null or saldo <= total_factura));
create index if not exists entradas_por_pagar on public.entradas (vence) where saldo > 0;
create index if not exists entradas_proveedor on public.entradas (proveedor_id, fecha desc);

create table if not exists public.pagos_proveedor (
  id                bigint generated always as identity primary key,
  entrada_id        bigint not null references public.entradas(id) on delete restrict,
  proveedor_id      bigint references public.proveedores(id) on delete restrict,
  fecha             date not null default ((now() at time zone 'America/Costa_Rica')::date),
  monto             numeric(14,2) not null check (monto > 0),
  metodo            text not null check (metodo in ('efectivo','transferencia','sinpe','cheque','tarjeta','otro')),
  referencia        text check (char_length(referencia) <= 60),
  nota              text check (char_length(nota) <= 300),
  de_caja           boolean not null default false,
  caja_mov_id       bigint,
  anulado           boolean not null default false,
  motivo_anulacion  text check (char_length(motivo_anulacion) <= 300),
  anulado_at        timestamptz,
  hecho_por         uuid default auth.uid(),
  created_at        timestamptz not null default now()
);
create index if not exists pagos_prov_entrada on public.pagos_proveedor (entrada_id);
create index if not exists pagos_prov_fecha on public.pagos_proveedor (fecha desc, id desc);

alter table public.pagos_proveedor enable row level security;
drop policy if exists "pagos_prov_ver" on public.pagos_proveedor;
create policy "pagos_prov_ver" on public.pagos_proveedor for select to authenticated
  using (public.puede('compras') or public.puede('reportes') or public.puede('inventario'));
revoke all on public.pagos_proveedor from anon, authenticated;
grant select on public.pagos_proveedor to authenticated;    -- escribir: solo con las funciones de abajo

-- Una entrada con pagos no se anula (primero se anulan los pagos); al anularla ya no se debe nada
create or replace function public.entrada_antes_de_anular()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.estado = 'anulada' and old.estado <> 'anulada' then
    if exists (select 1 from public.pagos_proveedor where entrada_id = new.id and not anulado) then
      raise exception 'Esa compra tiene pagos al proveedor. Primero anule los pagos.' using errcode = 'P0001';
    end if;
    new.saldo := 0;
    if new.recibido_id is not null then
      update public.fe_recibidos set entrada_id = null where id = new.recibido_id and entrada_id = new.id;
      new.recibido_id := null;
    end if;
  end if;
  return new;
end $$;
revoke all on function public.entrada_antes_de_anular() from public, anon, authenticated;
drop trigger if exists trg_entrada_anular on public.entradas;
create trigger trg_entrada_anular before update of estado on public.entradas
  for each row execute function public.entrada_antes_de_anular();

-- ---------------------------------------------------------------------
-- 3. Comprobantes recibidos (facturas electrónicas de proveedores)
-- ---------------------------------------------------------------------
create table if not exists public.fe_recibidos (
  id                  bigint generated always as identity primary key,
  clave               text not null unique check (clave ~ '^[0-9]{50}$'),
  tipo_doc            text not null check (tipo_doc in ('01','02','03','04','08','09')),   -- factura, débito, crédito, tiquete, compra, exportación
  emisor_tipo         text not null check (emisor_tipo in ('01','02','03','04','05','06')),
  emisor_id           text not null check (emisor_id ~ '^[0-9]{9,12}$'),
  emisor_nombre       text not null check (char_length(emisor_nombre) between 1 and 100),
  emisor_correo       text check (char_length(emisor_correo) <= 160),
  receptor_id         text check (receptor_id ~ '^[0-9]{9,12}$'),
  consecutivo_doc     text check (consecutivo_doc ~ '^[0-9]{20}$'),
  fecha_emision       timestamptz not null,
  moneda              text not null default 'CRC' check (moneda ~ '^[A-Z]{3}$'),
  tipo_cambio         numeric(18,5) not null default 1 check (tipo_cambio > 0),
  total               numeric(18,5) not null check (total >= 0),
  impuesto            numeric(18,5) not null default 0 check (impuesto >= 0),
  lineas              jsonb not null default '[]',      -- [{codigo,cabys,detalle,cantidad,unidad,precio,monto}] para hacer la entrada
  xml                 text not null check (octet_length(xml) <= 2000000),
  proveedor_id        bigint references public.proveedores(id) on delete set null,
  entrada_id          bigint references public.entradas(id) on delete set null,
  -- lo que contesta el almacén
  ambiente            text check (ambiente in ('pruebas','produccion')),
  mensaje             text check (mensaje in ('1','2','3')),          -- 1 acepta, 2 acepta en parte, 3 rechaza
  detalle_mensaje     text check (char_length(detalle_mensaje) <= 160),
  condicion_impuesto  text check (condicion_impuesto in ('01','02','03','04','05')),
  impuesto_acreditar  numeric(18,5) check (impuesto_acreditar >= 0),
  gasto_aplicable     numeric(18,5) check (gasto_aplicable >= 0),
  consecutivo         text check (consecutivo ~ '^[0-9]{20}$'),
  fecha_respuesta     timestamptz,
  xml_firmado         text,
  respuesta_xml       text,
  estado              text not null default 'nuevo'
                      check (estado in ('nuevo','firmado','enviado','procesando','aceptado','rechazado','error')),
  detalle             text check (char_length(detalle) <= 2000),
  intentos            int not null default 0,
  subido_por          uuid default auth.uid(),
  respondido_por      uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists fe_recibidos_fecha on public.fe_recibidos (fecha_emision desc);
create index if not exists fe_recibidos_pendientes on public.fe_recibidos (estado) where estado in ('nuevo','firmado','enviado','procesando','error');
create unique index if not exists fe_recibidos_consecutivo on public.fe_recibidos (ambiente, consecutivo) where consecutivo is not null;
drop trigger if exists trg_fe_recibidos_updated on public.fe_recibidos;
create trigger trg_fe_recibidos_updated before update on public.fe_recibidos
  for each row execute function public.tocar_updated_at();

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'entradas_recibido_fk') then
    alter table public.entradas add constraint entradas_recibido_fk foreign key (recibido_id) references public.fe_recibidos(id) on delete set null;
  end if;
end $$;

alter table public.fe_recibidos enable row level security;
drop policy if exists "fe_recibidos_ver" on public.fe_recibidos;
create policy "fe_recibidos_ver" on public.fe_recibidos for select to authenticated
  using (public.puede('compras') or public.puede('inventario') or public.puede('reportes'));
revoke all on public.fe_recibidos from anon, authenticated;
grant select on public.fe_recibidos to authenticated;      -- escribir: con guardar_recibido y la función "facturar"

-- Resumen para la lista (sin los XML, que pesan)
create or replace view public.v_fe_recibidos with (security_invoker = true) as
select r.id, r.clave, r.tipo_doc, r.emisor_tipo, r.emisor_id, r.emisor_nombre, r.consecutivo_doc, r.fecha_emision, r.moneda,
       r.tipo_cambio, r.total, r.impuesto, r.proveedor_id, r.entrada_id, r.ambiente, r.mensaje, r.detalle_mensaje,
       r.condicion_impuesto, r.impuesto_acreditar, r.consecutivo, r.fecha_respuesta, r.estado, r.detalle, r.intentos,
       r.created_at, r.updated_at, jsonb_array_length(r.lineas) as n_lineas
  from public.fe_recibidos r;
revoke all on public.v_fe_recibidos from anon, authenticated;
grant select on public.v_fe_recibidos to authenticated;

-- Números de los mensajes de receptor: 05 acepta, 06 acepta en parte, 07 rechaza
select public._quitar_checks('fe_consecutivos', 'tipo');
alter table public.fe_consecutivos add constraint fe_consecutivos_tipo_check check (tipo in ('01','03','04','05','06','07'));

-- El panel lee el XML en la compu y manda lo que encontró. Aquí se revisa y se guarda.
-- p = {clave, tipo_doc, emisor_tipo, emisor_id, emisor_nombre, emisor_correo, receptor_id, consecutivo_doc,
--      fecha_emision, moneda, tipo_cambio, total, impuesto, lineas:[…], xml}
create or replace function public.guardar_recibido(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint; v_prov bigint; v_mio text; v_clave text := coalesce(p ->> 'clave', '');
  v_emisor text := regexp_replace(coalesce(p ->> 'emisor_id', ''), '\D', '', 'g');
  v_receptor text := nullif(regexp_replace(coalesce(p ->> 'receptor_id', ''), '\D', '', 'g'), '');
  v_nombre text := left(regexp_replace(btrim(coalesce(p ->> 'emisor_nombre', '')), '\s+', ' ', 'g'), 100);
  v_fecha timestamptz; v_total numeric; v_imp numeric;
begin
  if not public.puede('compras') then raise exception 'No tiene permiso para esto.' using errcode = '42501'; end if;
  if v_clave !~ '^[0-9]{50}$' then raise exception 'El XML no trae una clave de Hacienda válida.' using errcode = 'P0001'; end if;
  select id into v_id from public.fe_recibidos where clave = v_clave;
  if v_id is not null then return jsonb_build_object('id', v_id, 'repetido', true); end if;
  if coalesce(p ->> 'tipo_doc', '') not in ('01','02','03','04','08','09') then
    raise exception 'Ese archivo no es una factura, tiquete o nota electrónica.' using errcode = 'P0001';
  end if;
  if v_emisor !~ '^[0-9]{9,12}$' or char_length(v_nombre) < 1 then raise exception 'El XML no trae los datos del emisor.' using errcode = 'P0001'; end if;
  select identificacion into v_mio from public.fe_emisor where id = 1;
  if v_mio is not null and v_receptor is not null and ltrim(v_receptor, '0') <> ltrim(v_mio, '0') then
    raise exception 'Ese comprobante no es para este negocio: el receptor es la cédula %.', v_receptor using errcode = 'P0001';
  end if;
  if v_mio is not null and ltrim(v_emisor, '0') = ltrim(v_mio, '0') then
    raise exception 'Ese comprobante lo emitió este mismo negocio (no es de un proveedor).' using errcode = 'P0001';
  end if;
  begin
    v_fecha := (p ->> 'fecha_emision')::timestamptz;
    v_total := (p ->> 'total')::numeric;
    v_imp := coalesce(nullif(p ->> 'impuesto', '')::numeric, 0);
  exception when others then raise exception 'El XML trae la fecha o los montos en un formato raro.' using errcode = 'P0001'; end;
  if v_fecha is null or v_total is null or v_total < 0 or v_imp < 0 then raise exception 'Faltan la fecha o el total en el XML.' using errcode = 'P0001'; end if;
  if octet_length(coalesce(p ->> 'xml', '')) < 100 then raise exception 'Falta el XML.' using errcode = 'P0001'; end if;

  perform set_config('lc.bitacora_origen', 'comprobante recibido', true);
  -- proveedor: el que tenga esa cédula; si no hay, se crea
  select id into v_prov from public.proveedores where identificacion = v_emisor;
  if v_prov is null then
    select id into v_prov from public.proveedores where lower(nombre) = lower(v_nombre) and identificacion is null;
    if v_prov is not null then
      update public.proveedores set identificacion = v_emisor, tipo_id = coalesce(tipo_id, p ->> 'emisor_tipo') where id = v_prov;
    else
      insert into public.proveedores (nombre, tipo_id, identificacion, correo)
      values (case when exists (select 1 from public.proveedores where lower(nombre) = lower(v_nombre)) then left(v_nombre || ' (' || v_emisor || ')', 100) else v_nombre end,
              case when p ->> 'emisor_tipo' in ('01','02','03','04') then p ->> 'emisor_tipo' end, v_emisor,
              nullif(left(p ->> 'emisor_correo', 160), ''))
      returning id into v_prov;
    end if;
  end if;

  insert into public.fe_recibidos (clave, tipo_doc, emisor_tipo, emisor_id, emisor_nombre, emisor_correo, receptor_id, consecutivo_doc,
                                   fecha_emision, moneda, tipo_cambio, total, impuesto, lineas, xml, proveedor_id)
  values (v_clave, p ->> 'tipo_doc', coalesce(nullif(p ->> 'emisor_tipo', ''), '02'), v_emisor, v_nombre,
          nullif(left(p ->> 'emisor_correo', 160), ''), v_receptor,
          case when coalesce(p ->> 'consecutivo_doc', '') ~ '^[0-9]{20}$' then p ->> 'consecutivo_doc' end,
          v_fecha, coalesce(nullif(upper(p ->> 'moneda'), ''), 'CRC'), coalesce(nullif(p ->> 'tipo_cambio', '')::numeric, 1),
          round(v_total, 5), round(v_imp, 5),
          case when jsonb_typeof(p -> 'lineas') = 'array' then p -> 'lineas' else '[]'::jsonb end,
          p ->> 'xml', v_prov)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'proveedor_id', v_prov);
end $$;
revoke all on function public.guardar_recibido(jsonb) from public, anon;
grant execute on function public.guardar_recibido(jsonb) to authenticated;

-- Borrar uno que todavía no se contestó (se subió por error)
create or replace function public.borrar_recibido(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_estado text;
begin
  if not public.puede('compras') then raise exception 'No tiene permiso para esto.' using errcode = '42501'; end if;
  select estado into v_estado from public.fe_recibidos where id = p_id for update;
  if v_estado is null then raise exception 'Ese comprobante no existe.' using errcode = 'P0001'; end if;
  if v_estado <> 'nuevo' then raise exception 'Ese comprobante ya se contestó a Hacienda; no se puede borrar.' using errcode = 'P0001'; end if;
  update public.entradas set recibido_id = null where recibido_id = p_id;
  delete from public.fe_recibidos where id = p_id;
end $$;
revoke all on function public.borrar_recibido(bigint) from public, anon;
grant execute on function public.borrar_recibido(bigint) to authenticated;

-- ---------------------------------------------------------------------
-- 2b. Compras: entrada con proveedor, contado o crédito
-- ---------------------------------------------------------------------
-- p = lo mismo que registrar_entrada + {"proveedor_id", "condicion":"contado"|"credito",
--     "vence":"2026-12-24", "total_factura":"125000", "recibido_id"}
create or replace function public.registrar_compra(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_res jsonb; v_id bigint; v_prov_id bigint; v_prov_nombre text; v_prov_dias int; v_cond text := coalesce(nullif(p ->> 'condicion', ''), 'contado');
  v_vence date; v_total numeric; v_fecha date; v_rec bigint := nullif(p ->> 'recibido_id', '')::bigint; v_rec_ent bigint;
  num constant text := '^[0-9]{1,12}(\.[0-9]{1,2})?$';
begin
  if not public.puede('inventario') then raise exception 'No tiene permiso para esto.' using errcode = '42501'; end if;
  if v_cond not in ('contado','credito') then raise exception 'Condición no válida.' using errcode = 'P0001'; end if;
  if nullif(p ->> 'proveedor_id', '') is not null then
    select id, nombre, dias_credito into v_prov_id, v_prov_nombre, v_prov_dias from public.proveedores where id = (p ->> 'proveedor_id')::bigint;
    if v_prov_id is null then raise exception 'Ese proveedor no existe.' using errcode = 'P0001'; end if;
  end if;
  if v_cond = 'credito' and v_prov_id is null then raise exception 'Para una compra a crédito, escoja el proveedor.' using errcode = 'P0001'; end if;
  if coalesce(p ->> 'total_factura', '') <> '' then
    if (p ->> 'total_factura') !~ num then raise exception 'Revise el total de la factura.' using errcode = 'P0001'; end if;
    v_total := (p ->> 'total_factura')::numeric;
  end if;
  if v_cond = 'credito' and coalesce(v_total, 0) <= 0 then
    raise exception 'Para una compra a crédito, escriba el total de la factura (lo que se le debe al proveedor).' using errcode = 'P0001';
  end if;
  begin v_fecha := coalesce(nullif(p ->> 'fecha', '')::date, (now() at time zone 'America/Costa_Rica')::date);
  exception when others then raise exception 'Revise la fecha.' using errcode = 'P0001'; end;
  if v_cond = 'credito' then
    begin v_vence := coalesce(nullif(p ->> 'vence', '')::date, v_fecha + coalesce(v_prov_dias, 30));
    exception when others then raise exception 'Revise la fecha de vencimiento.' using errcode = 'P0001'; end;
    if v_vence < v_fecha then raise exception 'El vencimiento no puede ser antes de la fecha de la factura.' using errcode = 'P0001'; end if;
  end if;
  if v_rec is not null then
    select entrada_id into v_rec_ent from public.fe_recibidos where id = v_rec for update;
    if not found then raise exception 'Ese comprobante recibido no existe.' using errcode = 'P0001'; end if;
    if v_rec_ent is not null and exists (select 1 from public.entradas where id = v_rec_ent and estado = 'aplicada') then
      raise exception 'Esa factura del proveedor ya tiene su entrada de mercadería (entrada %).', v_rec_ent using errcode = 'P0001';
    end if;
  end if;

  perform set_config('lc.bitacora_origen', case when v_cond = 'credito' then 'compra a crédito' else 'entrada de mercadería' end, true);
  v_res := public.registrar_entrada(case when v_prov_id is not null then p || jsonb_build_object('proveedor', v_prov_nombre) else p end);
  v_id := (v_res ->> 'id')::bigint;
  update public.entradas
     set proveedor_id = v_prov_id, condicion = v_cond, vence = v_vence,
         total_factura = coalesce(v_total, case when total_costo > 0 then total_costo end),
         saldo = case when v_cond = 'credito' then v_total else 0 end,
         recibido_id = v_rec
   where id = v_id;
  if v_rec is not null then update public.fe_recibidos set entrada_id = v_id, proveedor_id = coalesce(proveedor_id, v_prov_id) where id = v_rec; end if;
  return v_res || jsonb_build_object('condicion', v_cond, 'vence', v_vence, 'saldo', case when v_cond = 'credito' then v_total else 0 end);
end $$;
revoke all on function public.registrar_compra(jsonb) from public, anon;
grant execute on function public.registrar_compra(jsonb) to authenticated;

-- p = {"entrada_id", "monto", "metodo", "fecha", "referencia", "nota", "de_caja": true|false}
create or replace function public.pagar_proveedor(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  e record; v_monto numeric; v_metodo text := coalesce(p ->> 'metodo', ''); v_fecha date; v_id bigint; v_mov bigint;
  v_caja boolean := coalesce((p ->> 'de_caja')::boolean, false);
  v_ref text := nullif(left(trim(coalesce(p ->> 'referencia', '')), 60), '');
  v_nota text := nullif(left(trim(coalesce(p ->> 'nota', '')), 300), '');
begin
  if not public.puede('compras') then raise exception 'No tiene permiso para esto.' using errcode = '42501'; end if;
  select en.*, pv.nombre as prov_nombre into e
    from public.entradas en left join public.proveedores pv on pv.id = en.proveedor_id
   where en.id = nullif(p ->> 'entrada_id', '')::bigint for update of en;
  if e.id is null then raise exception 'Esa compra no existe.' using errcode = 'P0001'; end if;
  if e.estado <> 'aplicada' then raise exception 'Esa compra está anulada.' using errcode = 'P0001'; end if;
  if e.condicion <> 'credito' or e.saldo <= 0 then raise exception 'Esa compra no tiene saldo pendiente.' using errcode = 'P0001'; end if;
  if coalesce(p ->> 'monto', '') !~ '^[0-9]{1,12}(\.[0-9]{1,2})?$' then raise exception 'Revise el monto.' using errcode = 'P0001'; end if;
  v_monto := (p ->> 'monto')::numeric;
  if v_monto <= 0 then raise exception 'El monto tiene que ser mayor que 0.' using errcode = 'P0001'; end if;
  if v_monto > e.saldo then raise exception 'El pago (%) es mayor que lo que se debe (%).', v_monto, e.saldo using errcode = 'P0001'; end if;
  if v_metodo not in ('efectivo','transferencia','sinpe','cheque','tarjeta','otro') then raise exception 'Escoja cómo se pagó.' using errcode = 'P0001'; end if;
  if v_caja and v_metodo <> 'efectivo' then raise exception 'Solo un pago en efectivo sale de la caja.' using errcode = 'P0001'; end if;
  begin v_fecha := coalesce(nullif(p ->> 'fecha', '')::date, (now() at time zone 'America/Costa_Rica')::date);
  exception when others then raise exception 'Revise la fecha.' using errcode = 'P0001'; end;
  if v_fecha > (now() at time zone 'America/Costa_Rica')::date then raise exception 'La fecha no puede ser futura.' using errcode = 'P0001'; end if;
  perform set_config('lc.bitacora_origen', 'pago a proveedor', true);
  if v_caja then
    -- mover_caja revisa el permiso de caja y que haya una caja abierta
    v_mov := public.mover_caja('salida', v_monto,
               left('Pago a proveedor: ' || coalesce(e.prov_nombre, e.proveedor, 'proveedor') || coalesce(' · factura ' || e.documento, ''), 200));
  end if;
  insert into public.pagos_proveedor (entrada_id, proveedor_id, fecha, monto, metodo, referencia, nota, de_caja, caja_mov_id)
  values (e.id, e.proveedor_id, v_fecha, v_monto, v_metodo, v_ref, v_nota, v_caja, v_mov)
  returning id into v_id;
  update public.entradas set saldo = saldo - v_monto where id = e.id;
  return jsonb_build_object('id', v_id, 'saldo', e.saldo - v_monto, 'caja_mov', v_mov);
end $$;
revoke all on function public.pagar_proveedor(jsonb) from public, anon;
grant execute on function public.pagar_proveedor(jsonb) to authenticated;

create or replace function public.anular_pago_proveedor(p_id bigint, p_motivo text)
returns void language plpgsql security definer set search_path = '' as $$
declare pg record; v_mov bigint;
begin
  if not public.puede('compras') then raise exception 'No tiene permiso para esto.' using errcode = '42501'; end if;
  if char_length(trim(coalesce(p_motivo, ''))) < 3 then raise exception 'Escriba el motivo.' using errcode = 'P0001'; end if;
  select * into pg from public.pagos_proveedor where id = p_id for update;
  if pg.id is null then raise exception 'Ese pago no existe.' using errcode = 'P0001'; end if;
  if pg.anulado then raise exception 'Ese pago ya está anulado.' using errcode = 'P0001'; end if;
  perform set_config('lc.bitacora_origen', 'anulación de pago a proveedor', true);
  if pg.de_caja then
    -- la plata vuelve a la caja abierta (si se pagó en otro turno, igual entra en la caja de ahora)
    v_mov := public.mover_caja('entrada', pg.monto, left('Anulación de pago a proveedor: ' || trim(p_motivo), 200));
  end if;
  update public.pagos_proveedor set anulado = true, motivo_anulacion = left(trim(p_motivo), 300), anulado_at = now() where id = p_id;
  update public.entradas set saldo = saldo + pg.monto where id = pg.entrada_id;
end $$;
revoke all on function public.anular_pago_proveedor(bigint, text) from public, anon;
grant execute on function public.anular_pago_proveedor(bigint, text) to authenticated;

-- Lo que se le debe a cada proveedor
create or replace view public.v_cuentas_pagar with (security_invoker = true) as
select en.id as entrada_id, en.fecha, en.vence, en.documento, en.total_factura, en.saldo, en.nota,
       en.proveedor_id, coalesce(pv.nombre, en.proveedor) as proveedor, pv.telefono,
       ((now() at time zone 'America/Costa_Rica')::date - en.vence) as dias_vencida
  from public.entradas en
  left join public.proveedores pv on pv.id = en.proveedor_id
 where en.estado = 'aplicada' and en.condicion = 'credito' and en.saldo > 0;
revoke all on public.v_cuentas_pagar from anon, authenticated;
grant select on public.v_cuentas_pagar to authenticated;

-- ---------------------------------------------------------------------
-- 3b. Bitácora: las tablas nuevas también quedan anotadas
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  if to_regprocedure('public.registrar_auditoria()') is null then return; end if;
  foreach t in array array['ajustes_inventario', 'proveedores', 'pagos_proveedor', 'fe_recibidos'] loop
    execute format('drop trigger if exists trg_auditoria on public.%I', t);
    execute format('create trigger trg_auditoria after insert or update or delete on public.%I
                    for each row when (auth.uid() is not null)
                    execute function public.registrar_auditoria()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. Revisión de arranque: qué falta para dejar Moriah
-- ---------------------------------------------------------------------
create or replace function public.revisar_arranque()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  r jsonb := '[]'::jsonb;
  n bigint; m bigint; k bigint; v_sin bigint; t text; e record;
begin
  if not public.is_admin() then raise exception 'Solo el administrador.' using errcode = '42501'; end if;

  -- archivos SQL corridos
  t := concat_ws(', ',
         case when to_regclass('public.fe_dispositivos') is null then 'v19' end,
         case when not exists (select 1 from pg_constraint where conname = 'fe_emisor_actividad_check'
                               and pg_get_constraintdef(oid) like '%\.%') then 'v20' end,
         case when not exists (select 1 from information_schema.columns where table_schema = 'public'
                               and table_name = 'pedidos' and column_name = 'apartado') then 'v18' end);
  r := r || jsonb_build_object('grupo', 'Sistema', 'que', 'Archivos SQL al día', 'ok', t = '',
                               'detalle', case when t = '' then 'v18, v19, v20 y v21 corridos' else 'Falta correr: ' || t end);

  -- usuarios
  select count(*) filter (where rol = 'administrador' and activo), count(*) filter (where rol = 'usuario' and activo),
         count(*) filter (where rol = 'usuario' and activo and not pide_codigo and permisos && array['anular','precios','inventario','compras'])
    into n, m, k from public.admins;
  r := r || jsonb_build_object('grupo', 'Usuarios', 'que', 'Administrador con autenticador', 'ok', n >= 1,
                               'detalle', n || case when n = 1 then ' administrador' else ' administradores' end);
  r := r || jsonb_build_object('grupo', 'Usuarios', 'que', 'Empleados creados', 'ok', m >= 1,
                               'detalle', case when m = 0 then 'Todavía no hay empleados (Marvin, Thomas…)' else m || ' empleado' || case when m = 1 then '' else 's' end || ' activo' || case when m = 1 then '' else 's' end end);
  r := r || jsonb_build_object('grupo', 'Usuarios', 'que', 'Permisos delicados con código del celular', 'ok', k = 0, 'aviso', true,
                               'detalle', case when k = 0 then 'Bien' else k || ' empleado(s) pueden anular, cambiar precios o mover inventario sin el código del autenticador' end);

  -- datos del negocio
  select count(*) filter (where clave in ('telefono','whatsapp','direccion','sinpe_numero') and nullif(trim(valor), '') is not null) into n
    from public.ajustes;
  r := r || jsonb_build_object('grupo', 'Negocio', 'que', 'Datos del negocio (teléfono, WhatsApp, dirección, SINPE)', 'ok', n >= 4,
                               'detalle', case when n >= 4 then 'Completos' else 'Faltan datos en Datos del negocio' end);

  -- productos (los que están a la venta)
  select count(*), count(*) filter (where precio is null or precio <= 0), count(*) filter (where cabys is null),
         count(*) filter (where existencia is null)
    into n, m, k, v_sin from public.productos where coalesce(activo, true);
  r := r || jsonb_build_object('grupo', 'Productos', 'que', 'Productos cargados', 'ok', n >= 50,
                               'detalle', n || ' productos a la venta');
  r := r || jsonb_build_object('grupo', 'Productos', 'que', 'Todos con precio', 'ok', m = 0, 'aviso', true,
                               'detalle', case when m = 0 then 'Bien' else m || ' sin precio (salen como "precio a consultar")' end);
  r := r || jsonb_build_object('grupo', 'Productos', 'que', 'Todos con CABYS (para facturar)', 'ok', k = 0,
                               'detalle', case when k = 0 then 'Bien' else k || ' sin CABYS: no se pueden facturar' end);
  r := r || jsonb_build_object('grupo', 'Productos', 'que', 'Existencias de Moriah', 'ok', v_sin = 0, 'aviso', true,
                               'detalle', case when v_sin = 0 then 'Todos llevan existencia' else v_sin || ' productos no llevan existencia (vuelva a importar el Excel de Moriah el día del cambio)' end);

  -- crédito
  if to_regclass('public.clientes') is not null then
    execute 'select count(*) from public.clientes' into n;
    r := r || jsonb_build_object('grupo', 'Crédito', 'que', 'Clientes y saldos de Moriah', 'ok', n > 0, 'aviso', true,
                                 'detalle', case when n = 0 then 'Todavía no hay clientes de crédito (Crédito → Pasar saldos de Moriah)' else n || ' clientes' end);
  end if;

  -- caja
  if to_regclass('public.caja_turnos') is not null then
    execute 'select count(*) from public.caja_turnos where estado = ''cerrada''' into n;
    r := r || jsonb_build_object('grupo', 'Caja', 'que', 'Caja probada (abrir y cerrar)', 'ok', n > 0,
                                 'detalle', case when n = 0 then 'Nunca se ha cerrado una caja: haga una prueba con Marvin' else n || ' cierres' end);
  end if;

  -- facturación electrónica
  select * into e from public.fe_emisor where id = 1;
  r := r || jsonb_build_object('grupo', 'Facturación', 'que', 'Datos del emisor', 'ok', e.identificacion is not null and e.actividad is not null,
                               'detalle', case when e.identificacion is null then 'Sin configurar' else coalesce(e.nombre, '') || ' · ' || e.identificacion end);
  select count(*) filter (where estado = 'aceptado'), count(*) filter (where estado in ('firmado','enviado','procesando','error'))
    into n, m from public.fe_documentos where ambiente = coalesce(e.ambiente, 'pruebas');
  r := r || jsonb_build_object('grupo', 'Facturación', 'que', 'Comprobante aceptado por Hacienda (' || coalesce(e.ambiente, 'pruebas') || ')', 'ok', n > 0,
                               'detalle', case when n = 0 then 'Todavía ninguno: emita un tiquete de prueba' else n || ' aceptados' end);
  r := r || jsonb_build_object('grupo', 'Facturación', 'que', 'Ambiente de producción', 'ok', e.ambiente = 'produccion' and e.activo,
                               'detalle', case when coalesce(e.activo, false) = false then 'Apagada'
                                               when e.ambiente = 'pruebas' then 'Encendida en PRUEBAS (no cuenta para Hacienda)'
                                               else 'Encendida en producción' end);
  r := r || jsonb_build_object('grupo', 'Facturación', 'que', 'Comprobantes sin terminar', 'ok', m = 0,
                               'detalle', case when m = 0 then 'Ninguno' else m || ' sin respuesta de Hacienda (Comprobantes)' end);
  select count(*) into n from public.fe_recibidos where estado in ('nuevo','error');
  r := r || jsonb_build_object('grupo', 'Facturación', 'que', 'Facturas de proveedores por contestar', 'ok', n = 0, 'aviso', true,
                               'detalle', case when n = 0 then 'Ninguna' else n || ' sin aceptar o rechazar' end);

  -- compras
  select count(*) into n from public.entradas where estado = 'aplicada' and saldo > 0 and vence < (now() at time zone 'America/Costa_Rica')::date;
  r := r || jsonb_build_object('grupo', 'Compras', 'que', 'Facturas de proveedores vencidas', 'ok', n = 0, 'aviso', true,
                               'detalle', case when n = 0 then 'Ninguna' else n || ' vencidas' end);

  return r;
end $$;
revoke all on function public.revisar_arranque() from public, anon;
grant execute on function public.revisar_arranque() to authenticated;
