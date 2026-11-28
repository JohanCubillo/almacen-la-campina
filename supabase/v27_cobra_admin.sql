-- =====================================================================
-- ALMACÉN LA CAMPIÑA · v27 · SOLO EL ADMINISTRADOR COBRA
-- Corra este archivo DESPUÉS de v26_devolucion_sin_caja.sql.
-- Se puede correr las veces que quiera. Si algún día vuelve a correr
-- v13, v19 o v24, corra otra vez este al final.
--
-- Interruptor en Datos del negocio → "Solo el administrador cobra":
-- - APAGADO: todo funciona como antes.
-- - ENCENDIDO: los empleados arman la venta (productos, cliente, datos
--   para la factura) y la mandan a cobrar. Solo un administrador (con el
--   código del celular) registra pagos, abonos de crédito y apartados, y
--   marca "Ya lo vi en el banco". El tiquete o la factura electrónica sale
--   cuando el administrador cobra.
-- - SIN INTERNET el empleado sí puede cobrar (no le puede llegar al
--   administrador). Esos pagos quedan marcados "Cobrado sin internet" con
--   el nombre de quien cobró, y van a la bitácora.
-- - Las ventas a crédito no llevan cobro: el empleado las sigue haciendo.
-- - Todo esto lo revisa la base de datos, no solo el panel.
-- =====================================================================

do $$
begin
  if to_regclass('public.devoluciones') is null
     or not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'pagos' and column_name = 'offline_id') then
    raise exception 'Faltan archivos anteriores: corra en orden hasta v26 y después este.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. El interruptor (una sola fila)
-- ---------------------------------------------------------------------
create table if not exists public.config_cobro (
  id           smallint primary key default 1 check (id = 1),
  solo_admin   boolean not null default false,
  cambiado_por uuid,
  cambiado_at  timestamptz
);
insert into public.config_cobro (id) values (1) on conflict (id) do nothing;

alter table public.config_cobro enable row level security;
drop policy if exists "config_cobro_ver" on public.config_cobro;
create policy "config_cobro_ver" on public.config_cobro for select to authenticated using (public.es_personal());
revoke all on public.config_cobro from anon, authenticated;
grant select on public.config_cobro to authenticated;      -- cambiar: solo con la función de abajo

-- a la bitácora (quién lo encendió o apagó y cuándo)
drop trigger if exists trg_auditoria on public.config_cobro;
create trigger trg_auditoria after insert or update or delete on public.config_cobro
  for each row when (auth.uid() is not null) execute function public.registrar_auditoria();

create or replace function public.solo_admin_cobra()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select solo_admin from public.config_cobro where id = 1), false);
$$;
revoke all on function public.solo_admin_cobra() from public, anon;
grant execute on function public.solo_admin_cobra() to authenticated;

create or replace function public.poner_solo_admin_cobra(p_activo boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.es_administrador() then
    raise exception 'Solo el administrador cambia esto.' using errcode = '42501';
  end if;
  update public.config_cobro
     set solo_admin = coalesce(p_activo, false), cambiado_por = auth.uid(), cambiado_at = now()
   where id = 1;
  return coalesce(p_activo, false);
end $$;
revoke all on function public.poner_solo_admin_cobra(boolean) from public, anon;
grant execute on function public.poner_solo_admin_cobra(boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Pagos hechos sin internet: quedan marcados
-- ---------------------------------------------------------------------
alter table public.pagos add column if not exists sin_internet boolean not null default false;
grant insert (sin_internet) on public.pagos to authenticated;

-- ---------------------------------------------------------------------
-- 3. La regla: con el interruptor encendido, solo el administrador cobra
--    y verifica. Un empleado solo puede cobrar lo que hizo sin internet.
-- ---------------------------------------------------------------------
create or replace function public.cobro_solo_admin()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_offline boolean;
begin
  -- lo de la página (clientes sin cuenta) y lo que hace el sistema no pasa por aquí
  if auth.uid() is null or not public.solo_admin_cobra() or public.es_administrador() then
    if tg_op = 'INSERT' and coalesce(current_setting('lc.pago_sin_internet', true), '') = 'si' then new.sin_internet := true; end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_offline := coalesce(new.sin_internet, false)
              or coalesce(current_setting('lc.pago_sin_internet', true), '') = 'si'
              or coalesce(new.nota, '') = 'Registrado sin internet';
    if not v_offline then
      raise exception 'Solo el administrador cobra. Guarde la venta con “Enviar a cobrar”.' using errcode = '42501';
    end if;
    new.sin_internet := true;
    return new;
  end if;

  -- UPDATE: marcar "Ya lo vi en el banco" también es cobrar
  if coalesce(new.verificado, false) and not coalesce(old.verificado, false) then
    raise exception 'Solo el administrador marca los pagos como vistos en el banco.' using errcode = '42501';
  end if;
  new.sin_internet := old.sin_internet;
  return new;
end $$;

drop trigger if exists trg_cobro_solo_admin on public.pagos;
create trigger trg_cobro_solo_admin before insert or update on public.pagos
  for each row execute function public.cobro_solo_admin();

-- ---------------------------------------------------------------------
-- 4. Ventas y abonos que llegan después de hacerse sin internet:
--    "sin_internet": true en lo que manda el panel marca sus pagos
--    (se agrega una línea al principio de cada función, sin tocar lo demás)
-- ---------------------------------------------------------------------
do $$
declare
  r record; f record; def text; linea text;
begin
  for r in
    select * from (values
      ('registrar_venta_sin_internet', 'p_venta'),
      ('registrar_abono',              'p')
    ) as t(nombre, arg)
  loop
    linea := format(E'  perform set_config(''lc.pago_sin_internet'', case when coalesce((%s->>''sin_internet'')::boolean, false) then ''si'' else '''' end, true);   -- v27\n', r.arg);
    for f in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
             where s.nspname = 'public' and p.proname = r.nombre loop
      def := pg_get_functiondef(f.oid);
      if position('lc.pago_sin_internet' in def) > 0 then continue; end if;   -- ya tiene la línea
      -- el cuerpo puede venir con saltos de línea de Windows (\r\n) si se pegó desde Windows
      if def !~ '\r?\nbegin\r?\n' then
        raise exception 'No se pudo preparar %: avise para revisarlo.', r.nombre;
      end if;
      def := regexp_replace(def, '(\r?\nbegin\r?\n)', E'\\1' || replace(linea, '\', '\\'));
      execute def;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4b. Arreglo de v19: un abono hecho sin internet que se manda dos veces no
--     se repite. En v19 este cambio no se aplicaba si la función se había
--     pegado desde Windows (saltos de línea \r\n).
-- ---------------------------------------------------------------------
do $$
declare f record; def text;
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'abonos' and column_name = 'offline_id') then
    return;                                   -- base sin v19: no aplica
  end if;
  for f in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
           where s.nspname = 'public' and p.proname = 'registrar_abono' loop
    def := pg_get_functiondef(f.oid);
    if position('lc.abono_offline' in def) > 0 then continue; end if;   -- ya lo tiene
    if def !~ '\r?\nbegin\r?\n' then
      raise exception 'No se pudo preparar registrar_abono: avise para revisarlo.';
    end if;
    def := regexp_replace(def, '(\r?\nbegin\r?\n)', E'\\1  if nullif(p->>''offline_id'', '''') is not null then\n    if exists (select 1 from public.abonos where offline_id = (p->>''offline_id'')::uuid) then\n      return jsonb_build_object(''repetido'', true, ''aplicado'', ''[]''::jsonb);\n    end if;\n    perform set_config(''lc.abono_offline'', p->>''offline_id'', true);\n  end if;\n');
    execute def;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 5. Tiempo real: la compu del administrador se entera al momento
--    de cada venta nueva (si no, la ve en la revisión de cada minuto)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pedidos') then
    execute 'alter publication supabase_realtime add table public.pedidos';
  end if;
end $$;
