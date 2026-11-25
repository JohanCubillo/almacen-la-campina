-- =====================================================================
--  v22 — Exoneración de IVA (EXONET) en las ventas
--  Requiere v10 (facturación), v13 (clientes) y v17 (permisos).
--  Se puede correr más de una vez.
--
--  - pedidos.exoneracion: la autorización que se aplicó en esa venta
--  - clientes.exoneracion: la última del cliente de crédito (para no volver a escribirla)
--  - poner_exoneracion(pedido, datos): la pone o la quita (null) con su revisión
--
--  Forma de "datos" (la arma el panel con lo que contesta Hacienda):
--  { numero: "AL-00012345-24", tipo: "04", institucion: "01", institucion_otro: null,
--    identificacion: "3101123456", nombre: "…", porcentaje: 13, fecha_emision: "2024-01-15T00:00:00-06:00",
--    vence: "2025-01-15", cabys: ["…13 dígitos…"] | null (null = cubre todo) }
-- =====================================================================

alter table public.pedidos  add column if not exists exoneracion jsonb;
alter table public.clientes add column if not exists exoneracion jsonb;

create or replace function public._exoneracion_valida(p jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare v_c jsonb;
begin
  if jsonb_typeof(p) <> 'object' then raise exception 'Exoneración no válida.' using errcode = 'P0001'; end if;
  if coalesce(p ->> 'numero', '') !~ '^[A-Za-z0-9-]{3,40}$' then
    raise exception 'Revise el número de la exoneración.' using errcode = 'P0001';
  end if;
  if coalesce(p ->> 'tipo', '') not in ('01','02','03','04','05','06','07','08','09','10','11','99') then
    raise exception 'Tipo de documento de exoneración no válido.' using errcode = 'P0001';
  end if;
  if coalesce(p ->> 'institucion', '') not in ('01','02','03','04','05','06','07','08','09','10','11','12','99') then
    raise exception 'Institución de la exoneración no válida.' using errcode = 'P0001';
  end if;
  if coalesce(p ->> 'porcentaje', '') !~ '^[0-9]{1,2}(\.[0-9]{1,2})?$'
     or (p ->> 'porcentaje')::numeric <= 0 or (p ->> 'porcentaje')::numeric > 13 then
    raise exception 'El porcentaje exonerado va de 0,01 a 13 puntos.' using errcode = 'P0001';
  end if;
  if coalesce(p ->> 'identificacion', '') <> '' and (p ->> 'identificacion') !~ '^[0-9]{9,12}$' then
    raise exception 'La cédula de la exoneración no es válida.' using errcode = 'P0001';
  end if;
  if coalesce(p ->> 'vence', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'Falta la fecha en que vence la exoneración.' using errcode = 'P0001';
  end if;
  if coalesce(p ->> 'fecha_emision', '') = '' then
    raise exception 'Falta la fecha de emisión de la exoneración.' using errcode = 'P0001';
  end if;
  perform (p ->> 'fecha_emision')::timestamptz;
  v_c := p -> 'cabys';
  if v_c is not null and jsonb_typeof(v_c) <> 'null' then
    if jsonb_typeof(v_c) <> 'array' or jsonb_array_length(v_c) > 5000
       or exists (select 1 from jsonb_array_elements_text(v_c) x where x !~ '^[0-9]{13}$') then
      raise exception 'La lista de CABYS de la exoneración no es válida.' using errcode = 'P0001';
    end if;
  end if;
exception when invalid_datetime_format or datetime_field_overflow then
  raise exception 'Revise la fecha de emisión de la exoneración.' using errcode = 'P0001';
end $$;

create or replace function public.poner_exoneracion(p_pedido bigint, p_ex jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_p record;
begin
  if not public.puede('ventas') then raise exception 'No tiene permiso para ventas.' using errcode = '42501'; end if;
  select id, estado, cliente_id into v_p from public.pedidos where id = p_pedido for update;
  if not found then raise exception 'La venta no existe.' using errcode = 'P0001'; end if;
  if v_p.estado = 'anulada' then raise exception 'La venta está anulada.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.fe_documentos d where d.pedido_id = p_pedido and d.tipo in ('01','04')
             and d.estado <> 'rechazado' and not d.anulado) then
    raise exception 'La venta ya tiene comprobante electrónico: la exoneración ya no se puede cambiar.' using errcode = 'P0001';
  end if;
  if p_ex is not null and jsonb_typeof(p_ex) <> 'null' then
    perform public._exoneracion_valida(p_ex);
    if (p_ex ->> 'vence')::date < (now() at time zone 'America/Costa_Rica')::date then
      raise exception 'Esa exoneración ya venció.' using errcode = 'P0001';
    end if;
    update public.pedidos set exoneracion = p_ex where id = p_pedido;
    if v_p.cliente_id is not null then
      update public.clientes set exoneracion = p_ex where id = v_p.cliente_id;
    end if;
  else
    update public.pedidos set exoneracion = null where id = p_pedido;
  end if;
end $$;
revoke all on function public.poner_exoneracion(bigint, jsonb) from public, anon;
grant execute on function public.poner_exoneracion(bigint, jsonb) to authenticated;
revoke all on function public._exoneracion_valida(jsonb) from public, anon, authenticated;
