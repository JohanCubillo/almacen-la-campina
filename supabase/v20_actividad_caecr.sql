-- v20: código de actividad económica con el catálogo nuevo (CAECR, TRIBU-CR)
-- Hacienda ahora registra la actividad como "6201.0" (4 dígitos, punto, 1 dígito).
-- Ese es el valor que va en el XML 4.4 (CodigoActividadEmisor, 6 caracteres).
-- Se sigue aceptando el formato viejo de 6 dígitos para no romper datos guardados.
-- Se puede correr más de una vez.

do $$
declare c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
     where con.conrelid = 'public.fe_emisor'::regclass
       and con.contype = 'c'
       and att.attname = 'actividad'
  loop
    execute format('alter table public.fe_emisor drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.fe_emisor
  add constraint fe_emisor_actividad_check
  check (actividad ~ '^([0-9]{6}|[0-9]{4}\.[0-9])$');
