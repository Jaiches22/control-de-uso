-- Panel nuevo: estadísticas por rango de fechas y por dispositivo, y nombres e iconos de las apps.

-- ---------------------------------------------------------------- nombres e iconos

-- Cada dispositivo sube el nombre y el icono de las apps que conoce (y la extensión, los logos de las webs),
-- para que se vean en todos. Los logos de las webs los saca el navegador de su propia caché: no se pide nada a terceros.
create table public.app_meta (
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('domain', 'win_process', 'android_package')),
  value text not null check (length(value) between 1 and 200),
  label text check (length(label) <= 80),
  icon text check (icon is null or (icon like 'data:image/png;base64,%' and length(icon) <= 40000)),
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, value)
);
alter table public.app_meta enable row level security;
create policy own_select on public.app_meta for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.app_meta from anon, authenticated;
grant select on public.app_meta to authenticated;

-- p_items: [{ "kind", "value", "label", "icon" }]. Lo que no cumpla el formato se ignora.
create function public.put_app_meta(p_items jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  u uuid := public._require_user();
begin
  insert into public.app_meta (user_id, kind, value, label, icon)
  select distinct on (x.kind, x.value) u, x.kind, x.value, left(nullif(btrim(x.label), ''), 80), x.icon
    from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(kind text, value text, label text, icon text)
   where x.kind in ('domain', 'win_process', 'android_package')
     and length(x.value) between 1 and 200
     and (x.icon is null or (x.icon like 'data:image/png;base64,%' and length(x.icon) <= 40000))
  on conflict (user_id, kind, value) do update
     set label = coalesce(excluded.label, public.app_meta.label),
         icon = coalesce(excluded.icon, public.app_meta.icon),
         updated_at = now();
end
$$;

-- p_keys: [{ "kind", "value" }]. Devuelve { "kind:value": { "label", "icon" } } de los que haya.
create function public.get_app_meta(p_keys jsonb) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  u uuid := public._require_user();
begin
  return coalesce((
    select jsonb_object_agg(m.kind || ':' || m.value, jsonb_build_object('label', m.label, 'icon', m.icon))
      from public.app_meta m
      join jsonb_to_recordset(coalesce(p_keys, '[]'::jsonb)) as k(kind text, value text)
        on k.kind = m.kind and k.value = m.value
     where m.user_id = u), '{}'::jsonb);
end
$$;

-- ---------------------------------------------------------------- estadísticas por rango

-- Uso entre dos fechas (incluidas), troceado por día, semana, mes o año (p_bucket null = automático)
-- y desglosado por dispositivo. p_device filtra por un dispositivo; p_kind y p_value, por una web o app.
create function public.get_stats_range(
  p_from date, p_to date, p_bucket text default null, p_device text default null,
  p_kind text default null, p_value text default null
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  u uuid := public._require_user();
  d date := public.today_madrid();
  d_to date := least(coalesce(p_to, d), d);
  d_from date := least(coalesce(p_from, d_to - 13), d_to);
  n_days integer;
  bucket text := p_bucket;
  step interval;
begin
  if d_from < d_to - 3700 then
    d_from := d_to - 3700;
  end if;
  n_days := d_to - d_from + 1;
  if bucket is null then
    bucket := case when n_days <= 31 then 'day' when n_days <= 182 then 'week' when n_days <= 1100 then 'month' else 'year' end;
  end if;
  if bucket not in ('day', 'week', 'month', 'year') then
    raise exception 'invalid_bucket';
  end if;
  step := ('1 ' || bucket)::interval;

  return jsonb_build_object(
    'bucket', bucket,
    'from', d_from,
    'to', d_to,
    'days', n_days,
    'today', d,
    -- todos los dispositivos que han registrado algo alguna vez, para que su color no cambie al filtrar
    'devices', coalesce((select jsonb_agg(x.device order by x.device)
                           from (select distinct us.device from public.usage us where us.user_id = u) x), '[]'::jsonb),
    'total', coalesce((
      select sum(us.seconds) from public.usage us
       where us.user_id = u and us.day between d_from and d_to
         and (p_device is null or us.device = p_device)
         and case when p_kind is null then us.kind <> 'special' else us.kind = p_kind and us.value = p_value end), 0),
    'previous_total', coalesce((
      select sum(us.seconds) from public.usage us
       where us.user_id = u and us.day between d_from - n_days and d_from - 1
         and (p_device is null or us.device = p_device)
         and case when p_kind is null then us.kind <> 'special' else us.kind = p_kind and us.value = p_value end), 0),
    'series', (
      select coalesce(jsonb_agg(jsonb_build_object('start', g::date, 'devices', coalesce(s.devices, '{}'::jsonb)) order by g), '[]'::jsonb)
        from generate_series(date_trunc(bucket, d_from::timestamp), date_trunc(bucket, d_to::timestamp), step) as g
        left join (
          select b, jsonb_object_agg(device, seconds) as devices
            from (
              select date_trunc(bucket, us.day::timestamp) as b, us.device, sum(us.seconds)::bigint as seconds
                from public.usage us
               where us.user_id = u and us.day between d_from and d_to
                 and (p_device is null or us.device = p_device)
                 and case when p_kind is null then us.kind <> 'special' else us.kind = p_kind and us.value = p_value end
               group by 1, 2
            ) per_device
           group by b
        ) s on s.b = g),
    'top', (
      select coalesce(jsonb_agg(jsonb_build_object('kind', t.kind, 'value', t.value, 'seconds', t.seconds, 'devices', t.devices)
                                order by t.seconds desc), '[]'::jsonb)
        from (
          select kind, value, sum(seconds)::bigint as seconds, jsonb_object_agg(device, seconds) as devices
            from (
              select us.kind, us.value, us.device, sum(us.seconds)::bigint as seconds
                from public.usage us
               where us.user_id = u and us.day between d_from and d_to
                 and (p_device is null or us.device = p_device)
               group by 1, 2, 3
            ) per_device
           group by kind, value
           order by 3 desc
           limit 40
        ) t)
  );
end
$$;

-- ---------------------------------------------------------------- estado: añade in_grace y el nombre de cada app

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
               'in_grace', l.created_at > now() - interval '10 minutes',
               'extra_from', l.extra_from,
               'extra_available', l.allow_extra and (l.extra_from is null or l.extra_from <= d) and not extra_used,
               'pending_daily_seconds', l.pending_daily_seconds,
               'pending_delete', l.pending_delete,
               'pending_effective', l.pending_effective,
               'suggested_daily_seconds', public._suggested_seconds(l.id, l.daily_seconds, l.created_at,
                    l.pending_daily_seconds is not null or l.pending_delete, l.suggestion_snoozed_until, d),
               'targets', coalesce((
                 select jsonb_agg(jsonb_build_object('kind', t.kind, 'value', t.value, 'remove_on', t.remove_on,
                                                     'label', (select m.label from public.app_meta m
                                                                where m.user_id = u and m.kind = t.kind and m.value = t.value))
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

-- ---------------------------------------------------------------- permisos

revoke all on function
  public.put_app_meta(jsonb),
  public.get_app_meta(jsonb),
  public.get_stats_range(date, date, text, text, text, text)
from public, anon, authenticated;

grant execute on function
  public.put_app_meta(jsonb),
  public.get_app_meta(jsonb),
  public.get_stats_range(date, date, text, text, text, text)
to authenticated;
