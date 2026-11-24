-- =====================================================================
-- ALMACÉN LA CAMPIÑA · v17 · EMPLEADOS CON PERMISOS
-- Corra este archivo DESPUÉS de v16_bitacora.sql.
-- Se puede correr las veces que quiera. Si algún día vuelve a correr un
-- archivo viejo (v5…v16), corra otra vez este al final.
--
-- - ADMINISTRADOR (el dueño): entra con correo + contraseña + autenticador
--   del celular y puede todo. Agrega empleados y les da permisos.
-- - EMPLEADO: entra con usuario + contraseña y solo puede lo que el
--   administrador le marque. Si el administrador marca "Pide código",
--   también tiene que usar el autenticador del celular.
--     ventas      Hacer ventas, cobrar, verificar SINPE, tiquetes/facturas
--     anular      Anular ventas y pagos
--     caja        Abrir, mover y cerrar caja; verificar pagos
--     credito     Clientes, ventas a crédito y abonos
--     inventario  Entradas de mercadería e inventario
--     productos   Crear y editar productos, categorías y fotos
--     precios     Cambiar precios (en el producto, ajuste e importación)
--     reportes    Reportes y comprobantes emitidos
--     preguntas   Preguntas de clientes
-- - Solo el administrador: datos del negocio, usuarios, bitácora,
--   respaldo, facturación electrónica (configuración), borrar ventas.
-- - Todo esto lo revisa la base de datos (no solo el panel).
-- =====================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'admins' and column_name = 'rol') then
    raise exception 'Primero corra v16_bitacora.sql.';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'productos' and column_name = 'costo')
     or not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'productos' and column_name = 'precio_oferta') then
    raise exception 'Faltan archivos anteriores: corra en orden v4_mejoras … v16 y después este.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Datos de cada usuario del panel
-- ---------------------------------------------------------------------
alter table public.admins add column if not exists usuario           text;
alter table public.admins add column if not exists permisos          text[] not null default '{}';
alter table public.admins add column if not exists activo            boolean not null default true;
alter table public.admins add column if not exists clave_cambiada_at timestamptz;
alter table public.admins add column if not exists pide_codigo       boolean not null default false;

alter table public.admins drop constraint if exists admin_usuario_valido;
alter table public.admins add constraint admin_usuario_valido
  check (usuario is null or usuario ~ '^[a-z0-9][a-z0-9._-]{2,29}$');
create unique index if not exists admins_usuario_unico on public.admins (usuario) where usuario is not null;

alter table public.admins drop constraint if exists admin_permisos_validos;
alter table public.admins add constraint admin_permisos_validos
  check (permisos <@ array['ventas','anular','caja','credito','inventario','productos','precios','reportes','preguntas']::text[]);

-- ---------------------------------------------------------------------
-- 2. Quién puede qué
-- ---------------------------------------------------------------------
-- Administrador = rol administrador, activo y con el código del autenticador (aal2)
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a
                 where a.user_id = auth.uid() and a.rol = 'administrador' and a.activo)
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

create or replace function public.es_administrador()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_admin();
$$;

-- El administrador puede todo; un empleado activo, solo lo que tenga marcado
-- (y si se le pide el código del autenticador, solo después de ponerlo)
create or replace function public.puede(p_permiso text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_admin()
      or exists (select 1 from public.admins a
                 where a.user_id = auth.uid() and a.rol = 'usuario' and a.activo
                   and p_permiso = any (a.permisos)
                   and (not a.pide_codigo or coalesce(auth.jwt() ->> 'aal', '') = 'aal2'));
$$;

-- Cualquier persona activa del panel (para leer productos, por ejemplo)
create or replace function public.es_personal()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_admin()
      or exists (select 1 from public.admins a
                 where a.user_id = auth.uid() and a.rol = 'usuario' and a.activo
                   and (not a.pide_codigo or coalesce(auth.jwt() ->> 'aal', '') = 'aal2'));
$$;

-- Lo que el panel necesita saber al entrar (antes del autenticador)
create or replace function public.mi_acceso()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('rol', a.rol, 'permisos', to_jsonb(a.permisos), 'nombre', a.nombre,
                            'usuario', a.usuario, 'activo', a.activo,
                            'pide_codigo', a.rol = 'administrador' or a.pide_codigo)
  from public.admins a where a.user_id = auth.uid();
$$;

create or replace function public.soy_admin_registrado()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid() and a.activo);
$$;

revoke all on function public.puede(text), public.es_personal(), public.mi_acceso() from public;
grant execute on function public.puede(text), public.es_personal(), public.mi_acceso() to authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.es_administrador(), public.soy_admin_registrado() to authenticated;

-- ---------------------------------------------------------------------
-- 3. Permisos en las tablas (se suman a las reglas del administrador)
-- ---------------------------------------------------------------------
do $$
declare
  -- tabla, nombre de la regla, comando, condición
  r record;
begin
  for r in
    select * from (values
      ('productos',            'productos_personal_ver',     'select', 'public.es_personal()'),
      ('productos',            'productos_personal_crear',   'insert', 'public.puede(''productos'')'),
      ('productos',            'productos_personal_editar',  'update', 'public.puede(''productos'')'),
      ('productos',            'productos_personal_borrar',  'delete', 'public.puede(''productos'')'),
      ('categorias',           'categorias_personal',        'all',    'public.puede(''productos'')'),
      ('pedidos',              'pedidos_personal_ver',       'select', 'public.puede(''ventas'') or public.puede(''caja'') or public.puede(''credito'') or public.puede(''reportes'')'),
      ('pedidos',              'pedidos_personal_crear',     'insert', 'public.puede(''ventas'')'),
      ('pedidos',              'pedidos_personal_editar',    'update', 'public.puede(''ventas'')'),
      ('pedido_items',         'items_personal_ver',         'select', 'public.puede(''ventas'') or public.puede(''caja'') or public.puede(''credito'') or public.puede(''reportes'')'),
      ('pedido_items',         'items_personal_crear',       'insert', 'public.puede(''ventas'')'),
      ('pedido_items',         'items_personal_editar',      'update', 'public.puede(''ventas'')'),
      ('pedido_items',         'items_personal_borrar',      'delete', 'public.puede(''ventas'')'),
      ('pagos',                'pagos_personal_ver',         'select', 'public.puede(''ventas'') or public.puede(''caja'') or public.puede(''credito'') or public.puede(''reportes'')'),
      ('pagos',                'pagos_personal_crear',       'insert', 'public.puede(''ventas'') or public.puede(''caja'')'),
      ('pagos',                'pagos_personal_editar',      'update', 'public.puede(''ventas'') or public.puede(''caja'')'),
      ('comprobantes_cliente', 'comp_cliente_personal',      'all',    'public.puede(''ventas'') or public.puede(''caja'')'),
      ('facturas',             'facturas_personal',          'all',    'public.puede(''ventas'')'),
      ('clientes',             'clientes_personal_ver',      'select', 'public.puede(''ventas'') or public.puede(''credito'')'),
      ('clientes',             'clientes_personal_crear',    'insert', 'public.puede(''credito'')'),
      ('clientes',             'clientes_personal_editar',   'update', 'public.puede(''credito'')'),
      ('abonos',               'abonos_personal_ver',        'select', 'public.puede(''credito'') or public.puede(''caja'') or public.puede(''reportes'')'),
      ('caja_turnos',          'caja_turnos_personal_ver',   'select', 'public.puede(''caja'') or public.puede(''reportes'')'),
      ('caja_movimientos',     'caja_mov_personal_ver',      'select', 'public.puede(''caja'') or public.puede(''reportes'')'),
      ('entradas',             'entradas_personal_ver',      'select', 'public.puede(''inventario'') or public.puede(''productos'')'),
      ('entrada_items',        'entrada_items_personal_ver', 'select', 'public.puede(''inventario'') or public.puede(''productos'')'),
      ('inventario_movimientos','inv_mov_personal_ver',      'select', 'public.puede(''inventario'') or public.puede(''productos'')'),
      ('precios_movimientos',  'precios_mov_personal_ver',   'select', 'public.puede(''precios'') or public.puede(''productos'')'),
      ('consultas',            'consultas_personal',         'all',    'public.puede(''preguntas'')'),
      ('fe_emisor',            'fe_emisor_personal_ver',     'select', 'public.puede(''ventas'') or public.puede(''reportes'')'),
      ('fe_documentos',        'fe_documentos_personal_ver', 'select', 'public.puede(''ventas'') or public.puede(''reportes'')')
    ) as t(tabla, regla, cmd, cond)
  loop
    if to_regclass('public.' || r.tabla) is null then continue; end if;
    execute format('drop policy if exists %I on public.%I', r.regla, r.tabla);
    if r.cmd = 'select' or r.cmd = 'delete' then
      execute format('create policy %I on public.%I for %s to authenticated using (%s)', r.regla, r.tabla, r.cmd, r.cond);
    elsif r.cmd = 'insert' then
      execute format('create policy %I on public.%I for insert to authenticated with check (%s)', r.regla, r.tabla, r.cond);
    else
      execute format('create policy %I on public.%I for %s to authenticated using (%s) with check (%s)', r.regla, r.tabla, r.cmd, r.cond, r.cond);
    end if;
  end loop;
end $$;

-- Fotos: comprobantes de pago (ventas y caja) y fotos de productos
drop policy if exists "comprobantes_personal_ver"   on storage.objects;
drop policy if exists "comprobantes_personal_subir" on storage.objects;
drop policy if exists "productos_fotos_personal_ver"    on storage.objects;
drop policy if exists "productos_fotos_personal_subir"  on storage.objects;
drop policy if exists "productos_fotos_personal_editar" on storage.objects;
drop policy if exists "productos_fotos_personal_borrar" on storage.objects;
create policy "comprobantes_personal_ver" on storage.objects for select to authenticated
  using (bucket_id = 'comprobantes' and (public.puede('ventas') or public.puede('caja')));
create policy "comprobantes_personal_subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'comprobantes' and (public.puede('ventas') or public.puede('caja')));
create policy "productos_fotos_personal_ver" on storage.objects for select to authenticated
  using (bucket_id = 'productos' and public.puede('productos'));
create policy "productos_fotos_personal_subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'productos' and public.puede('productos'));
create policy "productos_fotos_personal_editar" on storage.objects for update to authenticated
  using (bucket_id = 'productos' and public.puede('productos'));
create policy "productos_fotos_personal_borrar" on storage.objects for delete to authenticated
  using (bucket_id = 'productos' and public.puede('productos'));

-- ---------------------------------------------------------------------
-- 4. Reglas que no se ven en la tabla: precios y anulaciones
-- ---------------------------------------------------------------------
-- Solo quien tiene "precios" pone o cambia precios (también al crear un producto)
create or replace function public.permiso_precios()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.uid() is null or public.puede('precios') then return new; end if;
  if tg_op = 'INSERT' then
    if new.precio is not null or new.precio_oferta is not null or new.costo is not null then
      raise exception 'No tiene permiso para poner precios: deje el precio vacío y el administrador lo pone.' using errcode = '42501';
    end if;
  elsif (new.precio, new.precio_oferta, new.oferta_hasta, new.costo)
        is distinct from (old.precio, old.precio_oferta, old.oferta_hasta, old.costo) then
    raise exception 'No tiene permiso para cambiar precios.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_permiso_precios on public.productos;
create trigger trg_permiso_precios before insert or update on public.productos
  for each row execute function public.permiso_precios();

-- En una venta, sin permiso de precios no se baja el precio de un producto del catálogo
-- (el precio normal o la oferta vigente). Los renglones libres (sin producto) sí se escriben.
create or replace function public.permiso_precio_venta()
returns trigger language plpgsql set search_path = '' as $$
declare v_min numeric;
begin
  if auth.uid() is null or new.producto_id is null or public.puede('precios') then return new; end if;
  if tg_op = 'UPDATE' and new.precio_unit is not distinct from old.precio_unit
     and new.producto_id is not distinct from old.producto_id then return new; end if;
  select case when p.precio_oferta is not null and p.oferta_hasta is not null
                   and p.oferta_hasta >= (now() at time zone 'America/Costa_Rica')::date
              then least(p.precio, p.precio_oferta) else p.precio end
    into v_min from public.productos p where p.id = new.producto_id;
  if v_min is not null and new.precio_unit < v_min then
    raise exception 'No tiene permiso para bajar precios: % va a ₡%.', new.descripcion, trim(trailing '.' from to_char(v_min, 'FM999999999990.99'))
      using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_permiso_precio_venta on public.pedido_items;
create trigger trg_permiso_precio_venta before insert or update on public.pedido_items
  for each row execute function public.permiso_precio_venta();

-- Anular una venta o un pago necesita el permiso "anular"
create or replace function public.permiso_anular()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;
  -- (un IF por tabla: cada una tiene sus propios campos)
  if tg_table_name = 'pedidos' then
    if new.estado = 'anulada' and old.estado <> 'anulada' and not public.puede('anular') then
      raise exception 'No tiene permiso para anular ventas.' using errcode = '42501';
    end if;
  elsif tg_table_name = 'pagos' then
    -- los pagos de un abono los maneja Crédito (anular_abono)
    if new.anulado and not old.anulado and new.abono_id is null and not public.puede('anular') then
      raise exception 'No tiene permiso para anular pagos.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_permiso_anular on public.pedidos;
create trigger trg_permiso_anular before update on public.pedidos
  for each row execute function public.permiso_anular();
drop trigger if exists trg_permiso_anular on public.pagos;
create trigger trg_permiso_anular before update on public.pagos
  for each row execute function public.permiso_anular();

-- ---------------------------------------------------------------------
-- 5. Funciones que antes eran solo del administrador y ahora van por permiso
--    (se cambia el chequeo dentro de cada una; lo demás queda igual)
-- ---------------------------------------------------------------------
do $$
declare
  r record; f record; def text;
begin
  for r in
    select * from (values
      ('abrir_caja',                   'public.puede(''caja'')'),
      ('mover_caja',                   'public.puede(''caja'')'),
      ('cerrar_caja',                  'public.puede(''caja'')'),
      ('resumen_caja',                 '(public.puede(''caja'') or public.puede(''reportes''))'),
      ('ajustar_precios',              'public.puede(''precios'')'),
      ('anotar_vendido',               'public.puede(''productos'')'),
      ('importar_productos',           '(public.puede(''productos'') and public.puede(''precios''))'),
      ('registrar_abono',              'public.puede(''credito'')'),
      ('anular_abono',                 'public.puede(''credito'')'),
      ('verificar_abono',              '(public.puede(''credito'') or public.puede(''caja''))'),
      ('poner_credito',                'public.puede(''credito'')'),
      ('registrar_entrada',            'public.puede(''inventario'')'),
      ('anular_entrada',               'public.puede(''inventario'')'),
      ('registrar_venta_sin_internet', 'public.puede(''ventas'')'),
      ('reporte_ventas',               'public.puede(''reportes'')')
    ) as t(nombre, chequeo)
  loop
    for f in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
             where s.nspname = 'public' and p.proname = r.nombre loop
      def := pg_get_functiondef(f.oid);
      if position('public.is_admin()' in def) = 0 then continue; end if;   -- ya está cambiada
      def := replace(def, 'public.is_admin()', r.chequeo);
      def := replace(def, '''Solo el administrador.''', '''No tiene permiso para esto.''');
      execute def;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 6. Manejo de empleados (solo el administrador)
-- ---------------------------------------------------------------------
-- La lista ahora trae usuario, permisos y si está activo
drop function if exists public.usuarios_panel();
create function public.usuarios_panel()
returns table (user_id uuid, nombre text, correo text, usuario text, rol text, permisos text[], activo boolean,
               pide_codigo boolean, creado timestamptz, ultimo_ingreso timestamptz, clave_cambiada_at timestamptz, soy_yo boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'No autorizado.' using errcode = '42501'; end if;
  return query
    select a.user_id, a.nombre, u.email::text, a.usuario, a.rol, a.permisos, a.activo,
           a.rol = 'administrador' or a.pide_codigo, a.created_at, u.last_sign_in_at, a.clave_cambiada_at, a.user_id = auth.uid()
    from public.admins a
    left join auth.users u on u.id = a.user_id
    order by a.rol, a.created_at;
end $$;
revoke all on function public.usuarios_panel() from public, anon;
grant execute on function public.usuarios_panel() to authenticated;

-- Lo llama la función "usuarios" después de crear la cuenta (con la sesión del administrador)
drop function if exists public.registrar_empleado(uuid, text, text, text[]);
create or replace function public.registrar_empleado(p_user uuid, p_usuario text, p_nombre text, p_permisos text[], p_pide_codigo boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare v_nombre text := nullif(regexp_replace(btrim(coalesce(p_nombre, '')), '\s+', ' ', 'g'), '');
begin
  if not public.is_admin() then raise exception 'Solo el administrador agrega usuarios.' using errcode = '42501'; end if;
  if v_nombre is null or char_length(v_nombre) < 2 then
    raise exception 'Escriba el nombre.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from auth.users where id = p_user) then
    raise exception 'Esa cuenta no existe.' using errcode = 'P0001';
  end if;
  insert into public.admins (user_id, rol, usuario, nombre, permisos, activo, pide_codigo)
  values (p_user, 'usuario', lower(btrim(p_usuario)), v_nombre, coalesce(p_permisos, '{}'), true, coalesce(p_pide_codigo, false));
end $$;
revoke all on function public.registrar_empleado(uuid, text, text, text[], boolean) from public, anon;
grant execute on function public.registrar_empleado(uuid, text, text, text[], boolean) to authenticated;

drop function if exists public.poner_permisos(uuid, text[]);
create or replace function public.poner_permisos(p_user uuid, p_permisos text[], p_pide_codigo boolean default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Solo el administrador da permisos.' using errcode = '42501'; end if;
  update public.admins
     set permisos = coalesce(p_permisos, '{}'),
         pide_codigo = coalesce(p_pide_codigo, pide_codigo)
   where user_id = p_user;
  if not found then raise exception 'Ese usuario no está en el panel.' using errcode = 'P0001'; end if;
end $$;
revoke all on function public.poner_permisos(uuid, text[], boolean) from public, anon;
grant execute on function public.poner_permisos(uuid, text[], boolean) to authenticated;

create or replace function public.poner_activo(p_user uuid, p_activo boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Solo el administrador.' using errcode = '42501'; end if;
  if p_user = auth.uid() and not p_activo then
    raise exception 'No se puede desactivar a usted mismo.' using errcode = 'P0001';
  end if;
  perform 1 from public.admins where rol = 'administrador' for update;
  if not p_activo and (select rol from public.admins where user_id = p_user) = 'administrador'
     and (select count(*) from public.admins where rol = 'administrador' and activo) <= 1 then
    raise exception 'Tiene que quedar al menos un administrador activo.' using errcode = 'P0001';
  end if;
  update public.admins set activo = p_activo where user_id = p_user;
  if not found then raise exception 'Ese usuario no está en el panel.' using errcode = 'P0001'; end if;
end $$;
revoke all on function public.poner_activo(uuid, boolean) from public, anon;
grant execute on function public.poner_activo(uuid, boolean) to authenticated;

-- La función "usuarios" avisa aquí cuando cambia una contraseña o un usuario (queda en la bitácora)
create or replace function public.anotar_cuenta(p_user uuid, p_usuario text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Solo el administrador.' using errcode = '42501'; end if;
  if p_usuario is null then
    update public.admins set clave_cambiada_at = now() where user_id = p_user;
  else
    update public.admins set usuario = lower(btrim(p_usuario)) where user_id = p_user;
  end if;
end $$;
revoke all on function public.anotar_cuenta(uuid, text) from public, anon;
grant execute on function public.anotar_cuenta(uuid, text) to authenticated;

-- El rol se cambia solo entre administradores activos (siempre queda uno)
create or replace function public.poner_rol_usuario(p_user uuid, p_rol text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede cambiar roles.' using errcode = '42501';
  end if;
  if p_rol not in ('administrador', 'usuario') then raise exception 'Rol no válido.' using errcode = 'P0001'; end if;
  perform 1 from public.admins where rol = 'administrador' for update;
  if p_rol = 'usuario' and (select rol from public.admins where user_id = p_user) = 'administrador'
     and (select count(*) from public.admins where rol = 'administrador' and activo) <= 1 then
    raise exception 'Tiene que quedar al menos un administrador.' using errcode = 'P0001';
  end if;
  update public.admins set rol = p_rol where user_id = p_user;
  if not found then raise exception 'Ese usuario no está en el panel.' using errcode = 'P0001'; end if;
end $$;
