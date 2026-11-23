-- =====================================================================
-- ALMACÉN LA CAMPIÑA · v8 · FORMULARIO DE PREGUNTAS
-- Corra este archivo DESPUÉS de schema.sql (y v4 si quiere avisos por Telegram).
-- Se puede correr las veces que quiera.
--
-- Los clientes dejan su pregunta con nombre y teléfono desde la página.
-- Solo el administrador (con su código de 6 dígitos) puede leerlas.
-- La página no escribe directo en la tabla: usa enviar_consulta(), que
-- revisa los datos y frena el spam (máx. 5 por teléfono al día y
-- 30 en total cada 10 minutos).
-- =====================================================================

create table if not exists public.consultas (
  id            bigint generated always as identity primary key,
  nombre        text not null check (char_length(nombre) between 2 and 80),
  telefono      text not null check (telefono ~ '^[0-9 +()-]{8,20}$'),
  correo        text check (correo is null or (char_length(correo) <= 120 and correo ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  asunto        text not null default 'otro' check (asunto in ('producto', 'precio', 'envio', 'pedido', 'otro')),
  mensaje       text not null check (char_length(mensaje) between 5 and 1000),
  producto_id   bigint references public.productos(id) on delete set null,
  estado        text not null default 'nueva' check (estado in ('nueva', 'respondida', 'archivada')),
  respondida_at timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists consultas_fecha_idx on public.consultas (created_at desc);
create index if not exists consultas_tel_idx on public.consultas (telefono, created_at desc);

alter table public.consultas enable row level security;
drop policy if exists "consultas_admin" on public.consultas;
create policy "consultas_admin" on public.consultas for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
revoke all on public.consultas from anon, authenticated;
grant select, delete on public.consultas to authenticated;
grant update (estado, respondida_at) on public.consultas to authenticated;

create or replace function public.enviar_consulta(p_nombre text, p_telefono text, p_correo text,
                                                  p_asunto text, p_mensaje text, p_producto bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_nombre  text := left(trim(coalesce(p_nombre, '')), 80);
  v_tel     text := trim(coalesce(p_telefono, ''));
  v_correo  text := nullif(lower(trim(coalesce(p_correo, ''))), '');
  v_asunto  text := coalesce(nullif(p_asunto, ''), 'otro');
  v_msj     text := trim(coalesce(p_mensaje, ''));
  v_prod    bigint;
  v_pnombre text;
  v_id      bigint;
  v_ok      boolean;
begin
  if char_length(v_nombre) < 2 then return jsonb_build_object('ok', false, 'error', 'Escriba su nombre.'); end if;
  if v_tel !~ '^[0-9 +()-]{8,20}$' or char_length(regexp_replace(v_tel, '\D', '', 'g')) < 8 then
    return jsonb_build_object('ok', false, 'error', 'Revise el teléfono: necesitamos 8 dígitos.');
  end if;
  if v_correo is not null and (char_length(v_correo) > 120 or v_correo !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    return jsonb_build_object('ok', false, 'error', 'Revise el correo electrónico.');
  end if;
  if v_asunto not in ('producto', 'precio', 'envio', 'pedido', 'otro') then v_asunto := 'otro'; end if;
  if char_length(v_msj) < 5 then return jsonb_build_object('ok', false, 'error', 'Escriba su pregunta.'); end if;
  if char_length(v_msj) > 1000 then return jsonb_build_object('ok', false, 'error', 'La pregunta es muy larga (máximo 1000 letras).'); end if;

  -- freno contra spam
  if (select count(*) from public.consultas
      where regexp_replace(telefono, '\D', '', 'g') = regexp_replace(v_tel, '\D', '', 'g')
        and created_at > now() - interval '1 day') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'Ya recibimos varias preguntas de este número hoy. Le respondemos pronto, o escríbanos por WhatsApp.');
  end if;
  if (select count(*) from public.consultas where created_at > now() - interval '10 minutes') >= 30 then
    return jsonb_build_object('ok', false, 'error', 'Mucho movimiento en este momento. Intente en unos minutos.');
  end if;

  select id, nombre into v_prod, v_pnombre from public.productos where id = p_producto and activo;

  insert into public.consultas (nombre, telefono, correo, asunto, mensaje, producto_id)
  values (v_nombre, v_tel, v_correo, v_asunto, v_msj, v_prod)
  returning id into v_id;

  -- aviso por Telegram (si la v4 está instalada y los avisos encendidos)
  if to_regprocedure('public._avisar(text, boolean)') is not null then
    begin
      execute 'select public._avisar($1, false)' into v_ok using
        'Pregunta nueva de ' || v_nombre || ' (' || v_tel || ')' ||
        coalesce(E'\nProducto: ' || v_pnombre, '') || E'\n' || left(v_msj, 300);
    exception when others then null;
    end;
  end if;

  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

revoke all on function public.enviar_consulta(text, text, text, text, text, bigint) from public;
grant execute on function public.enviar_consulta(text, text, text, text, text, bigint) to anon, authenticated;

-- registro de actividad, igual que las demás tablas
do $$
begin
  if to_regprocedure('public.registrar_auditoria()') is not null then
    drop trigger if exists trg_auditoria on public.consultas;
    create trigger trg_auditoria after update or delete on public.consultas
      for each row execute function public.registrar_auditoria();
  end if;
end $$;
