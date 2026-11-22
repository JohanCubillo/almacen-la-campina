-- =====================================================================
--  Almacén La Campiña — Mejoras v4
--  Correr DESPUÉS de schema.sql (se puede correr varias veces).
--  Supabase: SQL Editor > New query > pegar todo > Run
--
--  Agrega:
--   1. Productos agotados y ofertas con fecha de vencimiento
--   2. Envío a domicilio por zonas (se configuran en el panel)
--   3. "Listo para recoger" y datos de entrega en los pedidos
--   4. Solicitudes de factura electrónica
--   5. Avisos por Telegram cuando entra un pedido o un comprobante
--   6. Importar productos desde Excel
--   7. Reportes de ventas
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Utilidades
-- ---------------------------------------------------------------------
create or replace function public.hoy_cr()
returns date language sql stable set search_path = '' as $$
  select (now() at time zone 'America/Costa_Rica')::date;
$$;

-- ---------------------------------------------------------------------
-- 1. AGOTADO Y OFERTAS
-- ---------------------------------------------------------------------
alter table public.productos add column if not exists agotado       boolean not null default false;
alter table public.productos add column if not exists precio_oferta numeric(12,2);
alter table public.productos add column if not exists oferta_hasta  date;

alter table public.productos drop constraint if exists producto_oferta_valida;
alter table public.productos add constraint producto_oferta_valida check (
  (precio_oferta is null and oferta_hasta is null)
  or (precio_oferta is not null and precio_oferta > 0 and oferta_hasta is not null
      and (precio is null or precio_oferta < precio))
);

-- Precio que se cobra hoy (la oferta solo vale hasta su fecha, inclusive)
create or replace function public.precio_vigente(p_precio numeric, p_oferta numeric, p_hasta date)
returns numeric language sql stable set search_path = '' as $$
  select case when p_oferta is not null and p_hasta is not null and p_hasta >= public.hoy_cr()
              then p_oferta else p_precio end;
$$;

-- ---------------------------------------------------------------------
-- 2. AJUSTES NUEVOS (envío a domicilio)
--    envio_zonas: una zona por línea, por ejemplo
--      Cariari centro = 2000
--      Campo Kennedy = 3500
--      Palermo = 0          (0 = gratis)
-- ---------------------------------------------------------------------
alter table public.ajustes drop constraint if exists ajuste_clave_valida;
alter table public.ajustes add constraint ajuste_clave_valida check (clave in
  ('telefono','whatsapp','telefono2','direccion','horario','horario_semana','facebook','aviso',
   'sinpe_numero','sinpe_titular','envio_activo','envio_zonas','envio_nota'));
alter table public.ajustes drop constraint if exists ajuste_envio_activo;
alter table public.ajustes add constraint ajuste_envio_activo check (clave <> 'envio_activo' or valor in ('si','no'));
-- La lista de zonas puede ser larga (un barrio por línea); lo demás sigue con 1000 letras
alter table public.ajustes drop constraint if exists ajustes_valor_check;
alter table public.ajustes drop constraint if exists ajuste_largo;
alter table public.ajustes add constraint ajuste_largo check (
  char_length(valor) <= case when clave = 'envio_zonas' then 4000 else 1000 end);

insert into public.ajustes (clave, valor) values
  ('envio_activo', 'no'),
  ('envio_zonas',  ''),
  ('envio_nota',   'El envío se coordina por WhatsApp según la cantidad de material.')
on conflict (clave) do nothing;

-- Zonas de envío ya interpretadas (nombre, precio)
create or replace function public.zonas_envio()
returns table (nombre text, precio numeric) language sql stable set search_path = '' as $$
  select trim(m[1]), coalesce(nullif(regexp_replace(m[2], '[^0-9]', '', 'g'), ''), '0')::numeric
    from public.ajustes a,
         regexp_split_to_table(coalesce(a.valor, ''), E'\n') as linea,
         regexp_match(linea, '^\s*([^=|:]{2,60}?)\s*[=|:]\s*₡?\s*([0-9][0-9 .,]{0,9})\s*$') as m
   where a.clave = 'envio_zonas' and m is not null;
$$;

-- ---------------------------------------------------------------------
-- 3. ENTREGA EN LOS PEDIDOS
-- ---------------------------------------------------------------------
alter table public.pedidos add column if not exists entrega   text not null default 'retiro';
alter table public.pedidos add column if not exists zona      text;
alter table public.pedidos add column if not exists direccion text;
alter table public.pedidos add column if not exists listo_at  timestamptz;

alter table public.pedidos drop constraint if exists pedido_entrega_valida;
alter table public.pedidos add constraint pedido_entrega_valida check (
  entrega in ('retiro','envio')
  and (zona is null or char_length(zona) <= 60)
  and (direccion is null or char_length(direccion) <= 300)
);

grant update (entrega, zona, direccion, listo_at) on public.pedidos to authenticated;

-- ---------------------------------------------------------------------
-- 4. FACTURA ELECTRÓNICA (solicitudes)
--    El panel guarda los datos del receptor. La emisión ante Hacienda la
--    hace el sistema de facturación (ver FACTURACION.md) o se marca a mano.
-- ---------------------------------------------------------------------
create table if not exists public.facturas (
  id              bigint generated always as identity primary key,
  pedido_id       bigint not null unique references public.pedidos(id) on delete restrict,
  tipo_id         text not null check (tipo_id in ('fisica','juridica','dimex','nite')),
  identificacion  text not null,
  nombre          text not null check (char_length(nombre) between 2 and 100),
  correo          text not null check (char_length(correo) <= 120 and correo ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  estado          text not null default 'pendiente'
                  check (estado in ('pendiente','enviada','aceptada','rechazada','error','anulada')),
  clave           text check (clave is null or clave ~ '^[0-9]{50}$'),
  consecutivo     text check (consecutivo is null or consecutivo ~ '^[0-9]{20}$'),
  mensaje         text check (char_length(mensaje) <= 500),
  solicitada_por  text not null default 'cliente' check (solicitada_por in ('cliente','panel')),
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  constraint factura_id_valida check (
    (tipo_id = 'fisica'   and identificacion ~ '^[1-9][0-9]{8}$') or
    (tipo_id = 'juridica' and identificacion ~ '^[0-9]{10}$') or
    (tipo_id = 'dimex'    and identificacion ~ '^[0-9]{11,12}$') or
    (tipo_id = 'nite'     and identificacion ~ '^[0-9]{10}$'))
);

drop trigger if exists trg_facturas_updated on public.facturas;
create trigger trg_facturas_updated before update on public.facturas
  for each row execute function public.tocar_updated_at();

alter table public.facturas enable row level security;
drop policy if exists "facturas_admin" on public.facturas;
create policy "facturas_admin" on public.facturas for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
revoke all on public.facturas from anon, authenticated;
grant select on public.facturas to authenticated;
grant insert (pedido_id, tipo_id, identificacion, nombre, correo, solicitada_por) on public.facturas to authenticated;
grant update (tipo_id, identificacion, nombre, correo, estado, clave, consecutivo, mensaje) on public.facturas to authenticated;

-- Lo que necesita el sistema de facturación: receptor + renglones
create or replace view public.v_facturas_pendientes with (security_invoker = true) as
select f.id as factura_id, f.tipo_id, f.identificacion, f.nombre, f.correo,
       p.id as pedido_id, p.codigo, p.created_at as fecha_pedido, p.total,
       coalesce((select jsonb_agg(jsonb_build_object(
                  'descripcion', i.descripcion, 'cantidad', i.cantidad,
                  'precio_unit', i.precio_unit, 'subtotal', i.subtotal, 'producto_id', i.producto_id) order by i.id)
                   from public.pedido_items i where i.pedido_id = p.id), '[]'::jsonb) as lineas
  from public.facturas f join public.pedidos p on p.id = f.pedido_id
 where f.estado = 'pendiente' and p.estado <> 'anulada';
revoke all on public.v_facturas_pendientes from anon, authenticated;
grant select on public.v_facturas_pendientes to authenticated;

-- Validar datos de factura que vienen del sitio
create or replace function public._factura_desde_json(p jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  t text := lower(coalesce(p ->> 't', ''));
  i text := regexp_replace(coalesce(p ->> 'id', ''), '[^0-9]', '', 'g');
  n text := left(trim(regexp_replace(coalesce(p ->> 'n', ''), '\s+', ' ', 'g')), 100);
  e text := lower(trim(coalesce(p ->> 'e', '')));
begin
  if t not in ('fisica','juridica','dimex','nite') then
    raise exception 'Factura: escoja el tipo de identificación.' using errcode = 'P0001';
  end if;
  if not ((t = 'fisica' and i ~ '^[1-9][0-9]{8}$') or (t = 'juridica' and i ~ '^[0-9]{10}$')
          or (t = 'dimex' and i ~ '^[0-9]{11,12}$') or (t = 'nite' and i ~ '^[0-9]{10}$')) then
    raise exception 'Factura: revise el número de identificación (cédula física 9 dígitos, jurídica 10, DIMEX 11 o 12).' using errcode = 'P0001';
  end if;
  if char_length(n) < 2 then
    raise exception 'Factura: escriba el nombre o la razón social.' using errcode = 'P0001';
  end if;
  if char_length(e) > 120 or e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Factura: revise el correo electrónico.' using errcode = 'P0001';
  end if;
  return jsonb_build_object('t', t, 'id', i, 'n', n, 'e', e);
end $$;
revoke all on function public._factura_desde_json(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. AVISOS POR TELEGRAM
--    Requiere la extensión pg_net (Supabase: Database > Extensions > pg_net).
--    El token y el chat se ponen en el panel > Datos del negocio.
-- ---------------------------------------------------------------------
do $$ begin
  create extension if not exists pg_net with schema extensions;
exception when others then
  raise notice 'pg_net no se pudo activar aquí (%). Actívelo en Database > Extensions.', sqlerrm;
end $$;

create table if not exists public.avisos (
  id              int primary key default 1 check (id = 1),
  activo          boolean not null default false,
  telegram_token  text check (telegram_token is null or telegram_token ~ '^[0-9]{5,15}:[A-Za-z0-9_-]{30,60}$'),
  telegram_chat   text check (telegram_chat is null or telegram_chat ~ '^-?[0-9]{4,20}$'),
  panel_url       text not null default 'https://johancubillo.github.io/almacen-la-campina/admin.html'
                  check (panel_url ~ '^https://[^\s]{4,200}$'),
  updated_at      timestamptz default now()
);
insert into public.avisos (id) values (1) on conflict (id) do nothing;

alter table public.avisos enable row level security;
drop policy if exists "avisos_admin" on public.avisos;
create policy "avisos_admin" on public.avisos for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
revoke all on public.avisos from anon, authenticated;
grant select on public.avisos to authenticated;
grant update (activo, telegram_token, telegram_chat, panel_url) on public.avisos to authenticated;

drop trigger if exists trg_avisos_updated on public.avisos;
create trigger trg_avisos_updated before update on public.avisos
  for each row execute function public.tocar_updated_at();

-- Envía un mensaje. Nunca hace fallar la operación que lo llama.
create or replace function public._avisar(p_texto text, p_forzar boolean default false)
returns boolean language plpgsql security definer set search_path = '' as $$
declare c record;
begin
  select * into c from public.avisos where id = 1;
  if c is null or c.telegram_token is null or c.telegram_chat is null then return false; end if;
  if not c.activo and not p_forzar then return false; end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3)'
    using 'https://api.telegram.org/bot' || c.telegram_token || '/sendMessage',
          jsonb_build_object('chat_id', c.telegram_chat, 'text', left(p_texto, 3500), 'disable_web_page_preview', true),
          '{"Content-Type": "application/json"}'::jsonb;
  return true;
exception when others then
  raise notice 'Aviso no enviado: %', sqlerrm;
  return false;
end $$;
revoke all on function public._avisar(text, boolean) from public, anon, authenticated;

-- Botón "Enviar prueba" del panel
create or replace function public.probar_aviso()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'No autorizado.' using errcode = '42501'; end if;
  if public._avisar('Prueba de avisos de Almacén La Campiña. Si ve este mensaje, los avisos de pedidos ya funcionan.', true) then
    return jsonb_build_object('ok', true);
  end if;
  return jsonb_build_object('ok', false, 'error', 'Revise el token y el número de chat, y que la extensión pg_net esté activa.');
end $$;

-- Resultado del último envío (para saber si Telegram aceptó el mensaje)
create or replace function public.ultimo_aviso()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  if not public.is_admin() then raise exception 'No autorizado.' using errcode = '42501'; end if;
  execute 'select jsonb_build_object(''estado'', status_code, ''detalle'', left(coalesce(content::text, error_msg, ''''), 300), ''fecha'', created)
             from net._http_response order by created desc limit 1' into r;
  return coalesce(r, jsonb_build_object('estado', null));
exception when others then
  return jsonb_build_object('estado', null, 'detalle', 'pg_net no está activo');
end $$;
revoke all on function public.probar_aviso() from public, anon;
revoke all on function public.ultimo_aviso() from public, anon;
grant execute on function public.probar_aviso() to authenticated;
grant execute on function public.ultimo_aviso() to authenticated;

-- ---------------------------------------------------------------------
-- 6. CREAR / CONSULTAR PEDIDO (versión con entrega, factura, agotado y ofertas)
-- ---------------------------------------------------------------------
drop function if exists public.crear_pedido_web(text, text, text, jsonb);

create or replace function public.crear_pedido_web(p_nombre text, p_telefono text, p_nota text, p_items jsonb,
                                                   p_entrega jsonb default null, p_factura jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_nombre text := trim(coalesce(p_nombre, ''));
  v_tel    text := trim(coalesce(p_telefono, ''));
  v_dig    text := regexp_replace(coalesce(p_telefono, ''), '[^0-9]', '', 'g');
  v_nota   text := nullif(trim(coalesce(p_nota, '')), '');
  v_tipo   text := coalesce(nullif(lower(p_entrega ->> 'tipo'), ''), 'retiro');
  v_zona   text; v_zprecio numeric; v_dir text;
  v_fact   jsonb;
  v_id bigint; v_codigo text; it jsonb; v_cant numeric; v_desc text; n int := 0;
  v_pid bigint; v_pnombre text; v_punidad text; v_pprecio numeric; v_pagotado boolean;
  v_total numeric; v_pend boolean;
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

  -- entrega
  if v_tipo not in ('retiro','envio') then
    raise exception 'Escoja si lo recoge o se lo enviamos.' using errcode = 'P0001';
  end if;
  if v_tipo = 'envio' then
    if coalesce((select valor from public.ajustes where clave = 'envio_activo'), 'no') <> 'si' then
      raise exception 'Por ahora no tenemos envío a domicilio. Escoja retirarlo en el almacén.' using errcode = 'P0001';
    end if;
    select z.nombre, z.precio into v_zona, v_zprecio
      from public.zonas_envio() z where lower(z.nombre) = lower(trim(coalesce(p_entrega ->> 'zona', ''))) limit 1;
    if v_zona is null then
      raise exception 'Escoja la zona de envío.' using errcode = 'P0001';
    end if;
    v_dir := left(trim(regexp_replace(coalesce(p_entrega ->> 'direccion', ''), '\s+', ' ', 'g')), 300);
    if char_length(v_dir) < 10 then
      raise exception 'Escriba la dirección con señas para el envío.' using errcode = 'P0001';
    end if;
  end if;

  -- factura (opcional)
  if p_factura is not null and jsonb_typeof(p_factura) = 'object' then
    v_fact := public._factura_desde_json(p_factura);
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

  insert into public.pedidos (cliente_nombre, cliente_telefono, nota, origen, revisado, created_by, entrega, zona, direccion)
  values (v_nombre, v_tel, v_nota, 'web', false, null, v_tipo, v_zona, v_dir)
  returning id, codigo into v_id, v_codigo;

  for it in select * from jsonb_array_elements(p_items) loop
    continue when jsonb_typeof(it) <> 'object';
    v_cant := case when (it ->> 'c') ~ '^[0-9]{1,3}(\.[0-9]{1,2})?$'
                   then least(greatest((it ->> 'c')::numeric, 1), 999) else 1 end;
    v_pid := null; v_pnombre := null; v_punidad := null; v_pprecio := null; v_pagotado := false;
    if (it ->> 'id') ~ '^[0-9]{1,15}$' then
      select id, nombre, unidad, public.precio_vigente(precio, precio_oferta, oferta_hasta), agotado
        into v_pid, v_pnombre, v_punidad, v_pprecio, v_pagotado
        from public.productos where id = (it ->> 'id')::bigint and activo;
    end if;
    if v_pid is not null then
      if v_pagotado then
        raise exception '"%" está agotado. Quítelo del carrito o escríbanos para saber cuándo llega.', v_pnombre using errcode = 'P0001';
      end if;
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

  if v_tipo = 'envio' then
    insert into public.pedido_items (pedido_id, producto_id, descripcion, cantidad, precio_unit)
    values (v_id, null, left('Envío a domicilio: ' || v_zona, 120), 1, v_zprecio);
  end if;

  if v_fact is not null then
    insert into public.facturas (pedido_id, tipo_id, identificacion, nombre, correo, solicitada_por)
    values (v_id, v_fact ->> 't', v_fact ->> 'id', v_fact ->> 'n', v_fact ->> 'e', 'cliente');
  end if;

  select total into v_total from public.pedidos where id = v_id;
  v_pend := exists (select 1 from public.pedido_items where pedido_id = v_id and precio_unit = 0
                     and descripcion not like 'Envío a domicilio:%');

  perform public._avisar(
    'Nuevo pedido web ' || v_codigo || E'\n' ||
    'Cliente: ' || v_nombre || ' (' || v_tel || ')' || E'\n' ||
    n || case when n = 1 then ' producto' else ' productos' end ||
    ' · Total ₡' || to_char(v_total, 'FM999G999G999') || case when v_pend then ' + precios por confirmar' else '' end || E'\n' ||
    case when v_tipo = 'envio' then 'Envío a ' || v_zona || ': ' || v_dir else 'Retira en el almacén' end ||
    case when v_fact is not null then E'\nPide factura electrónica' else '' end || E'\n' ||
    (select panel_url from public.avisos where id = 1));

  return jsonb_build_object('codigo', v_codigo, 'total', v_total, 'precios_pendientes', v_pend);
end $$;

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
    'listo_at', p.listo_at,
    'entrega', p.entrega,
    'zona', p.zona,
    'precios_pendientes', exists (select 1 from public.pedido_items where pedido_id = p.id and precio_unit = 0
                                   and descripcion not like 'Envío a domicilio:%'),
    'items', coalesce((select jsonb_agg(jsonb_build_object('d', descripcion, 'c', cantidad, 'p', precio_unit, 's', subtotal) order by id)
                         from public.pedido_items where pedido_id = p.id), '[]'::jsonb),
    'comprobantes', coalesce((select jsonb_agg(jsonb_build_object('fecha', created_at, 'estado', estado, 'motivo', motivo_rechazo, 'monto', monto_reportado) order by id)
                                from public.comprobantes_cliente where pedido_id = p.id), '[]'::jsonb),
    'factura', (select jsonb_build_object('estado', estado) from public.facturas where pedido_id = p.id),
    'sinpe_numero', (select valor from public.ajustes where clave = 'sinpe_numero'),
    'sinpe_titular', (select valor from public.ajustes where clave = 'sinpe_titular')
  );
end $$;

-- Aviso cuando el cliente sube un comprobante
create or replace function public.reportar_comprobante(p_codigo text, p_telefono text, p_ruta text,
                                                       p_monto numeric, p_referencia text, p_nota text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb; v_id bigint; v_cod text; v_ref text := nullif(regexp_replace(coalesce(p_referencia, ''), '\s', '', 'g'), '');
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
  update public.pedidos set revisado = false where id = v_id returning codigo into v_cod;
  perform public._avisar(
    'Comprobante SINPE recibido · pedido ' || v_cod ||
    coalesce(E'\nMonto según el cliente: ₡' || to_char(p_monto, 'FM999G999G999'), '') ||
    coalesce(E'\nComprobante: ' || v_ref, '') || E'\nRevíselo en el banco antes de entregar.' || E'\n' ||
    (select panel_url from public.avisos where id = 1));
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.crear_pedido_web(text, text, text, jsonb, jsonb, jsonb) from public;
revoke all on function public.consultar_pedido(text, text) from public;
revoke all on function public.reportar_comprobante(text, text, text, numeric, text, text) from public;
grant execute on function public.crear_pedido_web(text, text, text, jsonb, jsonb, jsonb) to anon, authenticated;
grant execute on function public.consultar_pedido(text, text) to anon, authenticated;
grant execute on function public.reportar_comprobante(text, text, text, numeric, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 7. IMPORTAR PRODUCTOS DESDE EXCEL
--    Cada fila: {fila, nombre, categoria, precio, unidad, descripcion,
--                activo, destacado, agotado, imagen_url}
--    Si el nombre ya existe (sin importar mayúsculas) se actualiza;
--    si no, se crea. Solo se cambian las columnas que trae el archivo.
-- ---------------------------------------------------------------------
create or replace function public.importar_productos(p_filas jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f jsonb; v_nombre text; v_cat_id bigint; v_cat text; v_id bigint; v_precio numeric;
  ins int := 0; act int := 0; cats int := 0; errores jsonb := '[]'::jsonb; v_fila int;
  v_cat_nueva boolean;
begin
  if not public.is_admin() then raise exception 'No autorizado.' using errcode = '42501'; end if;
  if p_filas is null or jsonb_typeof(p_filas) <> 'array' then
    raise exception 'El archivo no trae filas.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_filas) > 3000 then
    raise exception 'Máximo 3000 productos por archivo.' using errcode = 'P0001';
  end if;

  for f in select * from jsonb_array_elements(p_filas) loop
    v_fila := coalesce((f ->> 'fila')::int, 0);
    begin
      v_nombre := left(trim(regexp_replace(coalesce(f ->> 'nombre', ''), '\s+', ' ', 'g')), 100);
      if char_length(v_nombre) < 2 then raise exception 'Falta el nombre.'; end if;

      -- precio: vacío = "a consultar"
      v_precio := null;
      if f ? 'precio' and nullif(trim(f ->> 'precio'), '') is not null then
        if trim(f ->> 'precio') !~ '^[0-9]{1,10}(\.[0-9]{1,2})?$' then raise exception 'Precio no válido: %', f ->> 'precio'; end if;
        v_precio := (f ->> 'precio')::numeric;
      end if;

      -- categoría: se crea si no existe
      v_cat_id := null; v_cat_nueva := false;
      v_cat := left(trim(coalesce(f ->> 'categoria', '')), 60);
      if char_length(v_cat) >= 2 then
        select id into v_cat_id from public.categorias where lower(nombre) = lower(v_cat) limit 1;
        if v_cat_id is null then
          insert into public.categorias (nombre, orden)
          values (v_cat, coalesce((select max(orden) from public.categorias), 0) + 1)
          returning id into v_cat_id;
          v_cat_nueva := true;
        end if;
      end if;

      select id into v_id from public.productos where lower(nombre) = lower(v_nombre) order by id limit 1;
      if v_id is null then
        insert into public.productos (nombre, categoria_id, precio, unidad, descripcion, imagen_url, activo, destacado, agotado)
        values (v_nombre, v_cat_id, v_precio,
                nullif(left(trim(coalesce(f ->> 'unidad', '')), 30), ''),
                nullif(left(trim(coalesce(f ->> 'descripcion', '')), 500), ''),
                nullif(trim(coalesce(f ->> 'imagen_url', '')), ''),
                coalesce((f ->> 'activo')::boolean, true),
                coalesce((f ->> 'destacado')::boolean, false),
                coalesce((f ->> 'agotado')::boolean, false));
        ins := ins + 1;
        if v_cat_nueva then cats := cats + 1; end if;
      else
        update public.productos set
          categoria_id = case when f ? 'categoria' then v_cat_id else categoria_id end,
          precio       = case when f ? 'precio' then v_precio else precio end,
          unidad       = case when f ? 'unidad' then nullif(left(trim(coalesce(f ->> 'unidad', '')), 30), '') else unidad end,
          descripcion  = case when f ? 'descripcion' then nullif(left(trim(coalesce(f ->> 'descripcion', '')), 500), '') else descripcion end,
          imagen_url   = case when f ? 'imagen_url' and nullif(trim(coalesce(f ->> 'imagen_url', '')), '') is not null
                              then trim(f ->> 'imagen_url') else imagen_url end,
          activo       = case when f ? 'activo' then coalesce((f ->> 'activo')::boolean, activo) else activo end,
          destacado    = case when f ? 'destacado' then coalesce((f ->> 'destacado')::boolean, destacado) else destacado end,
          agotado      = case when f ? 'agotado' then coalesce((f ->> 'agotado')::boolean, agotado) else agotado end
        where id = v_id;
        act := act + 1;
        if v_cat_nueva then cats := cats + 1; end if;
      end if;
    exception when others then
      errores := errores || jsonb_build_object('fila', v_fila, 'error',
        case when sqlstate = '23514' then 'Algún dato no cumple las reglas (precio de oferta, enlace de foto o largo del texto).'
             when sqlstate = '22P02' then 'Un valor de Sí/No no se entendió.'
             else sqlerrm end);
    end;
  end loop;

  return jsonb_build_object('insertados', ins, 'actualizados', act, 'categorias_nuevas', cats, 'errores', errores);
end $$;
revoke all on function public.importar_productos(jsonb) from public, anon;
grant execute on function public.importar_productos(jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 8. REPORTES
-- ---------------------------------------------------------------------
create or replace function public.reporte_ventas(p_desde date, p_hasta date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare d date := least(p_desde, p_hasta); h date := greatest(p_desde, p_hasta); r jsonb;
begin
  if not public.is_admin() then raise exception 'No autorizado.' using errcode = '42501'; end if;
  if h - d > 800 then raise exception 'Escoja un periodo de máximo dos años.' using errcode = 'P0001'; end if;

  with v as (
    select p.* from public.pedidos p
     where p.estado <> 'anulada'
       and (p.created_at at time zone 'America/Costa_Rica')::date between d and h
  ),
  meses as (
    select to_char(date_trunc('month', (p.created_at at time zone 'America/Costa_Rica')), 'YYYY-MM') as mes,
           count(*) as ventas, coalesce(sum(p.total), 0) as total, coalesce(sum(p.pagado_verificado), 0) as cobrado
      from public.pedidos p
     where p.estado <> 'anulada'
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
         where not pg.anulado and (pg.fecha at time zone 'America/Costa_Rica')::date between d and h
         group by pg.metodo) m), '[]'::jsonb)
  ) into r;
  return r;
end $$;
revoke all on function public.reporte_ventas(date, date) from public, anon;
grant execute on function public.reporte_ventas(date, date) to authenticated;

-- ---------------------------------------------------------------------
-- 9. Auditoría y permisos de las tablas nuevas
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['facturas','avisos'] loop
    execute format('drop trigger if exists trg_auditoria on public.%I', t);
    execute format('create trigger trg_auditoria after insert or update or delete on public.%I
                    for each row when (auth.uid() is not null)
                    execute function public.registrar_auditoria()', t);
  end loop;
end $$;

revoke all on function public.zonas_envio() from public;
grant execute on function public.zonas_envio() to anon, authenticated;
revoke all on function public.precio_vigente(numeric, numeric, date) from public;
grant execute on function public.precio_vigente(numeric, numeric, date) to anon, authenticated;
revoke all on function public.hoy_cr() from public;
grant execute on function public.hoy_cr() to anon, authenticated;

-- Listo. Revise el resultado:
select 'v4 instalada' as estado,
       (select count(*) from public.productos) as productos,
       (select extname from pg_extension where extname = 'pg_net') as pg_net;
