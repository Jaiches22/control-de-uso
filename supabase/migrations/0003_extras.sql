-- Fase 4: +5 minutos, modo foco, sugerencias de bajar límites y exportación a CSV.

-- ---------------------------------------------------------------- tablas y columnas

alter table public.limits
  add column extra_from date,                 -- desde qué día vale el +5 (null = ya)
  add column suggestion_snoozed_until date;   -- no sugerir bajar este límite hasta ese día

-- El +5: como mucho una fila por usuario y día, sea cual sea el límite o el dispositivo.
create table public.extra_grants (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  limit_id uuid not null references public.limits (id) on delete cascade,
  device text not null,
  seconds integer not null default 300,
  created_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- Modo foco: como mucho una sesión activa por usuario.
create table public.focus_sessions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  limit_ids uuid[] not null,
  ends_at timestamptz not null,
  started_at timestamptz not null default now()
);

alter table public.extra_grants enable row level security;
alter table public.focus_sessions enable row level security;
create policy own_select on public.extra_grants for select to authenticated using (user_id = (select auth.uid()));
create policy own_select on public.focus_sessions for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.extra_grants, public.focus_sessions from anon, authenticated;
grant select on public.extra_grants, public.focus_sessions to authenticated;

-- ---------------------------------------------------------------- estado

create or replace function public.get_state() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  u uuid := public._require_user();
  d date;
  extra_used boolean;
begin
  perform public._apply_pending(u);
  d := public.today_madrid();
  extra_used := exists (select 1 from public.extra_grants g where g.user_id = u and g.day = d);
  return jsonb_build_object(
    'day', d,
    'server_time', now(),
    'resets_at', ((d + 1)::timestamp at time zone 'Europe/Madrid'),
    'extra_used_today', extra_used,
    'focus', (
      select jsonb_build_object('ends_at', f.ends_at, 'limit_ids', to_jsonb(f.limit_ids))
        from public.focus_sessions f
       where f.user_id = u and f.ends_at > now()),
    'limits', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id,
               'name', l.name,
               'daily_seconds', l.daily_seconds,
               'used_seconds', coalesce(lu.seconds, 0),
               'extra_seconds', coalesce(g.seconds, 0),
               'remaining_seconds', greatest(l.daily_seconds + coalesce(g.seconds, 0) - coalesce(lu.seconds, 0), 0),
               'allow_extra', l.allow_extra,
               'extra_from', l.extra_from,
               'extra_available', l.allow_extra and (l.extra_from is null or l.extra_from <= d) and not extra_used,
               'pending_daily_seconds', l.pending_daily_seconds,
               'pending_delete', l.pending_delete,
               'pending_effective', l.pending_effective,
               'suggested_daily_seconds', public._suggested_seconds(l.id, l.daily_seconds, l.created_at,
                    l.pending_daily_seconds is not null or l.pending_delete, l.suggestion_snoozed_until, d),
               'targets', coalesce((
                 select jsonb_agg(jsonb_build_object('kind', t.kind, 'value', t.value, 'remove_on', t.remove_on)
                                  order by t.kind, t.value)
                   from public.limit_targets t
                  where t.limit_id = l.id), '[]'::jsonb)
             ) order by l.created_at, l.id)
        from public.limits l
        left join public.limit_usage lu on lu.limit_id = l.id and lu.day = d
        left join public.extra_grants g on g.user_id = u and g.day = d and g.limit_id = l.id
       where l.user_id = u), '[]'::jsonb)
  );
end
$$;

-- Si la media de los últimos 14 días completos queda por debajo del 70 % del límite, propone uno nuevo:
-- la media más un 15 % de margen, redondeada al minuto de arriba. Solo para límites con 14 días de vida.
create function public._suggested_seconds(
  p_limit uuid, p_daily integer, p_created timestamptz, p_has_pending boolean, p_snoozed date, p_today date
) returns integer
language plpgsql stable security definer set search_path = ''
as $$
declare
  avg14 numeric;
  suggestion integer;
begin
  if p_has_pending or p_daily < 120 or p_created > now() - interval '14 days'
     or (p_snoozed is not null and p_snoozed > p_today) then
    return null;
  end if;
  select coalesce(sum(least(lu.seconds, p_daily)), 0) / 14.0 into avg14
    from public.limit_usage lu
   where lu.limit_id = p_limit and lu.day >= p_today - 14 and lu.day < p_today;
  if avg14 >= 0.7 * p_daily then
    return null;
  end if;
  suggestion := greatest(60, (ceil(avg14 * 1.15 / 60.0) * 60)::integer);
  return case when suggestion < p_daily then suggestion end;
end
$$;

-- ---------------------------------------------------------------- configuración (regla del +5)

create or replace function public.upsert_limit(
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

    -- Activar el +5 afloja el límite: entra en vigor mañana. Desactivarlo es inmediato.
    update public.limits
       set name = btrim(p_name),
           allow_extra = coalesce(p_allow_extra, false),
           extra_from = case
             when not coalesce(p_allow_extra, false) then null
             when cur.allow_extra then extra_from
             when grace then null
             else d + 1 end,
           updated_at = now()
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

-- ---------------------------------------------------------------- +5 minutos

-- Concede 5 minutos extra a un límite. Una vez al día en total entre todos los límites y dispositivos.
create function public.grant_extra(p_limit_id uuid, p_device text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  u uuid := public._require_user();
  d date;
  lim public.limits%rowtype;
begin
  perform public._apply_pending(u);
  d := public.today_madrid();
  select * into lim from public.limits where id = p_limit_id and user_id = u;
  if not found then
    raise exception 'limit_not_found';
  end if;
  if not lim.allow_extra or (lim.extra_from is not null and lim.extra_from > d) then
    raise exception 'extra_not_allowed';
  end if;
  if exists (select 1 from public.focus_sessions f
              where f.user_id = u and f.ends_at > now() and p_limit_id = any (f.limit_ids)) then
    raise exception 'extra_not_allowed';
  end if;
  begin
    insert into public.extra_grants (user_id, day, limit_id, device)
    values (u, d, p_limit_id, coalesce(nullif(btrim(p_device), ''), '?'));
  exception when unique_violation then
    raise exception 'extra_already_used';
  end;
  return public.get_state();
end
$$;

-- ---------------------------------------------------------------- sugerencias

-- «No, gracias»: no volver a sugerir bajar este límite durante 14 días.
create function public.snooze_suggestion(p_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  u uuid := public._require_user();
begin
  update public.limits set suggestion_snoozed_until = public.today_madrid() + 14 where id = p_id and user_id = u;
  if not found then
    raise exception 'limit_not_found';
  end if;
  return public.get_state();
end
$$;

-- ---------------------------------------------------------------- modo foco

-- Bloquea los límites elegidos durante p_minutes. No se puede cancelar ni acortar; sí ampliar.
create function public.start_focus(p_limit_ids uuid[], p_minutes integer) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  u uuid := public._require_user();
  ids uuid[];
  until timestamptz;
begin
  if p_minutes is null or p_minutes not between 1 and 720 then
    raise exception 'invalid_minutes';
  end if;
  select array_agg(l.id) into ids from public.limits l where l.user_id = u and l.id = any (coalesce(p_limit_ids, '{}'));
  if ids is null then
    raise exception 'focus_without_limits';
  end if;
  until := now() + make_interval(mins => p_minutes);
  insert into public.focus_sessions as f (user_id, limit_ids, ends_at)
  values (u, ids, until)
  on conflict (user_id) do update
     set limit_ids = case when f.ends_at > now()
                          then (select array_agg(distinct x) from unnest(f.limit_ids || excluded.limit_ids) x)
                          else excluded.limit_ids end,
         ends_at = case when f.ends_at > now() then greatest(f.ends_at, excluded.ends_at) else excluded.ends_at end,
         started_at = case when f.ends_at > now() then f.started_at else now() end;
  return public.get_state();
end
$$;

-- ---------------------------------------------------------------- exportar

-- Todo el uso registrado, como texto CSV (día, tipo, web o app, dispositivo, segundos).
create function public.export_usage_csv() returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  u uuid := public._require_user();
begin
  return 'dia,tipo,nombre,dispositivo,segundos' || E'\n' || coalesce((
    select string_agg(
             us.day || ',' || us.kind || ',"' || replace(us.value, '"', '""') || '","' || replace(us.device, '"', '""') || '",' || us.seconds,
             E'\n' order by us.day, us.kind, us.value, us.device)
      from public.usage us
     where us.user_id = u), '');
end
$$;

-- ---------------------------------------------------------------- permisos y Realtime

revoke all on function
  public._suggested_seconds(uuid, integer, timestamptz, boolean, date, date),
  public.grant_extra(uuid, text),
  public.snooze_suggestion(uuid),
  public.start_focus(uuid[], integer),
  public.export_usage_csv()
from public, anon, authenticated;

grant execute on function
  public.grant_extra(uuid, text),
  public.snooze_suggestion(uuid),
  public.start_focus(uuid[], integer),
  public.export_usage_csv()
to authenticated;

alter publication supabase_realtime add table public.extra_grants, public.focus_sessions;
