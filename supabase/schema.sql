-- Walker database schema for Supabase.
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- It is safe to run again (it drops and recreates the policies and functions).

-- ============================================================ profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "Signed-in users can look up profiles" on public.profiles;
create policy "Signed-in users can look up profiles" on public.profiles
  for select to authenticated using (true);
drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Create the profile automatically when someone signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (new.id, lower(new.raw_user_meta_data ->> 'username'));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Lets the sign-up screen check a username before creating the account.
create or replace function public.username_available(name text)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.profiles where username = lower(name));
$$;
grant execute on function public.username_available(text) to anon, authenticated;

-- ============================================================ walks (history backup & sync)
create table if not exists public.walks (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  data jsonb not null,
  updated_at bigint not null,
  deleted boolean not null default false,
  primary key (user_id, id)
);
alter table public.walks enable row level security;

drop policy if exists "Users manage their own walks" on public.walks;
create policy "Users manage their own walks" on public.walks
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================ friendships
create table if not exists public.friendships (
  requester uuid not null references public.profiles on delete cascade,
  addressee uuid not null references public.profiles on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  primary key (requester, addressee),
  check (requester <> addressee)
);
alter table public.friendships enable row level security;

drop policy if exists "See your own friendships" on public.friendships;
create policy "See your own friendships" on public.friendships
  for select to authenticated using (auth.uid() in (requester, addressee));
drop policy if exists "Send friend requests" on public.friendships;
create policy "Send friend requests" on public.friendships
  for insert to authenticated with check (requester = auth.uid() and status = 'pending');
drop policy if exists "Accept requests sent to you" on public.friendships;
create policy "Accept requests sent to you" on public.friendships
  for update to authenticated using (addressee = auth.uid()) with check (addressee = auth.uid());
drop policy if exists "Remove friendships" on public.friendships;
create policy "Remove friendships" on public.friendships
  for delete to authenticated using (auth.uid() in (requester, addressee));

create or replace function public.are_friends(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.friendships
    where status = 'accepted'
      and ((requester = a and addressee = b) or (requester = b and addressee = a))
  );
$$;

-- ============================================================ shared routes
create table if not exists public.routes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  polyline text not null,
  distance double precision not null,
  share_with_friends boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists routes_owner_idx on public.routes (owner_id, created_at desc);
alter table public.routes enable row level security;

drop policy if exists "See your routes and friends' shared routes" on public.routes;
create policy "See your routes and friends' shared routes" on public.routes
  for select to authenticated
  using (owner_id = auth.uid() or (share_with_friends and public.are_friends(owner_id, auth.uid())));
drop policy if exists "Manage your own routes" on public.routes;
create policy "Manage your own routes" on public.routes
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Anyone holding a share link (which contains the route's random id) can open
-- that one route, even without an account. Routes can't be listed this way.
create or replace function public.get_shared_route(route_id uuid)
returns table (id uuid, name text, polyline text, distance double precision,
               created_at timestamptz, owner_id uuid, owner_username text)
language sql stable security definer set search_path = public as $$
  select r.id, r.name, r.polyline, r.distance, r.created_at, r.owner_id, p.username
  from public.routes r join public.profiles p on p.id = r.owner_id
  where r.id = route_id;
$$;
grant execute on function public.get_shared_route(uuid) to anon, authenticated;
