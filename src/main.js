import confetti from 'canvas-confetti';
import {
  getSupabaseConfig,
  saveSupabaseConfig,
  testSupabaseConnection,
  initSupabaseClient,
  runDoorCycle,
  fetchRecentCommands,
  subscribeToLockerCommands
} from './supabase.js';

// DOM Elements
const triggerBtn = document.getElementById('trigger-btn');
const btnLabel = document.getElementById('btn-label');
const btnSubtext = document.getElementById('btn-subtext');
const btnIcon = document.getElementById('btn-icon');
const countdownCircle = document.getElementById('countdown-circle');
const timerDisplay = document.getElementById('timer-display');
const timerCountdown = document.getElementById('timer-countdown');
const statusMessage = document.getElementById('status-message');

// HUD Elements
const currentDoorVal = document.getElementById('current-door-val');
const cyclePhase = document.getElementById('cycle-phase');
const targetRowVal = document.getElementById('target-row-val');
const connectionStatus = document.getElementById('connection-status');

// Settings Elements
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings');
const configForm = document.getElementById('supabase-config-form');
const cfgUrl = document.getElementById('cfg-url');
const cfgKey = document.getElementById('cfg-key');
const cfgLockerId = document.getElementById('cfg-locker-id');
const testConnBtn = document.getElementById('test-connection-btn');
const modalFeedback = document.getElementById('modal-feedback');

// Feed Elements
const activityList = document.getElementById('activity-list');
const refreshFeedBtn = document.getElementById('refresh-feed-btn');

// Install Banner Elements
const installBanner = document.getElementById('install-banner');
const installBtn = document.getElementById('install-btn');
const installDismiss = document.getElementById('install-dismiss');

// SVG Ring Circumference: 2 * Math.PI * 126
const RING_CIRCUMFERENCE = 791.68;
let deferredPrompt = null;
let isCycleRunning = false;
let realtimeChannel = null;

// ==========================================
// PWA Installation & Service Worker Setup
// ==========================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => console.log('Service Worker registered:', reg.scope))
      .catch((err) => console.warn('Service Worker registration failed:', err));
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (installBanner) installBanner.classList.remove('hidden');
});

if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log('User response to install:', outcome);
    deferredPrompt = null;
    installBanner.classList.add('hidden');
  });
}

if (installDismiss) {
  installDismiss.addEventListener('click', () => {
    installBanner.classList.add('hidden');
  });
}

// ==========================================
// Audio & Haptic Feedback
// ==========================================
function triggerHaptic(type = 'medium') {
  if (!('vibrate' in navigator)) return;
  try {
    if (type === 'start') navigator.vibrate([80, 50, 80]);
    else if (type === 'tick') navigator.vibrate(30);
    else if (type === 'finish') navigator.vibrate([150, 100, 250]);
    else navigator.vibrate(50);
  } catch (e) {
    // Ignore vibrate errors if browser restricts
  }
}

function triggerCelebration() {
  try {
    confetti({
      particleCount: 50,
      spread: 60,
      origin: { y: 0.65 },
      colors: ['#38bdf8', '#22c55e', '#3b82f6', '#f59e0b']
    });
  } catch (e) {
    // Confetti optional
  }
}

// ==========================================
// UI State Updates
// ==========================================
function updateConnectionUI(connected, text = null) {
  if (!connectionStatus) return;
  const label = connectionStatus.querySelector('.status-label');

  if (connected) {
    connectionStatus.className = 'status-pill status-connected';
    if (label) label.textContent = text || 'Connected';
    connectionStatus.title = 'Supabase connected and accessible';
  } else {
    connectionStatus.className = 'status-pill status-disconnected';
    if (label) label.textContent = text || 'Setup Needed';
    connectionStatus.title = 'Supabase not connected. Click gear icon to configure.';
  }
}

function resetCountdownRing() {
  if (countdownCircle) {
    countdownCircle.style.strokeDashoffset = '0';
    countdownCircle.style.stroke = 'var(--accent-cyan)';
  }
}

function updateCountdownRing(progressFraction) {
  if (!countdownCircle) return;
  // Progress goes from 0 (full circle) to 1 (empty ring)
  const offset = RING_CIRCUMFERENCE * progressFraction;
  countdownCircle.style.strokeDashoffset = `${offset}`;
  
  // Transition color from cyan to amber as time runs down
  if (progressFraction > 0.7) {
    countdownCircle.style.stroke = 'var(--accent-amber)';
  } else {
    countdownCircle.style.stroke = 'var(--accent-cyan)';
  }
}

// ==========================================
// Door Cycle Execution
// ==========================================
async function handleTriggerClick() {
  if (isCycleRunning) return;

  const config = getSupabaseConfig();
  if (!config.url || !config.key) {
    showStatus('Please set Supabase URL and Key in Settings first', 'error');
    openSettingsModal();
    return;
  }

  const modeRadio = document.querySelector('input[name="exec-mode"]:checked');
  const mode = modeRadio ? modeRadio.value : 'insert';

  isCycleRunning = true;
  triggerBtn.disabled = true;
  triggerHaptic('start');

  // Set initial UI state
  triggerBtn.className = 'big-action-button state-active';
  btnLabel.textContent = 'DOOR 7 ACTIVE';
  btnSubtext.textContent = 'SETTING DOOR 7 IN SUPABASE...';
  statusMessage.textContent = 'Writing door_id = 7 to Supabase...';
  statusMessage.style.color = 'var(--accent-amber)';

  resetCountdownRing();
  timerDisplay.classList.remove('hidden');
  timerCountdown.textContent = '5.0s';

  await runDoorCycle({
    mode,
    onDoor7: ({ rowId, doorId }) => {
      targetRowVal.textContent = `#${rowId}`;
      currentDoorVal.textContent = `${doorId}`;
      currentDoorVal.className = 'hud-value hud-glow-door';
      cyclePhase.textContent = 'DOOR 7 ACTIVE';
      cyclePhase.className = 'hud-value status-running';

      btnLabel.textContent = 'HOLDING 5s';
      btnSubtext.textContent = `ROW #${rowId} • DOOR ID: 7`;
      statusMessage.textContent = `Door 7 active for row #${rowId}. Waiting 5s before switching to 8...`;
      triggerHaptic('medium');
    },

    onTick: ({ remainingSeconds, progressFraction }) => {
      timerCountdown.textContent = `${remainingSeconds}s`;
      updateCountdownRing(progressFraction);
    },

    onDoor8: ({ rowId, doorId }) => {
      targetRowVal.textContent = `#${rowId}`;
      currentDoorVal.textContent = `${doorId}`;
      currentDoorVal.className = 'hud-value hud-glow-door';
      cyclePhase.textContent = 'COMPLETE (8)';
      cyclePhase.className = 'hud-value status-done';

      triggerBtn.className = 'big-action-button state-success';
      btnLabel.textContent = 'DOOR 8 READY';
      btnSubtext.textContent = `ROW #${rowId} UPDATED TO 8`;
      
      timerCountdown.textContent = '0.0s';
      updateCountdownRing(1);
      statusMessage.textContent = `Success! Row #${rowId} door_id changed to 8.`;
      statusMessage.style.color = 'var(--accent-green)';

      triggerHaptic('finish');
      triggerCelebration();
      loadRecentCommands();

      // Reset after 3 seconds
      setTimeout(() => {
        timerDisplay.classList.add('hidden');
        resetCountdownRing();
        triggerBtn.className = 'big-action-button';
        triggerBtn.disabled = false;
        btnLabel.textContent = 'START CYCLE';
        btnSubtext.textContent = 'DOOR 7 ➔ 5s ➔ DOOR 8';
        statusMessage.textContent = 'Ready for next cycle';
        statusMessage.style.color = 'var(--text-secondary)';
        isCycleRunning = false;
      }, 3000);
    },

    onError: (err) => {
      console.error('Cycle failed:', err);
      statusMessage.textContent = `Error: ${err.message || 'Operation failed'}`;
      statusMessage.style.color = 'var(--accent-red)';
      triggerBtn.className = 'big-action-button';
      triggerBtn.disabled = false;
      timerDisplay.classList.add('hidden');
      resetCountdownRing();
      isCycleRunning = false;
      cyclePhase.textContent = 'ERROR';
      cyclePhase.className = 'hud-value';
      cyclePhase.style.color = 'var(--accent-red)';
    }
  });
}

function showStatus(msg, type = 'info') {
  if (!statusMessage) return;
  statusMessage.textContent = msg;
  if (type === 'error') statusMessage.style.color = 'var(--accent-red)';
  else if (type === 'success') statusMessage.style.color = 'var(--accent-green)';
  else statusMessage.style.color = 'var(--text-secondary)';
}

// ==========================================
// Live Activity / Feed
// ==========================================
async function loadRecentCommands() {
  if (!activityList) return;
  const { data, error } = await fetchRecentCommands(6);

  if (error || !data || data.length === 0) {
    activityList.innerHTML = `
      <div class="empty-state">
        ${error ? 'Could not fetch records (' + error.message + ')' : 'No records yet. Press the button to trigger a cycle.'}
      </div>
    `;
    return;
  }

  activityList.innerHTML = data
    .map((cmd) => {
      const timeStr = cmd.created_at ? new Date(cmd.created_at).toLocaleTimeString() : 'Just now';
      const isDoor7 = cmd.door_id === 7;
      const badgeClass = isDoor7 ? 'badge-door7' : 'badge-door8';
      return `
        <div class="activity-item">
          <div class="activity-main">
            <strong>Row #${cmd.id} ${cmd.locker_id ? '• ' + cmd.locker_id : ''}</strong>
            <span class="activity-time">${timeStr} • ${cmd.command || 'DOOR_COMMAND'}</span>
          </div>
          <div class="activity-badge ${badgeClass}">
            door_id: ${cmd.door_id ?? 'null'}
          </div>
        </div>
      `;
    })
    .join('');
}

// ==========================================
// Settings Modal Logic
// ==========================================
function openSettingsModal() {
  const config = getSupabaseConfig();
  cfgUrl.value = config.url || '';
  cfgKey.value = config.key || '';
  cfgLockerId.value = config.lockerId || '';
  modalFeedback.className = 'modal-feedback hidden';
  modalFeedback.textContent = '';
  settingsModal.classList.remove('hidden');
}

function closeSettingsModal() {
  settingsModal.classList.add('hidden');
}

async function handleTestConnection() {
  testConnBtn.disabled = true;
  testConnBtn.textContent = 'Testing...';
  modalFeedback.className = 'modal-feedback hidden';

  // Temporarily apply current inputs
  saveSupabaseConfig({
    url: cfgUrl.value,
    key: cfgKey.value,
    lockerId: cfgLockerId.value
  });

  const res = await testSupabaseConnection();
  testConnBtn.disabled = false;
  testConnBtn.textContent = 'Test Connection';

  modalFeedback.classList.remove('hidden');
  if (res.ok) {
    modalFeedback.className = 'modal-feedback success';
    modalFeedback.textContent = res.message;
    updateConnectionUI(true, 'Connected');
    loadRecentCommands();
    setupRealtime();
  } else {
    modalFeedback.className = 'modal-feedback error';
    modalFeedback.textContent = res.message;
    updateConnectionUI(false, 'Check Config');
  }
}

function handleSaveSettings(e) {
  e.preventDefault();
  saveSupabaseConfig({
    url: cfgUrl.value,
    key: cfgKey.value,
    lockerId: cfgLockerId.value
  });

  updateConnectionUI(true, 'Config Saved');
  modalFeedback.className = 'modal-feedback success';
  modalFeedback.textContent = 'Settings saved to device!';
  modalFeedback.classList.remove('hidden');

  loadRecentCommands();
  setupRealtime();

  setTimeout(() => {
    closeSettingsModal();
  }, 1000);
}

function setupRealtime() {
  if (realtimeChannel) {
    realtimeChannel.unsubscribe();
  }
  realtimeChannel = subscribeToLockerCommands((payload) => {
    console.log('Realtime DB update received:', payload);
    loadRecentCommands();
  });
}

// ==========================================
// Initialization
// ==========================================
async function initApp() {
  // Attach Event Listeners
  if (triggerBtn) triggerBtn.addEventListener('click', handleTriggerClick);
  if (settingsBtn) settingsBtn.addEventListener('click', openSettingsModal);
  if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', closeSettingsModal);
  if (configForm) configForm.addEventListener('submit', handleSaveSettings);
  if (testConnBtn) testConnBtn.addEventListener('click', handleTestConnection);
  if (refreshFeedBtn) refreshFeedBtn.addEventListener('click', loadRecentCommands);

  // Close modal when clicking outside
  if (settingsModal) {
    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) closeSettingsModal();
    });
  }

  // Check initial connection
  const config = getSupabaseConfig();
  if (config.url && config.key) {
    initSupabaseClient();
    updateConnectionUI(false, 'Connecting...');
    const conn = await testSupabaseConnection();
    if (conn.ok) {
      updateConnectionUI(true, 'Connected');
      loadRecentCommands();
      setupRealtime();
    } else {
      updateConnectionUI(false, 'Offline / Error');
    }
  } else {
    updateConnectionUI(false, 'Setup Needed');
  }
}

// Start application
initApp();
