-- ─────────────────────────────────────────────────────────────────────────────
-- Contact merge: atomically re-point every reference from a source contact to a
-- target contact, copy over scalar profile fields the target is missing, then
-- archive the source. Replaces the old route logic that only moved `touches` and
-- left every other table orphaned under the archived record.
--
-- Apply via Supabase MCP / SQL editor (project mvaophllhvvhsotevxbv). Safe to
-- re-run (create or replace). Called from app/api/contacts/merge/route.ts.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.merge_contacts(
  p_source uuid,
  p_target uuid,
  p_uid    uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src   public.contacts%rowtype;
  v_tgt   public.contacts%rowtype;
  v_moved jsonb := '{}'::jsonb;
  v_n     bigint;
  v_pair  text;
  v_tbl   text;
  v_col   text;
  v_fk    record;
  -- Simple FK columns: a plain re-point cannot violate a unique constraint, so
  -- update in place. Listed explicitly (not just discovered from FK metadata) so
  -- coverage does not depend on a formal foreign key existing on each table.
  v_simple text[] := array[
    'touches.contact_id',
    'text_messages.contact_id',
    'text_threads.contact_id',
    'deals.contact_id',
    'deals.referral_source_contact_id',
    'deals.referral_fee_contact_id',
    'deals.co_agent_contact_id',
    'offers.seller_agent_contact_id',
    'interaction_notes.contact_id',
    'voice_notes.contact_id',
    'follow_ups.contact_id',
    'listing_prep_items.vendor_contact_id',
    'unmatched_recipients.created_contact_id'
  ];
  -- Columns handled explicitly below (simple + special). The FK-metadata sweep at
  -- the end skips these and catches any other table that references contacts(id).
  v_handled text[];
begin
  if p_source is null or p_target is null or p_uid is null then
    raise exception 'source, target and uid are required';
  end if;
  if p_source = p_target then
    raise exception 'source and target must be different';
  end if;

  -- Snapshot both rows and enforce ownership inside the transaction.
  select * into v_src from public.contacts where id = p_source and user_id = p_uid;
  if not found then raise exception 'source contact % not found for user', p_source; end if;
  select * into v_tgt from public.contacts where id = p_target and user_id = p_uid;
  if not found then raise exception 'target contact % not found for user', p_target; end if;

  -- ── 1. Simple re-points ────────────────────────────────────────────────────
  foreach v_pair in array v_simple loop
    v_tbl := split_part(v_pair, '.', 1);
    v_col := split_part(v_pair, '.', 2);
    execute format('update public.%I set %I = $1 where %I = $2', v_tbl, v_col, v_col)
      using p_target, p_source;
    get diagnostics v_n = row_count;
    if v_n > 0 then v_moved := v_moved || jsonb_build_object(v_pair, v_n); end if;
  end loop;

  -- ── 2. contact_emails (unique-ish per email): drop source rows already on the
  --       target, move the rest, then preserve the source's primary scalar email.
  delete from public.contact_emails s
   where s.contact_id = p_source
     and exists (
       select 1 from public.contact_emails t
        where t.contact_id = p_target and lower(t.email) = lower(s.email)
     );
  update public.contact_emails set contact_id = p_target where contact_id = p_source;
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('contact_emails.contact_id', v_n); end if;

  if v_src.email is not null and btrim(v_src.email) <> ''
     and not exists (
       select 1 from public.contact_emails e
        where e.contact_id = p_target and lower(e.email) = lower(v_src.email)
     ) then
    insert into public.contact_emails (contact_id, email, source, is_primary)
    values (p_target, v_src.email, 'merge', false);
  end if;

  -- ── 3. opportunity_contacts: unique(deal_id, contact_id). Drop source rows for
  --       deals the target is already on, then move the remainder.
  delete from public.opportunity_contacts s
   where s.contact_id = p_source
     and exists (
       select 1 from public.opportunity_contacts t
        where t.contact_id = p_target and t.deal_id = s.deal_id
     );
  update public.opportunity_contacts set contact_id = p_target where contact_id = p_source;
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('opportunity_contacts.contact_id', v_n); end if;

  -- ── 4. contact_links: unique(contact_id_a, contact_id_b) with a < b and no
  --       self-links. Drop direct source↔target links and any source link whose
  --       partner is already linked to the target, then re-point + re-normalize.
  delete from public.contact_links
   where (contact_id_a = p_source and contact_id_b = p_target)
      or (contact_id_a = p_target and contact_id_b = p_source);

  delete from public.contact_links cl
   where (cl.contact_id_a = p_source or cl.contact_id_b = p_source)
     and exists (
       select 1 from public.contact_links ex
        where ex.id <> cl.id
          and (
            (ex.contact_id_a = p_target and ex.contact_id_b =
               case when cl.contact_id_a = p_source then cl.contact_id_b else cl.contact_id_a end)
            or
            (ex.contact_id_b = p_target and ex.contact_id_a =
               case when cl.contact_id_a = p_source then cl.contact_id_b else cl.contact_id_a end)
          )
     );

  update public.contact_links cl
     set contact_id_a = least(p_target, m.other_id),
         contact_id_b = greatest(p_target, m.other_id)
    from (
      select id,
             case when contact_id_a = p_source then contact_id_b else contact_id_a end as other_id
        from public.contact_links
       where contact_id_a = p_source or contact_id_b = p_source
    ) m
   where cl.id = m.id;
  get diagnostics v_n = row_count;
  if v_n > 0 then v_moved := v_moved || jsonb_build_object('contact_links.remapped', v_n); end if;

  -- ── 5. Safety net: re-point any other FK column that references contacts(id)
  --       and was not handled above (covers tables added after this migration).
  v_handled := v_simple || array[
    'contact_emails.contact_id',
    'opportunity_contacts.contact_id',
    'contact_links.contact_id_a',
    'contact_links.contact_id_b'
  ];
  for v_fk in
    select cl.relname as tbl, att.attname as col
      from pg_constraint c
      join pg_class cl       on cl.oid = c.conrelid
      join pg_namespace n    on n.oid = cl.relnamespace
      join pg_attribute att  on att.attrelid = c.conrelid and att.attnum = c.conkey[1]
     where c.contype = 'f'
       and c.confrelid = 'public.contacts'::regclass
       and array_length(c.conkey, 1) = 1
       and n.nspname = 'public'
  loop
    if (v_fk.tbl || '.' || v_fk.col) = any(v_handled) then
      continue;
    end if;
    execute format('update public.%I set %I = $1 where %I = $2', v_fk.tbl, v_fk.col, v_fk.col)
      using p_target, p_source;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      v_moved := v_moved || jsonb_build_object(v_fk.tbl || '.' || v_fk.col, v_n);
    end if;
  end loop;

  -- ── 6. Archive the source. Clear its email/phone first so copying them onto the
  --       target below cannot trip a unique index while both rows still hold them.
  update public.contacts
     set archived = true, email = null, phone = null, updated_at = now()
   where id = p_source;

  -- ── 7. Fill the target's empty scalar fields from the source (target wins when
  --       it already has a value). Notes are appended rather than dropped.
  update public.contacts t
     set email               = coalesce(t.email, v_src.email),
         phone               = coalesce(t.phone, v_src.phone),
         company             = coalesce(t.company, v_src.company),
         profession          = coalesce(t.profession, v_src.profession),
         profession_category = coalesce(t.profession_category, v_src.profession_category),
         profession_source   = coalesce(t.profession_source, v_src.profession_source),
         birthday            = coalesce(t.birthday, v_src.birthday),
         address_primary     = coalesce(t.address_primary, v_src.address_primary),
         home_address        = coalesce(t.home_address, v_src.home_address),
         linkedin_connected_at = coalesce(t.linkedin_connected_at, v_src.linkedin_connected_at),
         notes = case
                   when v_src.notes is null or btrim(v_src.notes) = '' then t.notes
                   when t.notes is null or btrim(t.notes) = '' then v_src.notes
                   when position(v_src.notes in t.notes) > 0 then t.notes
                   else t.notes || E'\n\n' || v_src.notes
                 end,
         updated_at = now()
   where t.id = p_target;

  return jsonb_build_object(
    'ok',          true,
    'source_id',   p_source,
    'target_id',   p_target,
    'source_name', v_src.display_name,
    'target_name', v_tgt.display_name,
    'moved',       v_moved
  );
end
$$;
