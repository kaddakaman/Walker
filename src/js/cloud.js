// Accounts, friends and online routes, backed by Supabase.
// Database tables and security rules: supabase/schema.sql

import { createClient } from '@supabase/supabase-js';
import { config, cloudEnabled } from './config.js';
import { encodePolyline, decodePolyline } from './geo.js';
import { compactPoints } from './share.js';

export { cloudEnabled };

export const supabase = cloudEnabled
  ? createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    })
  : null;

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
export const normaliseUsername = (u) => String(u || '').trim().replace(/^@/, '').toLowerCase();

function fail(error, fallback) {
  if (!error) return;
  const msg = error.message || fallback;
  if (/Failed to fetch|NetworkError|network/i.test(msg)) throw new Error('No internet connection.');
  throw new Error(msg);
}

function requireCloud() {
  if (!supabase) throw new Error('Accounts are not set up for this app yet.');
}

// ---------------------------------------------------------------- auth

export async function currentUser() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user ?? null;
}

export function onAuthChange(cb) {
  if (!supabase) return;
  supabase.auth.onAuthStateChange((_event, session) => cb(session?.user ?? null));
}

export async function signUp(email, password, username) {
  requireCloud();
  username = normaliseUsername(username);
  if (!USERNAME_RE.test(username)) {
    throw new Error('Usernames are 3–20 characters: lowercase letters, numbers and _ only.');
  }
  if (password.length < 6) throw new Error('Password must be at least 6 characters.');
  const { data: free, error: e1 } = await supabase.rpc('username_available', { name: username });
  fail(e1, 'Could not check username.');
  if (!free) throw new Error(`@${username} is taken. Try another username.`);
  const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { username } } });
  fail(error, 'Could not create account.');
  return { needsConfirmation: !data.session };
}

export async function signIn(email, password) {
  requireCloud();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error && /Email not confirmed/i.test(error.message)) {
    throw new Error('Please confirm your email first (check your inbox), then sign in.');
  }
  if (error && /Invalid login/i.test(error.message)) throw new Error('Wrong email or password.');
  fail(error, 'Could not sign in.');
}

export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}

export async function myProfile() {
  const user = await currentUser();
  if (!user) return null;
  const { data, error } = await supabase.from('profiles').select('id, username').eq('id', user.id).maybeSingle();
  fail(error, 'Could not load profile.');
  return { ...data, email: user.email, id: user.id };
}

// ---------------------------------------------------------------- friends

/** Returns { friends, incoming, outgoing }, each a list of { id, username }. */
export async function listFriends() {
  requireCloud();
  const me = (await currentUser())?.id;
  const { data, error } = await supabase
    .from('friendships')
    .select(
      'requester, addressee, status, req:profiles!friendships_requester_fkey(username), add:profiles!friendships_addressee_fkey(username)'
    );
  fail(error, 'Could not load friends.');
  const out = { friends: [], incoming: [], outgoing: [] };
  for (const f of data) {
    const mine = f.requester === me;
    const other = mine ? { id: f.addressee, username: f.add?.username } : { id: f.requester, username: f.req?.username };
    if (f.status === 'accepted') out.friends.push(other);
    else (mine ? out.outgoing : out.incoming).push(other);
  }
  const byName = (a, b) => (a.username || '').localeCompare(b.username || '');
  Object.values(out).forEach((l) => l.sort(byName));
  return out;
}

/** Send a friend request (or accept theirs if they already asked). */
export async function addFriend(username) {
  requireCloud();
  const me = (await currentUser())?.id;
  username = normaliseUsername(username);
  const { data: profile, error } = await supabase.from('profiles').select('id, username').eq('username', username).maybeSingle();
  fail(error, 'Could not find user.');
  if (!profile) throw new Error(`No one is called @${username}.`);
  if (profile.id === me) throw new Error("That's you!");

  const { friends, incoming, outgoing } = await listFriends();
  if (friends.some((f) => f.id === profile.id)) return `You're already friends with @${username}.`;
  if (outgoing.some((f) => f.id === profile.id)) return `Request to @${username} is already waiting.`;
  if (incoming.some((f) => f.id === profile.id)) {
    await acceptFriend(profile.id);
    return `You're now friends with @${username}.`;
  }
  const { error: e2 } = await supabase.from('friendships').insert({ requester: me, addressee: profile.id });
  fail(e2, 'Could not send request.');
  return `Friend request sent to @${username}.`;
}

export async function acceptFriend(otherId) {
  const me = (await currentUser())?.id;
  const { error } = await supabase
    .from('friendships')
    .update({ status: 'accepted' })
    .eq('requester', otherId)
    .eq('addressee', me);
  fail(error, 'Could not accept request.');
}

/** Remove a friend, decline their request, or cancel ours. */
export async function removeFriend(otherId) {
  const me = (await currentUser())?.id;
  const { error } = await supabase
    .from('friendships')
    .delete()
    .or(`and(requester.eq.${me},addressee.eq.${otherId}),and(requester.eq.${otherId},addressee.eq.${me})`);
  fail(error, 'Could not remove friend.');
}

// ---------------------------------------------------------------- online routes

const rowToRoute = (r) => ({
  id: r.id,
  name: r.name,
  points: decodePolyline(r.polyline),
  distance: r.distance,
  added: Date.parse(r.created_at) || Date.now(),
  owner: r.owner?.username ?? r.owner_username ?? null,
  ownerId: r.owner_id,
});

/**
 * Upload a route so it can be shared. Reuses `existingId` if it still exists.
 * `withFriends` makes it appear in your friends' Routes tab.
 */
export async function publishRoute({ name, points, distance, withFriends, existingId }) {
  requireCloud();
  if (existingId) {
    const patch = withFriends ? { share_with_friends: true, name } : { name };
    const { data, error } = await supabase.from('routes').update(patch).eq('id', existingId).select('id');
    fail(error, 'Could not share route.');
    if (data?.length) return existingId;
  }
  const { data, error } = await supabase
    .from('routes')
    .insert({ name, polyline: encodePolyline(compactPoints(points, 4000)), distance, share_with_friends: Boolean(withFriends) })
    .select('id')
    .single();
  fail(error, 'Could not share route.');
  return data.id;
}

export async function unpublishRoute(id) {
  requireCloud();
  const { error } = await supabase.from('routes').delete().eq('id', id);
  fail(error, 'Could not stop sharing.');
}

/** Routes your friends have shared with you, newest first. */
export async function friendRoutes() {
  requireCloud();
  const me = (await currentUser())?.id;
  const { data, error } = await supabase
    .from('routes')
    .select('id, name, polyline, distance, created_at, owner_id, owner:profiles(username)')
    .neq('owner_id', me)
    .order('created_at', { ascending: false })
    .limit(200);
  fail(error, 'Could not load friends’ routes.');
  return data.map(rowToRoute);
}

/** Fetch a route from a share link (works without signing in). */
export async function fetchSharedRoute(id) {
  requireCloud();
  const { data, error } = await supabase.rpc('get_shared_route', { route_id: id });
  fail(error, 'Could not load shared route.');
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('That route is no longer shared.');
  return rowToRoute(row);
}
