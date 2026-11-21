-- =====================================================================
--  Almacén La Campiña — Esquema Supabase (v2, endurecido)
--  Pegar COMPLETO en: Supabase > SQL Editor > New query > Run
--  Es idempotente: se puede volver a correr sin perder datos.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABLAS
-- ---------------------------------------------------------------------
create table if not exists public.categorias (
  id          bigint generated always as identity primary key,
  nombre      text not null check (char_length(nombre) between 2 and 60),
  icono       text default '🧰' check (char_length(icono) <= 8),
  orden       int  default 0,
  created_at  timestamptz default now()
);

create table if not exists public.productos (
  id           bigint generated always as identity primary key,
  nombre       text not null check (char_length(nombre) between 2 and 100),
  descripcion  text check (char_length(descripcion) <= 500),
  precio       numeric(12,2) check (precio is null or precio >= 0),   -- null = "Consultar precio"
  unidad       text check (char_length(unidad) <= 30),
  categoria_id bigint references public.categorias(id) on delete set null,
  imagen_url   text check (imagen_url is null or imagen_url ~ '^https://'),
  destacado    boolean default false,
  activo       boolean default true,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create table if not exists public.cotizaciones (
  id          bigint generated always as identity primary key,
  nombre      text not null check (char_length(nombre) between 2 and 80),
  telefono    text not null check (telefono ~ '^[0-9 +()-]{8,20}$'),
  detalle     text check (char_length(detalle) <= 1500),
  items       jsonb not null default '[]'::jsonb
              check (jsonb_typeof(items) = 'array'
                     and jsonb_array_length(items) <= 60
                     and pg_column_size(items) <= 12000),
  atendida    boolean default false,
  created_at  timestamptz default now(),
  constraint cotizacion_no_vacia check (jsonb_array_length(items) > 0 or char_length(coalesce(detalle,'')) >= 3)
);
-- por si venías de la versión 1
alter table public.cotizaciones add column if not exists items jsonb not null default '[]'::jsonb;
alter table public.cotizaciones alter column detalle drop not null;

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

-- Bitácora de cambios del panel
create table if not exists public.auditoria (
  id         bigint generated always as identity primary key,
  user_id    uuid,
  tabla      text,
  accion     text,
  registro   text,
  creado     timestamptz default now()
);

create index if not exists productos_categoria_idx on public.productos(categoria_id);
create index if not exists cotizaciones_fecha_idx on public.cotizaciones(created_at desc);
create index if not exists cotizaciones_tel_idx   on public.cotizaciones(telefono, created_at desc);

-- ---------------------------------------------------------------------
-- 2. FUNCIONES DE SEGURIDAD
-- ---------------------------------------------------------------------
-- Admin = está en la tabla admins Y entró con 2 pasos (MFA / aal2).
-- Si de verdad NO querés exigir MFA, cambiá la línea marcada (no recomendado).
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid())
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';   -- <- exigir MFA
$$;

-- Para que el panel sepa si el usuario está en la lista (sin exigir MFA aún)
create or replace function public.soy_admin_registrado()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

revoke all on function public.is_admin() from public;
revoke all on function public.soy_admin_registrado() from public;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.soy_admin_registrado() to authenticated;

-- Límite anti-spam para el formulario público
create or replace function public.limitar_cotizaciones()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  tel_limpio text := regexp_replace(new.telefono, '[^0-9]', '', 'g');
begin
  if (select count(*) from public.cotizaciones
       where regexp_replace(telefono, '[^0-9]', '', 'g') = tel_limpio
         and created_at > now() - interval '15 minutes') >= 3 then
    raise exception 'Demasiadas solicitudes desde este número. Intente más tarde.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.cotizaciones
       where created_at > now() - interval '1 minute') >= 15 then
    raise exception 'Estamos recibiendo muchas solicitudes. Intente en un minuto.' using errcode = 'P0001';
  end if;
  new.atendida := false;
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists trg_limitar_cotizaciones on public.cotizaciones;
create trigger trg_limitar_cotizaciones
  before insert on public.cotizaciones
  for each row execute function public.limitar_cotizaciones();

-- Auditoría de cambios hechos desde el panel
create or replace function public.registrar_auditoria()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.auditoria(user_id, tabla, accion, registro)
  values (auth.uid(), tg_table_name, tg_op,
          coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id',
                   to_jsonb(new) ->> 'clave', to_jsonb(old) ->> 'clave'));
  return coalesce(new, old);
end;
$$;

create or replace function public.tocar_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end; $$;

drop trigger if exists trg_productos_updated on public.productos;
create trigger trg_productos_updated before update on public.productos
  for each row execute function public.tocar_updated_at();

do $$
declare t text;
begin
  foreach t in array array['productos','categorias','ajustes','cotizaciones','admins'] loop
    execute format('drop trigger if exists trg_auditoria on public.%I', t);
    execute format('create trigger trg_auditoria after insert or update or delete on public.%I
                    for each row when (auth.uid() is not null)
                    execute function public.registrar_auditoria()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. PERMISOS (privilegios mínimos)
-- ---------------------------------------------------------------------
revoke all on public.categorias, public.productos, public.cotizaciones,
              public.ajustes, public.admins, public.auditoria
  from anon, authenticated;

-- Visitantes: solo leer catálogo/ajustes y enviar cotizaciones (solo estas columnas)
grant select on public.categorias, public.productos, public.ajustes to anon, authenticated;
grant insert (nombre, telefono, detalle, items) on public.cotizaciones to anon, authenticated;

-- Usuarios con sesión: las políticas RLS deciden (solo admins con MFA pasan)
grant insert, update, delete on public.categorias, public.productos, public.ajustes to authenticated;
grant select, update, delete on public.cotizaciones to authenticated;
grant select on public.auditoria to authenticated;
-- admins: nadie la toca desde la web; se administra desde el SQL Editor

-- ---------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.categorias   enable row level security;
alter table public.productos    enable row level security;
alter table public.cotizaciones enable row level security;
alter table public.ajustes      enable row level security;
alter table public.admins       enable row level security;
alter table public.auditoria    enable row level security;

-- limpiar políticas viejas (v1)
drop policy if exists "categorias_lectura"     on public.categorias;
drop policy if exists "categorias_admin"       on public.categorias;
drop policy if exists "productos_lectura"      on public.productos;
drop policy if exists "productos_admin"        on public.productos;
drop policy if exists "ajustes_lectura"        on public.ajustes;
drop policy if exists "ajustes_admin"          on public.ajustes;
drop policy if exists "cotizaciones_insertar"  on public.cotizaciones;
drop policy if exists "cotizaciones_admin"     on public.cotizaciones;
drop policy if exists "auditoria_admin"        on public.auditoria;

-- Lectura pública
create policy "categorias_lectura" on public.categorias for select using (true);
create policy "productos_lectura"  on public.productos  for select using (activo = true or public.is_admin());
create policy "ajustes_lectura"    on public.ajustes    for select using (true);

-- Escritura solo admin con MFA
create policy "categorias_admin" on public.categorias for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "productos_admin"  on public.productos  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "ajustes_admin"    on public.ajustes    for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Cotizaciones: cualquiera envía; solo admin ve/edita/borra
create policy "cotizaciones_insertar" on public.cotizaciones for insert to anon, authenticated
  with check (atendida = false);
create policy "cotizaciones_admin" on public.cotizaciones for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "auditoria_admin" on public.auditoria for select to authenticated
  using (public.is_admin());
-- admins: sin políticas = nadie desde la API

-- ---------------------------------------------------------------------
-- 5. STORAGE (fotos) — solo imágenes, máx 2 MB, solo admin sube/borra
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('productos', 'productos', true, 2097152, array['image/webp','image/jpeg','image/png'])
on conflict (id) do update
  set public = true,
      file_size_limit = 2097152,
      allowed_mime_types = array['image/webp','image/jpeg','image/png'];

drop policy if exists "productos_fotos_lectura" on storage.objects;  -- sin listado público
drop policy if exists "productos_fotos_subir"   on storage.objects;
drop policy if exists "productos_fotos_editar"  on storage.objects;
drop policy if exists "productos_fotos_borrar"  on storage.objects;
drop policy if exists "productos_fotos_admin_ver" on storage.objects;

create policy "productos_fotos_subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'productos' and public.is_admin());
create policy "productos_fotos_editar" on storage.objects for update to authenticated
  using (bucket_id = 'productos' and public.is_admin());
create policy "productos_fotos_borrar" on storage.objects for delete to authenticated
  using (bucket_id = 'productos' and public.is_admin());
create policy "productos_fotos_admin_ver" on storage.objects for select to authenticated
  using (bucket_id = 'productos' and public.is_admin());

-- =====================================================================
-- 5b. VENTAS Y PAGOS (SINPE Móvil)
--     Reglas que la base de datos hace cumplir, aunque alguien
--     manipule el navegador:
--     · total y saldo los calcula la BD, no la página
--     · un comprobante SINPE no se puede usar dos veces
--     · una venta queda "pagado" solo con pagos VERIFICADOS en el banco
--     · los pagos no se borran: se anulan con motivo
--     · una venta con pagos activos no se puede anular
-- =====================================================================
create or replace function public.nuevo_codigo_pedido()
returns text language plpgsql volatile set search_path = '' as $$
declare
  alf text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   -- sin 0/O/1/I para no confundir
  c text;
begin
  loop
    c := 'LC';
    for i in 1..5 loop
      c := c || substr(alf, 1 + floor(random() * length(alf))::int, 1);
    end loop;
    exit when not exists (select 1 from public.pedidos where codigo = c);
  end loop;
  return c;
end $$;

create table if not exists public.pedidos (
  id                 bigint generated always as identity primary key,
  codigo             text not null unique default public.nuevo_codigo_pedido(),
  cotizacion_id      bigint references public.cotizaciones(id) on delete set null,
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
  comprobante_path  text check (comprobante_path is null or comprobante_path ~ '^[0-9a-f-]{36}\.(webp|jpg|png|pdf)$'),
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

-- Un comprobante = un pago (salvo que el anterior se haya anulado)
create unique index if not exists pagos_referencia_unica
  on public.pagos (metodo, upper(referencia)) where referencia is not null and not anulado;
create index if not exists pagos_fecha_idx  on public.pagos (fecha desc);
create index if not exists pagos_pedido_idx on public.pagos (pedido_id);
create index if not exists pedidos_fecha_idx on public.pedidos (created_at desc);
create index if not exists items_pedido_idx  on public.pedido_items (pedido_id);

-- Recalcula total, cobrado y estado de pago (solo la BD escribe estos campos)
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

-- Reglas de la venta
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

-- Los productos de una venta se congelan cuando ya hay dinero verificado o se cerró
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

-- Reglas de los pagos
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

  -- UPDATE
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

-- Auditoría también para ventas y pagos
do $$
declare t text;
begin
  foreach t in array array['pedidos','pedido_items','pagos'] loop
    execute format('drop trigger if exists trg_auditoria on public.%I', t);
    execute format('create trigger trg_auditoria after insert or update or delete on public.%I
                    for each row when (auth.uid() is not null)
                    execute function public.registrar_auditoria()', t);
  end loop;
end $$;

-- Caja diaria (hora de Costa Rica). security_invoker = respeta RLS
create or replace view public.v_caja_diaria with (security_invoker = true) as
select (p.fecha at time zone 'America/Costa_Rica')::date as dia,
       p.metodo,
       count(*) filter (where not p.anulado)                                   as pagos,
       coalesce(sum(p.monto) filter (where not p.anulado), 0)                  as total,
       coalesce(sum(p.monto) filter (where not p.anulado and p.verificado), 0) as verificado,
       coalesce(sum(p.monto) filter (where not p.anulado and not p.verificado), 0) as por_verificar
  from public.pagos p
 group by 1, 2;

-- Permisos: solo columnas que la persona puede escribir; lo calculado lo pone la BD
revoke all on public.pedidos, public.pedido_items, public.pagos, public.v_caja_diaria from anon, authenticated;
grant select on public.pedidos, public.pedido_items, public.pagos, public.v_caja_diaria to authenticated;
grant insert (cotizacion_id, cliente_nombre, cliente_telefono, nota) on public.pedidos to authenticated;
grant update (cliente_nombre, cliente_telefono, nota, estado, motivo_anulacion) on public.pedidos to authenticated;
grant delete on public.pedidos to authenticated;
grant insert (pedido_id, producto_id, descripcion, cantidad, precio_unit) on public.pedido_items to authenticated;
grant update (descripcion, cantidad, precio_unit) on public.pedido_items to authenticated;
grant delete on public.pedido_items to authenticated;
grant insert (pedido_id, metodo, monto, referencia, telefono_origen, nombre_origen, fecha, comprobante_path, nota, verificado)
  on public.pagos to authenticated;
grant update (verificado, anulado, motivo_anulacion, comprobante_path, nota) on public.pagos to authenticated;
-- (sin DELETE en pagos: nunca se borran)

alter table public.pedidos      enable row level security;
alter table public.pedido_items enable row level security;
alter table public.pagos        enable row level security;

drop policy if exists "pedidos_admin" on public.pedidos;
drop policy if exists "items_admin"   on public.pedido_items;
drop policy if exists "pagos_admin"   on public.pagos;
create policy "pedidos_admin" on public.pedidos      for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "items_admin"   on public.pedido_items for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "pagos_admin"   on public.pagos        for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Comprobantes: bucket PRIVADO (se ven con enlaces temporales). No se borran ni reemplazan.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('comprobantes', 'comprobantes', false, 5242880, array['image/webp','image/jpeg','image/png','application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = 5242880,
      allowed_mime_types = array['image/webp','image/jpeg','image/png','application/pdf'];

drop policy if exists "comprobantes_ver"   on storage.objects;
drop policy if exists "comprobantes_subir" on storage.objects;
create policy "comprobantes_ver" on storage.objects for select to authenticated
  using (bucket_id = 'comprobantes' and public.is_admin());
create policy "comprobantes_subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'comprobantes' and public.is_admin());

-- ---------------------------------------------------------------------
-- 6. DATOS INICIALES
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

insert into public.categorias (nombre, icono, orden)
select * from (values
  ('Materiales de construcción', '🧱', 1),
  ('Ferretería',                 '🔨', 2),
  ('Mascotas',                   '🐾', 3),
  ('Pesca',                      '🎣', 4),
  ('Cuidado del auto',           '🚗', 5),
  ('Agro y jardín',              '🌱', 6)
) v(nombre, icono, orden)
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
-- 7. REGISTRAR AL ADMINISTRADOR  (correr DESPUÉS de crear el usuario
--    en Authentication > Users). Cambiá el correo:
-- ---------------------------------------------------------------------
-- insert into public.admins (user_id)
-- select id from auth.users where email = 'admin@ejemplo.com'
-- on conflict do nothing;
