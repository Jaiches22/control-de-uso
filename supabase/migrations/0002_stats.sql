-- Estadísticas agregadas en el servidor (la tabla usage puede tener miles de filas al año).
-- p_bucket: 'day' | 'week' | 'month' | 'year'. p_count: cuántos periodos hacia atrás, incluido el actual.
-- Con p_kind y p_value se obtiene la evolución de una sola web o app; sin ellos, el total.
create function public.get_stats(
  p_bucket text, p_count integer, p_kind text default null, p_value text default null
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  u uuid := public._require_user();
  d date := public.today_madrid();
  n integer := least(greatest(coalesce(p_count, 14), 1), 400);
  step interval;
  last_start timestamp;
  first_start date;
begin
  if p_bucket is null or p_bucket not in ('day', 'week', 'month', 'year') then
    raise exception 'invalid_bucket';
  end if;
  step := ('1 ' || p_bucket)::interval;
  last_start := date_trunc(p_bucket, d::timestamp);
  first_start := (last_start - (n - 1) * step)::date;

  return jsonb_build_object(
    'bucket', p_bucket,
    'from', first_start,
    'to', d,
    'series', (
      select coalesce(jsonb_agg(jsonb_build_object('start', g::date, 'seconds', coalesce(s.seconds, 0)) order by g), '[]'::jsonb)
        from generate_series(first_start::timestamp, last_start, step) as g
        left join (
          select date_trunc(p_bucket, us.day::timestamp) as b, sum(us.seconds)::bigint as seconds
            from public.usage us
           where us.user_id = u and us.day >= first_start
             and case when p_kind is null then us.kind <> 'special'
                      else us.kind = p_kind and us.value = p_value end
           group by 1
        ) s on s.b = g),
    'top', (
      select coalesce(jsonb_agg(jsonb_build_object('kind', t.kind, 'value', t.value, 'seconds', t.seconds) order by t.seconds desc), '[]'::jsonb)
        from (
          select us.kind, us.value, sum(us.seconds)::bigint as seconds
            from public.usage us
           where us.user_id = u and us.day >= first_start
           group by us.kind, us.value
           order by 3 desc
           limit 40
        ) t)
  );
end
$$;

revoke all on function public.get_stats(text, integer, text, text) from public, anon, authenticated;
grant execute on function public.get_stats(text, integer, text, text) to authenticated;
