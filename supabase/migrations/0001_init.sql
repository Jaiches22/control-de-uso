-- Control de uso: esquema inicial.
-- Las tablas solo se leen directamente (SELECT con RLS). Toda escritura pasa por funciones RPC,
-- que es donde se aplican el contador atómico y la regla anti-trampa.

-- ---------------------------------------------------------------- tablas

create table public.limits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  daily_seconds integer not null check (daily_seconds between 0 and 86400),
  allow_extra boolean not null default false,
  -- Cambios que aflojan el límite: se aplican cuando llega pending_effective (día de Madrid).
  pending_daily_seconds integer check (pending_daily_seconds between 0 and 86400),
  pending_delete boolean not null default false,
  pending_effective date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.limit_targets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  limit_id uuid not null references public.limits (id) on delete cascade,
  kind text not null check (kind in ('domain', 'win_process', 'android_package', 'special')),
  value text not null check (length(value) between 1 and 200),
  remove_on date,
  unique (user_id, kind, value)
);
create index limit_targets_limit_idx on public.limit_targets (limit_id);

-- Tiempo de uso de todo (tenga límite o no), para las estadísticas.
create table public.usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  kind text not null check (kind in ('domain', 'win_process', 'android_package', 'special')),
  value text not null check (length(value) between 1 and 200),
  device text not null,
  seconds integer not null default 0,
  primary key (user_id, day, kind, value, device)
);

-- Contador diario de cada límite, compartido entre dispositivos.
create table public.limit_usage (
  limit_id uuid not null references public.limits (id) on delete cascade,
  day date not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  seconds integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (limit_id, day)
);

-- ---------------------------------------------------------------- RLS

alter table public.limits enable row level security;
alter table public.limit_targets enable row level security;
alter table public.usage enable row level security;
alter table public.limit_usage enable row level security;

create policy own_select on public.limits for select to authenticated using (user_id = (select auth.uid()));
create policy own_select on public.limit_targets for select to authenticated using (user_id = (select auth.uid()));
create policy own_select on public.usage for select to authenticated using (user_id = (select auth.uid()));
create policy own_select on public.limit_usage for select to authenticated using (user_id = (select auth.uid()));

revoke all on public.limits, public.limit_targets, public.usage, public.limit_usage from anon, authenticated;
grant select on public.limits, public.limit_targets, public.usage, public.limit_usage to authenticated;

-- ---------------------------------------------------------------- funciones internas

create function public.today_madrid() returns date
language sql stable set search_path = ''
as $$ select (now() at time zone 'Europe/Madrid')::date $$;

-- ¿El identificador (kind, value) de una entrada de uso cae dentro del objetivo de un límite?
-- Los dominios incluyen sus subdominios: 'instagram.com' cubre 'www.instagram.com'.
create function public._target_matches(t_kind text, t_value text, e_kind text, e_value text) returns boolean
language sql immutable set search_path = ''
as $$
  select t_kind = e_kind
     and (t_value = e_value
          or (t_kind = 'domain' and right(e_value, length(t_value) + 1) = '.' || t_value))
$$;

-- Aplica los cambios pendientes cuya fecha ya ha llegado.
create function public._apply_pending(p_user uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  d date := public.today_madrid();
begin
  delete from public.limits
   where user_id = p_user and pending_delete and pending_effective <= d;

  update public.limits
     set daily_seconds = pending_daily_seconds,
         pending_daily_seconds = null,
         pending_effective = null,
         updated_at = now()
   where user_id = p_user and pending_daily_seconds is not null and pending_effective <= d;

  delete from public.limit_targets
   where user_id = p_user and remove_on <= d;
end
$$;

create function public._require_user() returns uuid
language plpgsql stable set search_path = ''
as $$
declare
  u uuid := auth.uid();
begin
  if u is null then
    raise exception 'not_authenticated';
  end if;
  return u;
end
$$;

-- ---------------------------------------------------------------- RPC: estado

create function public.get_state() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  u uuid := public._require_user();
  d date;
begin
  perform public._apply_pending(u);
  d := public.today_madrid();
  return jsonb_build_object(
    'day', d,
    'server_time', now(),
    'resets_at', ((d + 1)::timestamp at time zone 'Europe/Madrid'),
    'limits', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id,
               'name', l.name,
               'daily_seconds', l.daily_seconds,
               'used_seconds', coalesce(lu.seconds, 0),
               'remaining_seconds', greatest(l.daily_seconds - coalesce(lu.seconds, 0), 0),
               'allow_extra', l.allow_extra,
               'pending_daily_seconds', l.pending_daily_seconds,
               'pending_delete', l.pending_delete,
               'pending_effective', l.pending_effective,
               'targets', coalesce((
                 select jsonb_agg(jsonb_build_object('kind', t.kind, 'value', t.value, 'remove_on', t.remove_on)
                                  order by t.kind, t.value)
                   from public.limit_targets t
                  where t.limit_id = l.id), '[]'::jsonb)
             ) order by l.created_at, l.id)
        from public.limits l
        left join public.limit_usage lu on lu.limit_id = l.id and lu.day = d
       where l.user_id = u), '[]'::jsonb)
  );
end
$$;

-- ---------------------------------------------------------------- RPC: sumar uso

-- p_entries: [{ "kind", "value", "seconds", "day"?, "also"?: [{ "kind", "value" }] }]
-- "also" son identificadores extra del mismo rato (p. ej. youtube.com + Shorts): cada uno suma en
-- las estadísticas, pero cada límite afectado suma una sola vez.
create function public.add_usage(p_device text, p_entries jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  u uuid := public._require_user();
  d date;
  e record;
  e_day date;
  secs integer;
  keys jsonb;
begin
  if p_device is null or length(btrim(p_device)) not between 1 and 40 then
    raise exception 'invalid_device';
  end if;
  perform public._apply_pending(u);
  d := public.today_madrid();

  for e in
    select x.kind, x.value, x.seconds, x.day, x.also
      from jsonb_to_recordset(coalesce(p_entries, '[]'::jsonb))
           as x(kind text, value text, seconds integer, day date, also jsonb)
  loop
    if e.seconds is null or e.seconds <= 0 then
      continue;
    end if;
    secs := least(e.seconds, 86400);
    e_day := coalesce(e.day, d);
    if e_day > d or e_day < d - 7 then
      e_day := d;
    end if;
    keys := jsonb_build_array(jsonb_build_object('kind', e.kind, 'value', e.value));
    if jsonb_typeof(e.also) = 'array' then
      keys := keys || e.also;
    end if;

    insert into public.usage (user_id, day, kind, value, device, seconds)
    select distinct u, e_day, k.kind, k.value, btrim(p_device), secs
      from jsonb_to_recordset(keys) as k(kind text, value text)
     where k.kind in ('domain', 'win_process', 'android_package', 'special')
       and length(k.value) between 1 and 200
    on conflict (user_id, day, kind, value, device)
    do update set seconds = least(public.usage.seconds + excluded.seconds, 86400);

    insert into public.limit_usage (limit_id, day, user_id, seconds)
    select distinct t.limit_id, e_day, u, secs
      from public.limit_targets t
      join jsonb_to_recordset(keys) as k(kind text, value text)
        on public._target_matches(t.kind, t.value, k.kind, k.value)
     where t.user_id = u
    on conflict (limit_id, day)
    do update set seconds = least(public.limit_usage.seconds + excluded.seconds, 86400),
                  updated_at = now();
  end loop;

  return public.get_state();
end
$$;

-- ---------------------------------------------------------------- RPC: configuración

-- Crea (p_id null) o edita un límite. p_targets: [{ "kind", "value" }] con la lista completa deseada.
-- Regla anti-trampa: lo que endurece (bajar minutos, añadir identificadores) se aplica al momento;
-- lo que afloja (subir minutos, quitar identificadores) entra en vigor mañana (día de Madrid).
-- Excepción: durante los 10 minutos siguientes a crear el límite se puede corregir libremente.
create function public.upsert_limit(
  p_id uuid, p_name text, p_daily_seconds integer, p_allow_extra boolean, p_targets jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  u uuid := public._require_user();
  d date;
  cur public.limits%rowtype;
  v_id uuid;
  grace boolean;
  wanted jsonb;
begin
  perform public._apply_pending(u);
  d := public.today_madrid();
  if p_daily_seconds is null or p_daily_seconds not between 0 and 86400 then
    raise exception 'invalid_daily_seconds';
  end if;
  if jsonb_typeof(coalesce(p_targets, '[]'::jsonb)) <> 'array' then
    raise exception 'invalid_targets';
  end if;

  select coalesce(jsonb_agg(distinct jsonb_build_object('kind', k.kind, 'value', k.value)), '[]'::jsonb)
    into wanted
    from jsonb_to_recordset(coalesce(p_targets, '[]'::jsonb)) as k(kind text, value text)
   where k.kind in ('domain', 'win_process', 'android_package', 'special')
     and length(k.value) between 1 and 200;

  if p_id is null then
    insert into public.limits (user_id, name, daily_seconds, allow_extra)
    values (u, btrim(p_name), p_daily_seconds, coalesce(p_allow_extra, false))
    returning id into v_id;
    grace := true;
  else
    select * into cur from public.limits where id = p_id and user_id = u for update;
    if not found then
      raise exception 'limit_not_found';
    end if;
    v_id := p_id;
    grace := cur.created_at > now() - interval '10 minutes';

    update public.limits
       set name = btrim(p_name), allow_extra = coalesce(p_allow_extra, false), updated_at = now()
     where id = v_id;

    if p_daily_seconds <= cur.daily_seconds or grace then
      update public.limits
         set daily_seconds = p_daily_seconds,
             pending_daily_seconds = null,
             pending_effective = case when pending_delete then pending_effective end
       where id = v_id;
    else
      update public.limits
         set pending_daily_seconds = p_daily_seconds, pending_effective = d + 1
       where id = v_id;
    end if;
  end if;

  if exists (select 1 from public.limit_targets t join jsonb_to_recordset(wanted) as w(kind text, value text) on w.kind = t.kind and w.value = t.value
              where t.user_id = u and t.limit_id <> v_id) then
    raise exception 'target_in_use';
  end if;

  -- Identificadores que sobran: se quitan mañana (o ya, si el límite es recién creado).
  if grace then
    delete from public.limit_targets t
     where t.limit_id = v_id
       and not exists (select 1 from jsonb_to_recordset(wanted) as w(kind text, value text) where w.kind = t.kind and w.value = t.value);
  else
    update public.limit_targets t
       set remove_on = d + 1
     where t.limit_id = v_id and t.remove_on is null
       and not exists (select 1 from jsonb_to_recordset(wanted) as w(kind text, value text) where w.kind = t.kind and w.value = t.value);
  end if;

  -- Identificadores deseados: se añaden (o se rescatan si estaban pendientes de quitarse).
  insert into public.limit_targets (user_id, limit_id, kind, value)
  select u, v_id, w.kind, w.value from jsonb_to_recordset(wanted) as w(kind text, value text)
  on conflict (user_id, kind, value) do update set remove_on = null;

  -- Un límite nuevo arranca contando lo ya usado hoy.
  if p_id is null then
    insert into public.limit_usage (limit_id, day, user_id, seconds)
    select v_id, d, u, least(coalesce(sum(us.seconds), 0), 86400)::integer
      from public.usage us
     where us.user_id = u and us.day = d
       and exists (select 1 from jsonb_to_recordset(wanted) as w(kind text, value text) where public._target_matches(w.kind, w.value, us.kind, us.value))
    on conflict (limit_id, day) do nothing;
  end if;

  return public.get_state();
end
$$;

-- Borra un límite: mañana (o ya, si es recién creado).
create function public.delete_limit(p_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  u uuid := public._require_user();
  cur public.limits%rowtype;
begin
  perform public._apply_pending(u);
  select * into cur from public.limits where id = p_id and user_id = u for update;
  if not found then
    raise exception 'limit_not_found';
  end if;
  if cur.created_at > now() - interval '10 minutes' then
    delete from public.limits where id = p_id;
  else
    update public.limits
       set pending_delete = true, pending_effective = public.today_madrid() + 1, updated_at = now()
     where id = p_id;
  end if;
  return public.get_state();
end
$$;

-- Cancela los cambios pendientes de un límite (cancelar siempre endurece, así que es inmediato).
create function public.cancel_pending(p_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  u uuid := public._require_user();
begin
  update public.limits
     set pending_daily_seconds = null, pending_delete = false, pending_effective = null, updated_at = now()
   where id = p_id and user_id = u;
  if not found then
    raise exception 'limit_not_found';
  end if;
  update public.limit_targets set remove_on = null where limit_id = p_id and user_id = u;
  return public.get_state();
end
$$;

-- ---------------------------------------------------------------- permisos de las funciones

revoke all on function
  public.today_madrid(),
  public._target_matches(text, text, text, text),
  public._apply_pending(uuid),
  public._require_user(),
  public.get_state(),
  public.add_usage(text, jsonb),
  public.upsert_limit(uuid, text, integer, boolean, jsonb),
  public.delete_limit(uuid),
  public.cancel_pending(uuid)
from public, anon, authenticated;

grant execute on function
  public.get_state(),
  public.add_usage(text, jsonb),
  public.upsert_limit(uuid, text, integer, boolean, jsonb),
  public.delete_limit(uuid),
  public.cancel_pending(uuid)
to authenticated;

-- ---------------------------------------------------------------- Realtime

alter publication supabase_realtime add table public.limits, public.limit_targets, public.limit_usage;
