-- =====================================================================
--  Almacén La Campiña — Esquema Supabase (v3)
--  Catálogo · pedidos web con código · ventas y pagos SINPE · panel con MFA
--
--  Pegar COMPLETO en: Supabase > SQL Editor > New query > Run
--  Es idempotente: se puede volver a correr sin perder ventas ni productos.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. LIMPIEZA DE VERSIONES ANTERIORES (v1/v2)
--    Las "cotizaciones" se reemplazan por pedidos web con código.
-- ---------------------------------------------------------------------
drop trigger  if exists trg_limitar_cotizaciones on public.cotizaciones;
drop function if exists public.limitar_cotizaciones() cascade;
drop table    if exists public.cotizaciones cascade;

-- ---------------------------------------------------------------------
-- 1. CATÁLOGO, AJUSTES, ADMINS, BITÁCORA
-- ---------------------------------------------------------------------
create table if not exists public.categorias (
  id          bigint generated always as identity primary key,
  nombre      text not null check (char_length(nombre) between 2 and 60),
  icono       text default '' check (char_length(icono) <= 8),   -- ya no se usa en el sitio
  orden       int  default 0,
  created_at  timestamptz default now()
);

create table if not exists public.productos (
  id           bigint generated always as identity primary key,
  nombre       text not null check (char_length(nombre) between 2 and 100),
  descripcion  text check (char_length(descripcion) <= 500),
  precio       numeric(12,2) check (precio is null or precio >= 0),   -- null = "precio a consultar"
  unidad       text check (char_length(unidad) <= 30),
  categoria_id bigint references public.categorias(id) on delete set null,
  imagen_url   text check (imagen_url is null or imagen_url ~ '^https://'),
  destacado    boolean default false,
  activo       boolean default true,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create table if not exists public.ajustes (
  clave  text primary key,
  valor  text check (char_length(valor) <= 1000)
);
alter table public.ajustes drop constraint if exists ajustes_clave_check;
alter table public.ajustes drop constraint if exists ajuste_clave_valida;
alter table public.ajustes add constraint ajuste_clave_valida check (clave in
  ('telefono','whatsapp','telefono2','direccion','horario','horario_semana','facebook','aviso',
   'sinpe_numero','sinpe_titular'));
alter table public.ajustes drop constraint if exists ajuste_whatsapp;
alter table public.ajustes add constraint ajuste_whatsapp check (clave <> 'whatsapp' or valor ~ '^[0-9]{11,15}$');
alter table public.ajustes drop constraint if exists ajuste_facebook;
alter table public.ajustes add constraint ajuste_facebook check (clave <> 'facebook' or valor is null or valor = '' or valor ~ '^https://');
alter table public.ajustes drop constraint if exists ajuste_sinpe;
alter table public.ajustes add constraint ajuste_sinpe check (clave <> 'sinpe_numero' or valor is null or valor = '' or valor ~ '^[0-9]{8}$');

-- Quién es administrador (no basta con tener usuario)
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz default now()
);

-- Bitácora de cambios hechos desde el panel
create table if not exists public.auditoria (
  id         bigint generated always as identity primary key,
  user_id    uuid,
  tabla      text,
  accion     text,
  registro   text,
  creado     timestamptz default now()
);

create index if not exists productos_categoria_idx on public.productos(categoria_id);

-- ---------------------------------------------------------------------
-- 2. FUNCIONES DE SEGURIDAD
-- ---------------------------------------------------------------------
-- Admin = está en la tabla admins Y entró con 2 pasos (MFA / aal2).
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid())
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';   -- <- exigir MFA
$$;

-- Para que el panel sepa si el usuario está en la lista (antes de pedir el código)
create or replace function public.soy_admin_registrado()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

revoke all on function public.is_admin() from public;
revoke all on function public.soy_admin_registrado() from public;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.soy_admin_registrado() to authenticated;

create or replace function public.registrar_auditoria()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.auditoria(user_id, tabla, accion, registro)
  values (auth.uid(), tg_table_name, tg_op,
          coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id',
                   to_jsonb(new) ->> 'clave', to_jsonb(old) ->> 'clave'));
  return coalesce(new, old);
end $$;

create or replace function public.tocar_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists trg_productos_updated on public.productos;
create trigger trg_productos_updated before update on public.productos
  for each row execute function public.tocar_updated_at();

-- ---------------------------------------------------------------------
-- 3. VENTAS / PEDIDOS Y PAGOS
--    Reglas que hace cumplir la base de datos:
--    · total y saldos los calcula la BD (precios del catálogo, no del navegador)
--    · un comprobante SINPE no se puede usar dos veces
--    · "pagado" solo con pagos VERIFICADOS en el banco
--    · los pagos no se borran: se anulan con motivo
-- ---------------------------------------------------------------------
create or replace function public.nuevo_codigo_pedido()
returns text language plpgsql volatile set search_path = '' as $$
declare
  alf text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   -- sin 0/O/1/I para no confundir
  c text;
begin
  loop
    c := 'LC';
    for i in 1..6 loop
      c := c || substr(alf, 1 + floor(random() * length(alf))::int, 1);
    end loop;
    exit when not exists (select 1 from public.pedidos where codigo = c);
  end loop;
  return c;
end $$;

create table if not exists public.pedidos (
  id                 bigint generated always as identity primary key,
  codigo             text not null unique default public.nuevo_codigo_pedido(),
  origen             text not null default 'panel' check (origen in ('panel','web')),
  revisado           boolean not null default true,
  cliente_nombre     text not null check (char_length(cliente_nombre) between 2 and 80),
  cliente_telefono   text check (cliente_telefono is null or cliente_telefono ~ '^[0-9 +()-]{8,20}$'),
  nota               text check (char_length(nota) <= 500),
  estado             text not null default 'abierta' check (estado in ('abierta','entregada','anulada')),
  estado_pago        text not null default 'sin_pago'
                     check (estado_pago in ('sin_pago','parcial','por_verificar','pagado','sobrepago')),
  total              numeric(12,2) not null default 0,
  pagado_registrado  numeric(12,2) not null default 0,
  pagado_verificado  numeric(12,2) not null default 0,
  motivo_anulacion   text check (char_length(motivo_anulacion) <= 300),
  entregada_at       timestamptz,
  created_by         uuid default auth.uid(),
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);
alter table public.pedidos add column if not exists origen text not null default 'panel';
alter table public.pedidos add column if not exists revisado boolean not null default true;
alter table public.pedidos drop column if exists cotizacion_id;

create table if not exists public.pedido_items (
  id            bigint generated always as identity primary key,
  pedido_id     bigint not null references public.pedidos(id) on delete cascade,
  producto_id   bigint references public.productos(id) on delete set null,
  descripcion   text not null check (char_length(descripcion) between 1 and 120),
  cantidad      numeric(10,2) not null check (cantidad > 0 and cantidad <= 100000),
  precio_unit   numeric(12,2) not null default 0 check (precio_unit >= 0),
  subtotal      numeric(14,2) generated always as (round(cantidad * precio_unit, 2)) stored
);

create table if not exists public.pagos (
  id                bigint generated always as identity primary key,
  pedido_id         bigint not null references public.pedidos(id) on delete restrict,
  metodo            text not null default 'sinpe' check (metodo in ('sinpe','efectivo','tarjeta','transferencia')),
  monto             numeric(12,2) not null check (monto > 0 and monto <= 50000000),
  referencia        text check (referencia is null or referencia ~ '^[0-9A-Za-z-]{4,40}$'),
  telefono_origen   text check (telefono_origen is null or telefono_origen ~ '^[0-9 +()-]{8,20}$'),
  nombre_origen     text check (char_length(nombre_origen) <= 100),
  fecha             timestamptz not null default now(),
  comprobante_path  text,
  nota              text check (char_length(nota) <= 300),
  verificado        boolean not null default false,
  verificado_at     timestamptz,
  verificado_por    uuid,
  anulado           boolean not null default false,
  motivo_anulacion  text check (char_length(motivo_anulacion) <= 300),
  created_by        uuid default auth.uid(),
  created_at        timestamptz default now(),
  constraint sinpe_con_referencia check (metodo not in ('sinpe','transferencia') or referencia is not null)
);
alter table public.pagos drop constraint if exists pagos_comprobante_path_check;
alter table public.pagos drop constraint if exists pago_ruta_valida;
alter table public.pagos add constraint pago_ruta_valida check
  (comprobante_path is null or comprobante_path ~ '^(web/[0-9]+/)?[0-9a-f-]{36}\.(webp|jpg|png|pdf)$');

create unique index if not exists pagos_referencia_unica
  on public.pagos (metodo, upper(referencia)) where referencia is not null and not anulado;
create index if not exists pagos_fecha_idx   on public.pagos (fecha desc);
create index if not exists pagos_pedido_idx  on public.pagos (pedido_id);
create index if not exists pedidos_fecha_idx on public.pedidos (created_at desc);
create index if not exists items_pedido_idx  on public.pedido_items (pedido_id);

-- Recalcula total, cobrado y estado de pago
create or replace function public.recalcular_pedido(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare t numeric; reg numeric; ver numeric; ep text;
begin
  select coalesce(sum(subtotal), 0) into t from public.pedido_items where pedido_id = p_id;
  select coalesce(sum(monto) filter (where not anulado), 0),
         coalesce(sum(monto) filter (where not anulado and verificado), 0)
    into reg, ver
    from public.pagos where pedido_id = p_id;
  ep := case
          when t = 0 and reg = 0 then 'sin_pago'
          when ver > t then 'sobrepago'
          when ver = t and t > 0 then 'pagado'
          when reg >= t and t > 0 then 'por_verificar'
          when reg > 0 then 'parcial'
          else 'sin_pago'
        end;
  update public.pedidos
     set total = t, pagado_registrado = reg, pagado_verificado = ver, estado_pago = ep, updated_at = now()
   where id = p_id;
end $$;
revoke all on function public.recalcular_pedido(bigint) from public, anon, authenticated;

create or replace function public.trg_recalcular()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.recalcular_pedido(coalesce(new.pedido_id, old.pedido_id));
  if tg_op = 'UPDATE' and new.pedido_id <> old.pedido_id then
    perform public.recalcular_pedido(old.pedido_id);
  end if;
  return null;
end $$;

drop trigger if exists trg_items_recalcular on public.pedido_items;
create trigger trg_items_recalcular after insert or update or delete on public.pedido_items
  for each row execute function public.trg_recalcular();
drop trigger if exists trg_pagos_recalcular on public.pagos;
create trigger trg_pagos_recalcular after insert or update on public.pagos
  for each row execute function public.trg_recalcular();

create or replace function public.validar_pedido()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.estado <> 'abierta' or exists (select 1 from public.pagos where pedido_id = old.id) then
      raise exception 'Esta venta tiene pagos o ya se cerró: anúlela en vez de borrarla.' using errcode = 'P0001';
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
  end if;
  if new.estado = 'entregada' and old.estado <> 'entregada' then
    new.entregada_at := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_validar_pedido on public.pedidos;
create trigger trg_validar_pedido before update or delete on public.pedidos
  for each row execute function public.validar_pedido();

create or replace function public.validar_items()
returns trigger language plpgsql set search_path = '' as $$
declare p record;
begin
  select estado, pagado_verificado into p from public.pedidos where id = coalesce(new.pedido_id, old.pedido_id);
  if p.estado <> 'abierta' then
    raise exception 'La venta ya está cerrada; sus productos no se pueden cambiar.' using errcode = 'P0001';
  end if;
  if p.pagado_verificado > 0 then
    raise exception 'La venta ya tiene pagos verificados; sus productos no se pueden cambiar.' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_validar_items on public.pedido_items;
create trigger trg_validar_items before insert or update or delete on public.pedido_items
  for each row execute function public.validar_items();

create or replace function public.validar_pago()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if (select estado from public.pedidos where id = new.pedido_id) = 'anulada' then
      raise exception 'No se pueden registrar pagos en una venta anulada.' using errcode = 'P0001';
    end if;
    if new.fecha > now() + interval '10 minutes' then
      raise exception 'La fecha del pago no puede ser futura.' using errcode = 'P0001';
    end if;
    new.anulado := false;
    new.created_by := auth.uid();
    new.created_at := now();
    if new.verificado then new.verificado_at := now(); new.verificado_por := auth.uid();
    else new.verificado_at := null; new.verificado_por := null; end if;
    return new;
  end if;

  if old.anulado then
    raise exception 'Este pago ya está anulado y no se puede modificar.' using errcode = 'P0001';
  end if;
  if new.pedido_id <> old.pedido_id or new.monto <> old.monto or new.metodo <> old.metodo
     or new.referencia is distinct from old.referencia or new.fecha <> old.fecha then
    raise exception 'Los datos de un pago no se editan: anúlelo y regístrelo de nuevo.' using errcode = 'P0001';
  end if;
  if old.verificado and not new.verificado then
    raise exception 'Un pago verificado no se puede desmarcar. Si fue un error, anúlelo con su motivo.' using errcode = 'P0001';
  end if;
  if new.verificado and not old.verificado then
    new.verificado_at := now(); new.verificado_por := auth.uid();
  else
    new.verificado_at := old.verificado_at; new.verificado_por := old.verificado_por;
  end if;
  if new.anulado and char_length(coalesce(trim(new.motivo_anulacion), '')) < 5 then
    raise exception 'Escriba el motivo de la anulación del pago.' using errcode = 'P0001';
  end if;
  if old.comprobante_path is not null and new.comprobante_path is distinct from old.comprobante_path then
    raise exception 'El comprobante ya adjunto no se puede reemplazar.' using errcode = 'P0001';
  end if;
  new.created_by := old.created_by; new.created_at := old.created_at;
  return new;
end $$;

drop trigger if exists trg_validar_pago on public.pagos;
create trigger trg_validar_pago before insert or update on public.pagos
  for each row execute function public.validar_pago();

create or replace view public.v_caja_diaria with (security_invoker = true) as
select (p.fecha at time zone 'America/Costa_Rica')::date as dia,
       p.metodo,
       count(*) filter (where not p.anulado)                                   as pagos,
       coalesce(sum(p.monto) filter (where not p.anulado), 0)                  as total,
       coalesce(sum(p.monto) filter (where not p.anulado and p.verificado), 0) as verificado,
       coalesce(sum(p.monto) filter (where not p.anulado and not p.verificado), 0) as por_verificar
  from public.pagos p
 group by 1, 2;

-- ---------------------------------------------------------------------
-- 4. PEDIDOS WEB DE CLIENTES (sin cuenta: código + teléfono)
--    El navegador del cliente NO toca tablas: solo llama estas funciones,
--    que validan todo, ponen los precios del catálogo y limitan abusos.
-- ---------------------------------------------------------------------
create table if not exists public.comprobantes_cliente (
  id                    bigint generated always as identity primary key,
  pedido_id             bigint not null references public.pedidos(id) on delete restrict,
  ruta                  text not null unique check (ruta ~ '^web/[0-9]+/[0-9a-f-]{36}\.(webp|jpg|png|pdf)$'),
  monto_reportado       numeric(12,2) check (monto_reportado is null or (monto_reportado > 0 and monto_reportado <= 50000000)),
  referencia_reportada  text check (referencia_reportada is null or referencia_reportada ~ '^[0-9A-Za-z-]{4,40}$'),
  nota                  text check (char_length(nota) <= 300),
  estado                text not null default 'nuevo' check (estado in ('nuevo','registrado','rechazado')),
  motivo_rechazo        text check (char_length(motivo_rechazo) <= 300),
  pago_id               bigint references public.pagos(id),
  created_at            timestamptz default now(),
  constraint registrado_con_pago check (estado <> 'registrado' or pago_id is not null),
  constraint rechazo_con_motivo  check (estado <> 'rechazado' or char_length(coalesce(motivo_rechazo, '')) >= 5)
);
create index if not exists comp_cliente_pedido_idx on public.comprobantes_cliente (pedido_id);

create table if not exists public.subidas_permitidas (
  ruta       text primary key,
  pedido_id  bigint not null references public.pedidos(id) on delete cascade,
  expira     timestamptz not null,
  usada      boolean not null default false,
  creada     timestamptz default now()
);

create table if not exists public.consultas_fallidas (
  id      bigint generated always as identity primary key,
  codigo  text,
  creado  timestamptz default now()
);
create index if not exists consultas_fallidas_idx on public.consultas_fallidas (creado desc);

-- Valida código + teléfono; registra intentos fallidos (no lanza error para no deshacer el registro)
create or replace function public._acceso_pedido(p_codigo text, p_telefono text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_cod text := upper(left(regexp_replace(coalesce(p_codigo, ''), '[^A-Za-z0-9]', '', 'g'), 12));
  v_dig text := right(regexp_replace(coalesce(p_telefono, ''), '[^0-9]', '', 'g'), 8);
  v_id  bigint;
begin
  if (select count(*) from public.consultas_fallidas where creado > now() - interval '1 minute') >= 30 then
    return jsonb_build_object('ok', false, 'error', 'Demasiados intentos. Espere un minuto.');
  end if;
  if (select count(*) from public.consultas_fallidas where codigo = v_cod and creado > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'Demasiados intentos con este código. Espere 15 minutos.');
  end if;
  if length(v_dig) = 8 then
    select id into v_id from public.pedidos
     where codigo = v_cod
       and right(regexp_replace(coalesce(cliente_telefono, ''), '[^0-9]', '', 'g'), 8) = v_dig;
  end if;
  if v_id is null then
    insert into public.consultas_fallidas(codigo) values (v_cod);
    delete from public.consultas_fallidas where creado < now() - interval '1 day';
    return jsonb_build_object('ok', false, 'error', 'No encontramos un pedido con ese código y teléfono.');
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
revoke all on function public._acceso_pedido(text, text) from public, anon, authenticated;

-- Crear pedido desde el sitio
create or replace function public.crear_pedido_web(p_nombre text, p_telefono text, p_nota text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_nombre text := trim(coalesce(p_nombre, ''));
  v_tel    text := trim(coalesce(p_telefono, ''));
  v_dig    text := regexp_replace(coalesce(p_telefono, ''), '[^0-9]', '', 'g');
  v_nota   text := nullif(trim(coalesce(p_nota, '')), '');
  v_id bigint; v_codigo text; it jsonb; v_cant numeric; v_desc text; n int := 0;
  v_pid bigint; v_pnombre text; v_punidad text; v_pprecio numeric;
begin
  if char_length(v_nombre) < 2 or char_length(v_nombre) > 80 then
    raise exception 'Escriba su nombre.' using errcode = 'P0001';
  end if;
  if v_tel !~ '^[0-9 +()-]{8,20}$' or length(v_dig) < 8 then
    raise exception 'Revise el teléfono: necesitamos 8 dígitos.' using errcode = 'P0001';
  end if;
  if v_nota is not null and char_length(v_nota) > 500 then
    raise exception 'La nota es muy larga.' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'El carrito está vacío.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) > 60 then
    raise exception 'El pedido tiene demasiados renglones (máximo 60).' using errcode = 'P0001';
  end if;
  -- anti-spam
  if (select count(*) from public.pedidos
       where origen = 'web' and created_at > now() - interval '15 minutes'
         and right(regexp_replace(coalesce(cliente_telefono, ''), '[^0-9]', '', 'g'), 8) = right(v_dig, 8)) >= 3 then
    raise exception 'Ya recibimos varios pedidos de este número. Intente en unos minutos o escríbanos por WhatsApp.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.pedidos where origen = 'web' and created_at > now() - interval '1 minute') >= 15 then
    raise exception 'Estamos recibiendo muchos pedidos. Intente en un minuto.' using errcode = 'P0001';
  end if;

  insert into public.pedidos (cliente_nombre, cliente_telefono, nota, origen, revisado, created_by)
  values (v_nombre, v_tel, v_nota, 'web', false, null)
  returning id, codigo into v_id, v_codigo;

  for it in select * from jsonb_array_elements(p_items) loop
    continue when jsonb_typeof(it) <> 'object';
    v_cant := case when (it ->> 'c') ~ '^[0-9]{1,3}(\.[0-9]{1,2})?$'
                   then least(greatest((it ->> 'c')::numeric, 1), 999) else 1 end;
    v_pid := null; v_pnombre := null; v_punidad := null; v_pprecio := null;
    if (it ->> 'id') ~ '^[0-9]{1,15}$' then
      select id, nombre, unidad, precio into v_pid, v_pnombre, v_punidad, v_pprecio
        from public.productos where id = (it ->> 'id')::bigint and activo;
    end if;
    if v_pid is not null then
      insert into public.pedido_items (pedido_id, producto_id, descripcion, cantidad, precio_unit)
      values (v_id, v_pid, left(v_pnombre || coalesce(' (' || nullif(v_punidad, '') || ')', ''), 120),
              v_cant, coalesce(v_pprecio, 0));
    else
      v_desc := left(trim(regexp_replace(coalesce(it ->> 'n', ''), '\s+', ' ', 'g')), 120);
      continue when char_length(v_desc) < 2;
      insert into public.pedido_items (pedido_id, producto_id, descripcion, cantidad, precio_unit)
      values (v_id, null, v_desc, v_cant, 0);
    end if;
    n := n + 1;
  end loop;

  if n = 0 then
    raise exception 'El carrito está vacío.' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'codigo', v_codigo,
    'total', (select total from public.pedidos where id = v_id),
    'precios_pendientes', exists (select 1 from public.pedido_items where pedido_id = v_id and precio_unit = 0)
  );
end $$;

-- Consultar pedido (cliente)
create or replace function public.consultar_pedido(p_codigo text, p_telefono text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb; p record;
begin
  a := public._acceso_pedido(p_codigo, p_telefono);
  if not (a ->> 'ok')::boolean then return a; end if;
  select * into p from public.pedidos where id = (a ->> 'id')::bigint;
  return jsonb_build_object(
    'ok', true,
    'codigo', p.codigo,
    'fecha', p.created_at,
    'cliente', p.cliente_nombre,
    'estado', p.estado,
    'estado_pago', p.estado_pago,
    'total', p.total,
    'pagado_verificado', p.pagado_verificado,
    'entregada_at', p.entregada_at,
    'precios_pendientes', exists (select 1 from public.pedido_items where pedido_id = p.id and precio_unit = 0),
    'items', coalesce((select jsonb_agg(jsonb_build_object('d', descripcion, 'c', cantidad, 'p', precio_unit, 's', subtotal) order by id)
                         from public.pedido_items where pedido_id = p.id), '[]'::jsonb),
    'comprobantes', coalesce((select jsonb_agg(jsonb_build_object('fecha', created_at, 'estado', estado, 'motivo', motivo_rechazo, 'monto', monto_reportado) order by id)
                                from public.comprobantes_cliente where pedido_id = p.id), '[]'::jsonb),
    'sinpe_numero', (select valor from public.ajustes where clave = 'sinpe_numero'),
    'sinpe_titular', (select valor from public.ajustes where clave = 'sinpe_titular')
  );
end $$;

-- Pedir permiso para subir UN comprobante (devuelve la ruta exacta autorizada, vence en 15 min)
create or replace function public.solicitar_subida(p_codigo text, p_telefono text, p_ext text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb; v_id bigint; v_ruta text; v_ext text := lower(coalesce(p_ext, ''));
begin
  if v_ext not in ('webp','jpg','png','pdf') then
    return jsonb_build_object('ok', false, 'error', 'Formato no permitido. Use foto (JPG, PNG, WebP) o PDF.');
  end if;
  a := public._acceso_pedido(p_codigo, p_telefono);
  if not (a ->> 'ok')::boolean then return a; end if;
  v_id := (a ->> 'id')::bigint;
  if (select estado from public.pedidos where id = v_id) = 'anulada' then
    return jsonb_build_object('ok', false, 'error', 'Este pedido está anulado.');
  end if;
  if (select count(*) from public.subidas_permitidas where pedido_id = v_id and creada > now() - interval '1 day') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'Ya se enviaron varios comprobantes hoy para este pedido. Escríbanos por WhatsApp.');
  end if;
  if (select count(*) from public.subidas_permitidas where creada > now() - interval '1 minute') >= 20 then
    return jsonb_build_object('ok', false, 'error', 'Mucho movimiento en este momento. Intente en un minuto.');
  end if;
  v_ruta := 'web/' || v_id || '/' || gen_random_uuid() || '.' || v_ext;
  insert into public.subidas_permitidas (ruta, pedido_id, expira) values (v_ruta, v_id, now() + interval '15 minutes');
  return jsonb_build_object('ok', true, 'ruta', v_ruta);
end $$;

-- Usado por la regla de Storage: ¿esta ruta fue autorizada y sigue vigente?
create or replace function public.subida_autorizada(p_ruta text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.subidas_permitidas where ruta = p_ruta and not usada and expira > now());
$$;

-- Avisar que el comprobante ya se subió
create or replace function public.reportar_comprobante(p_codigo text, p_telefono text, p_ruta text,
                                                       p_monto numeric, p_referencia text, p_nota text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb; v_id bigint; v_ref text := nullif(regexp_replace(coalesce(p_referencia, ''), '\s', '', 'g'), '');
begin
  a := public._acceso_pedido(p_codigo, p_telefono);
  if not (a ->> 'ok')::boolean then return a; end if;
  v_id := (a ->> 'id')::bigint;
  if not exists (select 1 from public.subidas_permitidas where ruta = p_ruta and pedido_id = v_id and not usada) then
    return jsonb_build_object('ok', false, 'error', 'La subida no es válida o ya se usó. Intente de nuevo.');
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'comprobantes' and name = p_ruta) then
    return jsonb_build_object('ok', false, 'error', 'No recibimos el archivo. Intente subirlo de nuevo.');
  end if;
  if p_monto is not null and (p_monto <= 0 or p_monto > 50000000) then
    return jsonb_build_object('ok', false, 'error', 'Revise el monto.');
  end if;
  if v_ref is not null and v_ref !~ '^[0-9A-Za-z-]{4,40}$' then
    return jsonb_build_object('ok', false, 'error', 'El número de comprobante solo lleva números, letras o guiones.');
  end if;
  update public.subidas_permitidas set usada = true where ruta = p_ruta;
  insert into public.comprobantes_cliente (pedido_id, ruta, monto_reportado, referencia_reportada, nota)
  values (v_id, p_ruta, p_monto, v_ref, left(nullif(trim(coalesce(p_nota, '')), ''), 300));
  update public.pedidos set revisado = false where id = v_id;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.crear_pedido_web(text, text, text, jsonb) from public;
revoke all on function public.consultar_pedido(text, text) from public;
revoke all on function public.solicitar_subida(text, text, text) from public;
revoke all on function public.reportar_comprobante(text, text, text, numeric, text, text) from public;
revoke all on function public.subida_autorizada(text) from public;
grant execute on function public.crear_pedido_web(text, text, text, jsonb) to anon, authenticated;
grant execute on function public.consultar_pedido(text, text) to anon, authenticated;
grant execute on function public.solicitar_subida(text, text, text) to anon, authenticated;
grant execute on function public.reportar_comprobante(text, text, text, numeric, text, text) to anon, authenticated;
grant execute on function public.subida_autorizada(text) to anon, authenticated;

-- El admin solo puede pasar un comprobante a "registrado" (con su pago) o "rechazado" (con motivo)
create or replace function public.validar_comprobante_cliente()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.estado <> 'nuevo' then
    raise exception 'Este comprobante ya fue procesado.' using errcode = 'P0001';
  end if;
  if new.pedido_id <> old.pedido_id or new.ruta <> old.ruta then
    raise exception 'No se puede mover un comprobante.' using errcode = 'P0001';
  end if;
  if new.estado = 'registrado' and not exists
     (select 1 from public.pagos where id = new.pago_id and pedido_id = new.pedido_id and comprobante_path = new.ruta) then
    raise exception 'El pago no corresponde a este comprobante.' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists trg_validar_comp_cliente on public.comprobantes_cliente;
create trigger trg_validar_comp_cliente before update on public.comprobantes_cliente
  for each row execute function public.validar_comprobante_cliente();

-- Auditoría
do $$
declare t text;
begin
  foreach t in array array['productos','categorias','ajustes','admins','pedidos','pedido_items','pagos','comprobantes_cliente'] loop
    execute format('drop trigger if exists trg_auditoria on public.%I', t);
    execute format('create trigger trg_auditoria after insert or update or delete on public.%I
                    for each row when (auth.uid() is not null)
                    execute function public.registrar_auditoria()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 5. PERMISOS (privilegios mínimos)
-- ---------------------------------------------------------------------
revoke all on public.categorias, public.productos, public.ajustes, public.admins, public.auditoria,
              public.pedidos, public.pedido_items, public.pagos, public.v_caja_diaria,
              public.comprobantes_cliente, public.subidas_permitidas, public.consultas_fallidas
  from anon, authenticated;

-- Visitantes: solo leer catálogo y ajustes (los pedidos van por funciones)
grant select on public.categorias, public.productos, public.ajustes to anon, authenticated;

-- Panel (las reglas RLS dejan pasar solo a admins con MFA)
grant insert, update, delete on public.categorias, public.productos, public.ajustes to authenticated;
grant select on public.auditoria to authenticated;
grant select on public.pedidos, public.pedido_items, public.pagos, public.v_caja_diaria, public.comprobantes_cliente to authenticated;
grant insert (cliente_nombre, cliente_telefono, nota) on public.pedidos to authenticated;
grant update (cliente_nombre, cliente_telefono, nota, estado, motivo_anulacion, revisado) on public.pedidos to authenticated;
grant delete on public.pedidos to authenticated;
grant insert (pedido_id, producto_id, descripcion, cantidad, precio_unit) on public.pedido_items to authenticated;
grant update (descripcion, cantidad, precio_unit) on public.pedido_items to authenticated;
grant delete on public.pedido_items to authenticated;
grant insert (pedido_id, metodo, monto, referencia, telefono_origen, nombre_origen, fecha, comprobante_path, nota, verificado)
  on public.pagos to authenticated;
grant update (verificado, anulado, motivo_anulacion, comprobante_path, nota) on public.pagos to authenticated;
grant update (estado, motivo_rechazo, pago_id) on public.comprobantes_cliente to authenticated;
-- (pagos y comprobantes nunca se borran; admins solo desde el SQL Editor)

-- ---------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.categorias           enable row level security;
alter table public.productos            enable row level security;
alter table public.ajustes              enable row level security;
alter table public.admins               enable row level security;
alter table public.auditoria            enable row level security;
alter table public.pedidos              enable row level security;
alter table public.pedido_items         enable row level security;
alter table public.pagos                enable row level security;
alter table public.comprobantes_cliente enable row level security;
alter table public.subidas_permitidas   enable row level security;
alter table public.consultas_fallidas   enable row level security;

drop policy if exists "categorias_lectura" on public.categorias;
drop policy if exists "categorias_admin"   on public.categorias;
drop policy if exists "productos_lectura"  on public.productos;
drop policy if exists "productos_admin"    on public.productos;
drop policy if exists "ajustes_lectura"    on public.ajustes;
drop policy if exists "ajustes_admin"      on public.ajustes;
drop policy if exists "auditoria_admin"    on public.auditoria;
drop policy if exists "pedidos_admin"      on public.pedidos;
drop policy if exists "items_admin"        on public.pedido_items;
drop policy if exists "pagos_admin"        on public.pagos;
drop policy if exists "comp_cliente_admin" on public.comprobantes_cliente;

create policy "categorias_lectura" on public.categorias for select using (true);
create policy "productos_lectura"  on public.productos  for select using (activo = true or public.is_admin());
create policy "ajustes_lectura"    on public.ajustes    for select using (true);

create policy "categorias_admin" on public.categorias for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "productos_admin"  on public.productos  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "ajustes_admin"    on public.ajustes    for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "auditoria_admin"  on public.auditoria  for select to authenticated using (public.is_admin());
create policy "pedidos_admin"    on public.pedidos      for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "items_admin"      on public.pedido_items for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "pagos_admin"      on public.pagos        for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "comp_cliente_admin" on public.comprobantes_cliente for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- admins, subidas_permitidas, consultas_fallidas: sin políticas = nadie desde la API

-- ---------------------------------------------------------------------
-- 7. STORAGE
-- ---------------------------------------------------------------------
-- Fotos de productos: públicas para ver, solo admin sube/borra
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('productos', 'productos', true, 2097152, array['image/webp','image/jpeg','image/png'])
on conflict (id) do update
  set public = true, file_size_limit = 2097152, allowed_mime_types = array['image/webp','image/jpeg','image/png'];

-- Comprobantes: PRIVADO. Se ven con enlaces temporales; no se borran ni reemplazan.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('comprobantes', 'comprobantes', false, 5242880, array['image/webp','image/jpeg','image/png','application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = 5242880,
      allowed_mime_types = array['image/webp','image/jpeg','image/png','application/pdf'];

drop policy if exists "productos_fotos_lectura"    on storage.objects;
drop policy if exists "productos_fotos_subir"      on storage.objects;
drop policy if exists "productos_fotos_editar"     on storage.objects;
drop policy if exists "productos_fotos_borrar"     on storage.objects;
drop policy if exists "productos_fotos_admin_ver"  on storage.objects;
drop policy if exists "comprobantes_ver"           on storage.objects;
drop policy if exists "comprobantes_subir"         on storage.objects;
drop policy if exists "comprobantes_cliente_subir" on storage.objects;

create policy "productos_fotos_subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'productos' and public.is_admin());
create policy "productos_fotos_editar" on storage.objects for update to authenticated
  using (bucket_id = 'productos' and public.is_admin());
create policy "productos_fotos_borrar" on storage.objects for delete to authenticated
  using (bucket_id = 'productos' and public.is_admin());
create policy "productos_fotos_admin_ver" on storage.objects for select to authenticated
  using (bucket_id = 'productos' and public.is_admin());

create policy "comprobantes_ver" on storage.objects for select to authenticated
  using (bucket_id = 'comprobantes' and public.is_admin());
create policy "comprobantes_subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'comprobantes' and public.is_admin());
-- Cliente sin cuenta: solo puede subir a la ruta exacta que le autorizó solicitar_subida()
create policy "comprobantes_cliente_subir" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'comprobantes' and public.subida_autorizada(name));

-- ---------------------------------------------------------------------
-- 8. DATOS INICIALES
-- ---------------------------------------------------------------------
insert into public.ajustes (clave, valor) values
  ('telefono',  '4711-8869'),
  ('whatsapp',  '50687365733'),
  ('telefono2', '8799-4646'),
  ('direccion', '150 m noreste del cruce de Perdiz, Barrio San Marcos, Cariari de Pococí, Limón'),
  ('horario',   'Consulte el horario por WhatsApp'),
  ('horario_semana', ''),
  ('facebook',  'https://www.facebook.com/p/Almacen-Campina-100092324825394/'),
  ('aviso',     ''),
  ('sinpe_numero',  ''),
  ('sinpe_titular', '')
on conflict (clave) do nothing;

insert into public.categorias (nombre, orden)
select * from (values
  ('Materiales de construcción', 1),
  ('Ferretería',                 2),
  ('Mascotas',                   3),
  ('Pesca',                      4),
  ('Cuidado del auto',           5),
  ('Agro y jardín',              6)
) v(nombre, orden)
where not exists (select 1 from public.categorias);

insert into public.productos (nombre, descripcion, unidad, categoria_id, destacado)
select v.nombre, v.descripcion, v.unidad, c.id, v.destacado
from (values
  ('Cemento gris',          'Saco para construcción general.',            'saco',   'Materiales de construcción', true),
  ('Varilla corrugada',     'Acero para refuerzo de columnas y vigas.',   'unidad', 'Materiales de construcción', false),
  ('Block de concreto',     'Para paredes, tapias y muros.',              'unidad', 'Materiales de construcción', false),
  ('Juego de herramientas', 'Lo básico para reparaciones en la casa.',    'juego',  'Ferretería',                 true),
  ('Alimento para perro',   'Alimento balanceado.',                       'saco',   'Mascotas',                   true),
  ('Carrete y caña',        'Equipo para pesca de río y mar.',            'unidad', 'Pesca',                      false),
  ('Limpiador de focos',    'Devuelve la transparencia a los focos del carro.', 'unidad', 'Cuidado del auto',     true)
) v(nombre, descripcion, unidad, cat, destacado)
join public.categorias c on c.nombre = v.cat
where not exists (select 1 from public.productos);

-- ---------------------------------------------------------------------
-- 9. REGISTRAR AL ADMINISTRADOR (después de crearlo en Authentication > Users)
-- ---------------------------------------------------------------------
-- insert into public.admins (user_id)
-- select id from auth.users where email = 'admin@ejemplo.com'
-- on conflict do nothing;
