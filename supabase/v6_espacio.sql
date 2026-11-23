-- =====================================================================
-- ALMACÉN LA CAMPIÑA · v6 · ESPACIO USADO Y LIMPIEZA DE FOTOS VIEJAS
-- Corra este archivo DESPUÉS de schema.sql (y v4/v5 si los tiene).
-- Se puede correr las veces que quiera.
--
-- - espacio_archivos(): cuánto ocupan las fotos y la base de datos.
-- - comprobantes_para_limpiar(meses): fotos de comprobantes de ventas YA
--   CERRADAS (pagadas, entregadas o anuladas) de hace más de X meses.
-- - Solo esas fotos se pueden borrar (regla de Storage). Lo de menos de
--   3 meses, o de ventas abiertas, o comprobantes nuevos sin revisar,
--   no se puede borrar aunque alguien lo intente.
-- - El pago NO se borra: quedan monto, número de comprobante y fecha.
--   Solo se borra la imagen (después de descargarla en un ZIP).
-- =====================================================================

create table if not exists public.archivos_borrados (
  ruta        text primary key,
  borrado_at  timestamptz not null default now(),
  borrado_por uuid default auth.uid()
);
alter table public.archivos_borrados enable row level security;
drop policy if exists "archivos_borrados_admin" on public.archivos_borrados;
create policy "archivos_borrados_admin" on public.archivos_borrados for select to authenticated using (public.is_admin());
revoke all on public.archivos_borrados from anon, authenticated;
grant select on public.archivos_borrados to authenticated;

-- ¿Esta foto de comprobante se puede borrar? (venta cerrada y vieja)
create or replace function public.comprobante_borrable(p_ruta text, p_meses int default 3)
returns boolean language sql stable security definer set search_path = '' as $$
  with ventas as (
    select g.pedido_id from public.pagos g where g.comprobante_path = p_ruta
    union
    select c.pedido_id from public.comprobantes_cliente c where c.ruta = p_ruta and c.estado <> 'nuevo'
  )
  select exists (select 1 from ventas)
     and not exists (select 1 from public.comprobantes_cliente c where c.ruta = p_ruta and c.estado = 'nuevo')
     and not exists (
       select 1 from ventas v join public.pedidos p on p.id = v.pedido_id
       where p.created_at > now() - make_interval(months => greatest(3, least(coalesce(p_meses, 3), 60)))
          or not (p.estado in ('entregada', 'anulada') or p.estado_pago in ('pagado', 'sobrepago'))
     );
$$;

create or replace function public.espacio_archivos()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  if not public.is_admin() then raise exception 'No autorizado.' using errcode = '42501'; end if;
  select jsonb_build_object(
    'buckets', coalesce((
      select jsonb_object_agg(bucket_id, jsonb_build_object('archivos', n, 'bytes', b))
      from (select bucket_id, count(*) n, coalesce(sum((metadata->>'size')::bigint), 0) b
            from storage.objects group by bucket_id) x), '{}'::jsonb),
    'base_bytes', pg_database_size(current_database()))
  into r;
  return r;
end $$;

create or replace function public.comprobantes_para_limpiar(p_meses int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_meses int := greatest(3, least(coalesce(p_meses, 6), 60)); r jsonb;
begin
  if not public.is_admin() then raise exception 'No autorizado.' using errcode = '42501'; end if;
  with fotos as (
    select g.comprobante_path as ruta, g.pedido_id from public.pagos g where g.comprobante_path is not null
    union
    select c.ruta, c.pedido_id from public.comprobantes_cliente c where c.estado <> 'nuevo'
  ), lista as (
    select distinct on (f.ruta) f.ruta, p.codigo, p.cliente_nombre, p.created_at,
           coalesce((o.metadata->>'size')::bigint, 0) as bytes
    from fotos f
    join public.pedidos p on p.id = f.pedido_id
    join storage.objects o on o.bucket_id = 'comprobantes' and o.name = f.ruta
    where public.comprobante_borrable(f.ruta, v_meses)
    order by f.ruta, p.created_at
  )
  select jsonb_build_object(
    'total', (select count(*) from lista),
    'bytes', (select coalesce(sum(bytes), 0) from lista),
    'fotos', coalesce((select jsonb_agg(jsonb_build_object('ruta', ruta, 'codigo', codigo, 'cliente', cliente_nombre,
                                                           'fecha', created_at, 'bytes', bytes) order by created_at)
                       from (select * from lista order by created_at limit 300) x), '[]'::jsonb))
  into r;
  return r;
end $$;

-- Después de borrar las fotos en Storage, se anotan (solo las que de verdad ya no existen)
create or replace function public.marcar_fotos_borradas(p_rutas text[])
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'No autorizado.' using errcode = '42501'; end if;
  insert into public.archivos_borrados (ruta)
  select distinct r from unnest(p_rutas) r
  where r is not null
    and not exists (select 1 from storage.objects o where o.bucket_id = 'comprobantes' and o.name = r)
    and (exists (select 1 from public.pagos where comprobante_path = r)
         or exists (select 1 from public.comprobantes_cliente where ruta = r))
  on conflict (ruta) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.comprobante_borrable(text, int) from public, anon;
revoke all on function public.espacio_archivos() from public, anon;
revoke all on function public.comprobantes_para_limpiar(int) from public, anon;
revoke all on function public.marcar_fotos_borradas(text[]) from public, anon;
grant execute on function public.comprobante_borrable(text, int) to authenticated;
grant execute on function public.espacio_archivos() to authenticated;
grant execute on function public.comprobantes_para_limpiar(int) to authenticated;
grant execute on function public.marcar_fotos_borradas(text[]) to authenticated;

-- Storage: el admin solo puede borrar fotos de comprobantes viejos de ventas cerradas
drop policy if exists "comprobantes_borrar_viejos" on storage.objects;
create policy "comprobantes_borrar_viejos" on storage.objects for delete to authenticated
  using (bucket_id = 'comprobantes' and public.is_admin() and public.comprobante_borrable(name));
