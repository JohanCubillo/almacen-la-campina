-- =====================================================================
-- ALMACÉN LA CAMPIÑA · v7 · EL CLIENTE NO ESCRIBE EL MONTO
-- Corra este archivo DESPUÉS de v4_mejoras.sql. Se puede correr varias veces.
--
-- Cuando el cliente sube su comprobante, el monto ya no lo escribe él:
-- se anota el saldo completo del pedido en ese momento (total menos lo ya
-- registrado). Así no hay montos mal escritos ni pagos "a medias".
-- El dinero real se confirma igual en la app del banco antes de entregar.
-- =====================================================================

create or replace function public.reportar_comprobante(p_codigo text, p_telefono text, p_ruta text,
                                                       p_monto numeric, p_referencia text, p_nota text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a jsonb; v_id bigint; v_cod text; v_saldo numeric;
        v_ref text := nullif(regexp_replace(coalesce(p_referencia, ''), '\s', '', 'g'), '');
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
  if v_ref is not null and v_ref !~ '^[0-9A-Za-z-]{4,40}$' then
    return jsonb_build_object('ok', false, 'error', 'El número de comprobante solo lleva números, letras o guiones.');
  end if;
  -- el monto es el saldo del pedido, no lo que diga la página (p_monto se ignora)
  select nullif(greatest(total - pagado_registrado, 0), 0) into v_saldo from public.pedidos where id = v_id;

  update public.subidas_permitidas set usada = true where ruta = p_ruta;
  insert into public.comprobantes_cliente (pedido_id, ruta, monto_reportado, referencia_reportada, nota)
  values (v_id, p_ruta, v_saldo, v_ref, left(nullif(trim(coalesce(p_nota, '')), ''), 300));
  update public.pedidos set revisado = false where id = v_id returning codigo into v_cod;
  perform public._avisar(
    'Comprobante SINPE recibido · pedido ' || v_cod ||
    coalesce(E'\nSaldo del pedido: ₡' || to_char(v_saldo, 'FM999G999G999'), '') ||
    coalesce(E'\nComprobante: ' || v_ref, '') || E'\nRevise en el banco que llegó el monto completo antes de entregar.' || E'\n' ||
    (select panel_url from public.avisos where id = 1));
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.reportar_comprobante(text, text, text, numeric, text, text) from public;
grant execute on function public.reportar_comprobante(text, text, text, numeric, text, text) to anon, authenticated;
