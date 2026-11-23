-- =====================================================================
--  v10 — Facturación electrónica (Hacienda 4.4) desde el panel
--  Correr DESPUÉS de v9_inventario.sql. Se puede correr más de una vez.
--
--  - fe_emisor: datos del almacén como emisor (una sola fila)
--  - fe_consecutivos: numeración por ambiente/tipo/sucursal/terminal (sin huecos ni choques)
--  - fe_documentos: cada tiquete, factura y nota de crédito con su XML firmado y la respuesta de Hacienda
--  - productos.iva_codigo: tarifa de IVA de cada producto (08 = 13 % general)
--
--  La firma y el envío los hace la función de Supabase "facturar" (supabase/functions/facturar).
--  La llave criptográfica, su PIN y el usuario/contraseña de Hacienda NO van en la base:
--  se guardan como secretos de la función (ver FACTURACION.md).
-- =====================================================================

-- ---------- tarifa de IVA por producto ----------
alter table public.productos add column if not exists iva_codigo text not null default '08';
alter table public.productos drop constraint if exists productos_iva_codigo_valido;
alter table public.productos add constraint productos_iva_codigo_valido
  check (iva_codigo in ('01','02','03','04','05','06','07','08','09','10','11'));

-- ---------- emisor ----------
create table if not exists public.fe_emisor (
  id                 int primary key default 1 check (id = 1),
  activo             boolean not null default false,          -- facturación encendida
  ambiente           text not null default 'pruebas' check (ambiente in ('pruebas','produccion')),
  tipo_id            text check (tipo_id in ('01','02','03','04')),   -- 01 física, 02 jurídica, 03 DIMEX, 04 NITE
  identificacion     text check (identificacion ~ '^[0-9]{9,12}$'),
  nombre             text check (char_length(nombre) between 3 and 100),
  nombre_comercial   text check (char_length(nombre_comercial) <= 80),
  actividad          text check (actividad ~ '^[0-9]{6}$'),          -- código de actividad económica (6 dígitos)
  provincia          text check (provincia ~ '^[1-7]$'),
  canton             text check (canton ~ '^[0-9]{2}$'),
  distrito           text check (distrito ~ '^[0-9]{2}$'),
  otras_senas        text check (char_length(otras_senas) between 5 and 250),
  telefono           text check (telefono ~ '^[0-9]{8}$'),
  correo             text check (char_length(correo) <= 160 and correo ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  sucursal           text not null default '001'   check (sucursal ~ '^[0-9]{3}$'),
  terminal           text not null default '00002' check (terminal ~ '^[0-9]{5}$'),  -- Moriah usa otra terminal
  proveedor_sistemas text check (proveedor_sistemas ~ '^[0-9A-Za-z]{9,20}$'),        -- cédula del proveedor del sistema
  cabys_envio        text check (cabys_envio ~ '^[0-9]{13}$'),                        -- CABYS del servicio de envío
  updated_at         timestamptz not null default now()
);
insert into public.fe_emisor (id) values (1) on conflict do nothing;

drop trigger if exists trg_fe_emisor_updated on public.fe_emisor;
create trigger trg_fe_emisor_updated before update on public.fe_emisor
  for each row execute function public.tocar_updated_at();
drop trigger if exists trg_fe_emisor_auditoria on public.fe_emisor;
create trigger trg_fe_emisor_auditoria after insert or update or delete on public.fe_emisor
  for each row execute function public.registrar_auditoria();

alter table public.fe_emisor enable row level security;
drop policy if exists "fe_emisor_admin" on public.fe_emisor;
create policy "fe_emisor_admin" on public.fe_emisor for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
revoke all on public.fe_emisor from anon, authenticated;
grant select on public.fe_emisor to authenticated;
grant update (activo, ambiente, tipo_id, identificacion, nombre, nombre_comercial, actividad, provincia, canton,
              distrito, otras_senas, telefono, correo, sucursal, terminal, proveedor_sistemas, cabys_envio)
  on public.fe_emisor to authenticated;

-- ---------- consecutivos ----------
create table if not exists public.fe_consecutivos (
  ambiente  text not null check (ambiente in ('pruebas','produccion')),
  tipo      text not null check (tipo in ('01','03','04')),
  sucursal  text not null,
  terminal  text not null,
  ultimo    bigint not null default 0 check (ultimo between 0 and 9999999999),
  primary key (ambiente, tipo, sucursal, terminal)
);
alter table public.fe_consecutivos enable row level security;
drop policy if exists "fe_consecutivos_admin" on public.fe_consecutivos;
create policy "fe_consecutivos_admin" on public.fe_consecutivos for select to authenticated using (public.is_admin());
revoke all on public.fe_consecutivos from anon, authenticated;
grant select on public.fe_consecutivos to authenticated;

-- Reserva el siguiente número (lo llama solo la función "facturar", con la llave de servicio)
create or replace function public.fe_reservar(p_ambiente text, p_tipo text, p_sucursal text, p_terminal text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare n bigint;
begin
  insert into public.fe_consecutivos as c (ambiente, tipo, sucursal, terminal, ultimo)
  values (p_ambiente, p_tipo, p_sucursal, p_terminal, 1)
  on conflict (ambiente, tipo, sucursal, terminal) do update set ultimo = c.ultimo + 1
  returning ultimo into n;
  return n;
end $$;
revoke all on function public.fe_reservar(text, text, text, text) from public, anon, authenticated;
grant execute on function public.fe_reservar(text, text, text, text) to service_role;

-- ---------- documentos ----------
create table if not exists public.fe_documentos (
  id             bigint generated always as identity primary key,
  pedido_id      bigint not null references public.pedidos(id) on delete restrict,
  tipo           text not null check (tipo in ('01','03','04')),           -- 01 factura, 03 nota de crédito, 04 tiquete
  ambiente       text not null check (ambiente in ('pruebas','produccion')),
  clave          text not null unique check (clave ~ '^[0-9]{50}$'),
  consecutivo    text not null check (consecutivo ~ '^[0-9]{20}$'),
  fecha_emision  timestamptz not null,
  receptor       jsonb,
  total          numeric(18,5) not null,
  impuesto       numeric(18,5) not null,
  datos          jsonb not null,                -- el comprobante tal como se firmó (para notas de crédito)
  xml_firmado    text not null,
  estado         text not null default 'firmado'
                 check (estado in ('firmado','enviado','procesando','aceptado','rechazado','error')),
  detalle        text check (char_length(detalle) <= 2000),
  respuesta_xml  text,
  referencia_id  bigint references public.fe_documentos(id) on delete restrict,   -- nota de crédito → documento original
  anulado        boolean not null default false,  -- tiene nota de crédito aceptada
  intentos       int not null default 0,
  creado_por     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (ambiente, consecutivo)
);
create index if not exists fe_documentos_pedido on public.fe_documentos (pedido_id);
create index if not exists fe_documentos_pendientes on public.fe_documentos (estado) where estado in ('firmado','enviado','procesando');
-- una venta tiene un solo tiquete/factura vigente por ambiente
create unique index if not exists fe_documentos_venta_unica on public.fe_documentos (pedido_id, ambiente)
  where tipo in ('01','04') and estado <> 'rechazado' and not anulado;
-- un documento tiene una sola nota de crédito vigente
create unique index if not exists fe_documentos_nc_unica on public.fe_documentos (referencia_id)
  where tipo = '03' and estado <> 'rechazado';

drop trigger if exists trg_fe_documentos_updated on public.fe_documentos;
create trigger trg_fe_documentos_updated before update on public.fe_documentos
  for each row execute function public.tocar_updated_at();

alter table public.fe_documentos enable row level security;
drop policy if exists "fe_documentos_admin" on public.fe_documentos;
create policy "fe_documentos_admin" on public.fe_documentos for select to authenticated using (public.is_admin());
revoke all on public.fe_documentos from anon, authenticated;
grant select on public.fe_documentos to authenticated;     -- escribir: solo la función "facturar"

-- Resumen para la lista de ventas (sin el XML, que pesa)
create or replace view public.v_fe_documentos with (security_invoker = true) as
select id, pedido_id, tipo, ambiente, clave, consecutivo, fecha_emision, receptor, total, impuesto,
       estado, detalle, referencia_id, anulado, intentos, created_at, updated_at
  from public.fe_documentos;
revoke all on public.v_fe_documentos from anon, authenticated;
grant select on public.v_fe_documentos to authenticated;
