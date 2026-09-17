import { createClient } from '@supabase/supabase-js';

// Configuration keys in localStorage
const STORAGE_KEYS = {
  URL: 'locker_pwa_supabase_url',
  KEY: 'locker_pwa_supabase_key',
  LOCKER_ID: 'locker_pwa_locker_id'
};

let supabaseClient = null;

/**
 * Retrieve active Supabase credentials from localStorage or Vite environment
 */
export function getSupabaseConfig() {
  const localUrl = localStorage.getItem(STORAGE_KEYS.URL);
  const localKey = localStorage.getItem(STORAGE_KEYS.KEY);
  const localLockerId = localStorage.getItem(STORAGE_KEYS.LOCKER_ID);

  const envUrl = import.meta.env.VITE_SUPABASE_URL;
  const envKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const envLockerId = import.meta.env.VITE_DEFAULT_LOCKER_ID || 'LOCKER-1';

  return {
    url: (localUrl || envUrl || '').trim(),
    key: (localKey || envKey || '').trim(),
    lockerId: (localLockerId || envLockerId || 'LOCKER-1').trim()
  };
}

/**
 * Persist new credentials into localStorage and reset client instance
 */
export function saveSupabaseConfig({ url, key, lockerId }) {
  if (url) localStorage.setItem(STORAGE_KEYS.URL, url.trim());
  if (key) localStorage.setItem(STORAGE_KEYS.KEY, key.trim());
  if (lockerId) localStorage.setItem(STORAGE_KEYS.LOCKER_ID, lockerId.trim());

  supabaseClient = null; // force re-creation
  return initSupabaseClient();
}

/**
 * Initialize or get existing Supabase client instance
 */
export function initSupabaseClient() {
  const { url, key } = getSupabaseConfig();
  if (!url || !key) {
    supabaseClient = null;
    return null;
  }

  try {
    supabaseClient = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true
      }
    });
    return supabaseClient;
  } catch (err) {
    console.error('Error creating Supabase client:', err);
    supabaseClient = null;
    return null;
  }
}

/**
 * Test Supabase connectivity and verify table existence / RLS access
 */
export async function testSupabaseConnection() {
  const client = initSupabaseClient();
  if (!client) {
    return { ok: false, message: 'Please provide both Supabase URL and Anon Key.' };
  }

  try {
    const { data, error } = await client
      .from('locker_commands')
      .select('id')
      .limit(1);

    if (error) {
      return {
        ok: false,
        message: `Supabase Error (${error.code || 'RLS'}): ${error.message}`
      };
    }

    return { ok: true, message: 'Connected to public.locker_commands successfully!' };
  } catch (err) {
    return { ok: false, message: `Connection failed: ${err.message}` };
  }
}

/**
 * Fetch recent commands from public.locker_commands
 */
export async function fetchRecentCommands(limit = 8) {
  const client = initSupabaseClient();
  if (!client) return { data: null, error: new Error('Supabase not configured') };

  try {
    const { data, error } = await client
      .from('locker_commands')
      .select('*')
      .order('id', { ascending: false })
      .limit(limit);

    return { data, error };
  } catch (err) {
    return { data: null, error: err };
  }
}

/**
 * Subscribe to realtime updates on public.locker_commands
 */
export function subscribeToLockerCommands(onChange) {
  const client = initSupabaseClient();
  if (!client) return null;

  try {
    const channel = client
      .channel('locker_commands_feed')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'locker_commands' },
        (payload) => {
          if (typeof onChange === 'function') {
            onChange(payload);
          }
        }
      )
      .subscribe();

    return channel;
  } catch (err) {
    console.warn('Realtime subscription error:', err);
    return null;
  }
}

/**
 * Triggers the core door cycle:
 * 1. Sets door_id to 7 in public.locker_commands
 * 2. Runs 5s countdown timer
 * 3. Sets door_id to 8 in the same row
 */
export async function runDoorCycle({
  mode = 'insert',
  onDoor7,
  onTick,
  onDoor8,
  onError
}) {
  const client = initSupabaseClient();
  if (!client) {
    const err = new Error('Supabase is not configured. Please enter your project URL and Key in Settings.');
    if (onError) onError(err);
    return;
  }

  const { lockerId } = getSupabaseConfig();
  let targetRowId = null;

  try {
    // --- STEP 1: Set door_id to 7 ---
    if (mode === 'update_latest') {
      // Find the most recent row
      const { data: latest, error: fetchErr } = await client
        .from('locker_commands')
        .select('id')
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (fetchErr) throw fetchErr;

      if (latest && latest.id) {
        targetRowId = latest.id;
        const { error: updateErr } = await client
          .from('locker_commands')
          .update({
            door_id: 7,
            command: 'CYCLE_OPEN_DOOR_7',
            processed: false
          })
          .eq('id', targetRowId);

        if (updateErr) throw updateErr;
      } else {
        // Fallback to insert if table has no rows
        const { data: newRow, error: insertErr } = await client
          .from('locker_commands')
          .insert([
            {
              door_id: 7,
              locker_id: lockerId,
              command: 'CYCLE_OPEN_DOOR_7',
              processed: false
            }
          ])
          .select()
          .single();

        if (insertErr) throw insertErr;
        targetRowId = newRow.id;
      }
    } else {
      // Default & recommended: Insert a new command row
      const { data: newRow, error: insertErr } = await client
        .from('locker_commands')
        .insert([
          {
            door_id: 7,
            locker_id: lockerId,
            command: 'CYCLE_OPEN_DOOR_7',
            processed: false
          }
        ])
        .select()
        .single();

      if (insertErr) throw insertErr;
      targetRowId = newRow.id;
    }

    if (onDoor7) {
      onDoor7({ rowId: targetRowId, doorId: 7 });
    }

    // --- STEP 2: 5-second countdown timer ---
    const TOTAL_DURATION_MS = 5000;
    const INTERVAL_MS = 100;
    const startTime = Date.now();

    await new Promise((resolve) => {
      const interval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const remainingMs = Math.max(0, TOTAL_DURATION_MS - elapsed);
        const remainingSeconds = (remainingMs / 1000).toFixed(1);
        const progressFraction = Math.min(1, elapsed / TOTAL_DURATION_MS);

        if (onTick) {
          onTick({
            remainingSeconds,
            progressFraction,
            remainingMs
          });
        }

        if (elapsed >= TOTAL_DURATION_MS) {
          clearInterval(interval);
          resolve();
        }
      }, INTERVAL_MS);
    });

    // --- STEP 3: Change door_id to 8 ---
    const { error: finalUpdateErr } = await client
      .from('locker_commands')
      .update({
        door_id: 8,
        command: 'CYCLE_CLOSE_DOOR_8',
        processed: true
      })
      .eq('id', targetRowId);

    if (finalUpdateErr) throw finalUpdateErr;

    if (onDoor8) {
      onDoor8({ rowId: targetRowId, doorId: 8 });
    }
  } catch (err) {
    console.error('Error during door cycle execution:', err);
    if (onError) onError(err);
  }
}
