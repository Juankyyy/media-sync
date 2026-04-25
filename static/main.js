// ─── State ────────────────────────────────────────────────────────────────────
let currentFiles = [];
let destinations = [];

// ─── Init ─────────────────────────────────────────────────────────────────────
const STATUS_POLL_SECONDS = 30;
let countdownRemaining = STATUS_POLL_SECONDS;
let countdownInterval = null;
let lastStatusTg = null; // null = unknown, true = ok, false = err
let lastStatusIm = null;
let isChecking = false;

document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  await loadDestinations();
  await checkStatus();
  setupDropZone();
  startCountdown();
});

function setTab(tabId) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`.tab[onclick="setTab('${tabId}')"]`).classList.add('active');
  document.getElementById('panel-' + tabId).classList.add('active');
}

function startCountdown() {
  countdownRemaining = STATUS_POLL_SECONDS;
  updateCountdownUI();
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    if (isChecking) return; // don't tick while a check is in progress
    countdownRemaining--;
    updateCountdownUI();
    if (countdownRemaining <= 0) {
      isChecking = true;
      updateCountdownUI();
      checkStatus().then(() => {
        isChecking = false;
        countdownRemaining = STATUS_POLL_SECONDS;
        updateCountdownUI();
      }).catch(() => {
        isChecking = false;
        countdownRemaining = STATUS_POLL_SECONDS;
        updateCountdownUI();
      });
    }
  }, 1000);
}

function updateCountdownUI() {
  const secEl = document.getElementById('countdownSec');
  const fillEl = document.getElementById('countdownFill');
  const widget = document.getElementById('countdownWidget');
  const pct = (countdownRemaining / STATUS_POLL_SECONDS) * 100;
  secEl.textContent = Math.max(0, countdownRemaining);
  fillEl.style.width = pct + '%';
  widget.classList.toggle('checking', countdownRemaining <= 0);
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function setTab(id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + id).classList.add('active');
  event.currentTarget.classList.add('active');
  if (id === 'destinations') {
    loadImmichAlbums();
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────
async function loadConfig() {
  const r = await fetch('/api/config');
  const cfg = await r.json();
  if (cfg.telegram_token) document.getElementById('cfgTgToken').value = cfg.telegram_token;
  if (cfg.telegram_chat_id) document.getElementById('cfgTgChat').value = cfg.telegram_chat_id;
  if (cfg.immich_url) document.getElementById('cfgImUrl').value = cfg.immich_url;
  if (cfg.immich_api_key) document.getElementById('cfgImKey').value = cfg.immich_api_key;
}

async function saveConfig() {
  const body = {
    telegram_token: document.getElementById('cfgTgToken').value,
    telegram_chat_id: document.getElementById('cfgTgChat').value,
    immich_url: document.getElementById('cfgImUrl').value,
    immich_api_key: document.getElementById('cfgImKey').value,
  };
  await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  addNotification('app', 'Configuración guardada', 'Los ajustes se han actualizado correctamente.', 'success', true);
  await checkStatus();
}

// ─── Test connection ──────────────────────────────────────────────────────────
async function testConn(service) {
  // Save first
  await saveConfig();
  setChecking(service, true);
  const name = service === 'telegram' ? 'Telegram' : 'Immich';
  try {
    const r = await fetch('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service })
    });
    const d = await r.json();
    if (d.ok) {
      addNotification(service, `${name} — Conexión exitosa`, d.info || 'Conectado correctamente.', 'success');
    } else {
      addNotification(service, `${name} — Error de conexión`, d.error || 'No se pudo conectar. Revisa la configuración.', 'error');
    }
    updateDot(service, d.ok);
  } catch (e) {
    addNotification(service, `${name} — Error de red`, e.message || 'No se pudo contactar el servidor.', 'error');
    updateDot(service, false);
  }
}

function setChecking(service, forceFullAnim = false) {
  const isTg = service === 'telegram';
  const dotId = isTg ? 'dot-tg' : 'dot-im';
  const statusId = isTg ? 'status-tg' : 'status-im';
  const labelId = isTg ? 'label-tg' : 'label-im';
  const name = isTg ? 'Telegram' : 'Immich';
  const lastStatus = isTg ? lastStatusTg : lastStatusIm;

  const statusEl = document.getElementById(statusId);
  const dotEl = document.getElementById(dotId);

  if (lastStatus === true && !forceFullAnim) {
    // Already connected → subtle blink, keep "Conectado" label
    dotEl.classList.remove('rechecking');
    void dotEl.offsetWidth; // force reflow to restart animation
    dotEl.classList.add('rechecking');
  } else {
    // Unknown or error → full shimmer animation
    statusEl.classList.add('checking');
    dotEl.classList.add('checking');
    document.getElementById(labelId).textContent = name + ': verificando…';
  }
}

async function checkStatus() {
  // Set both to checking state
  setChecking('telegram');
  setChecking('immich');

  // Telegram
  try {
    const r = await fetch('/api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: 'telegram' }) });
    const d = await r.json();
    updateDot('telegram', d.ok);
    if (!d.ok) {
      addNotification('telegram', 'Telegram — Sin conexión', d.error || 'No se pudo conectar al bot. Verifica el token y el Chat ID en Configuración.', 'error');
    } else {
      clearNotifications('telegram');
    }
  } catch (e) {
    updateDot('telegram', false);
    addNotification('telegram', 'Telegram — Error de red', 'No se pudo contactar la API de Telegram: ' + (e.message || 'error desconocido'), 'error');
  }
  // Immich
  try {
    const r = await fetch('/api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: 'immich' }) });
    const d = await r.json();
    updateDot('immich', d.ok);
    if (!d.ok) {
      addNotification('immich', 'Immich — Sin conexión', d.error || 'No se pudo conectar al servidor. Verifica la URL y la API Key en Configuración.', 'error');
    } else {
      clearNotifications('immich');
    }
  } catch (e) {
    updateDot('immich', false);
    addNotification('immich', 'Immich — Error de red', 'No se pudo contactar el servidor Immich: ' + (e.message || 'error desconocido'), 'error');
  }
}

function updateDot(service, ok) {
  const isTg = service === 'telegram';
  const dotId = isTg ? 'dot-tg' : 'dot-im';
  const statusId = isTg ? 'status-tg' : 'status-im';
  const labelId = isTg ? 'label-tg' : 'label-im';
  const name = isTg ? 'Telegram' : 'Immich';

  // Store last known status
  if (isTg) lastStatusTg = ok;
  else lastStatusIm = ok;

  const dotEl = document.getElementById(dotId);
  dotEl.className = 'dot ' + (ok ? 'ok' : 'err');

  const statusEl = document.getElementById(statusId);
  statusEl.className = 'status-dot ' + (ok ? 'ok' : 'err');

  document.getElementById(labelId).textContent = name + ': ' + (ok ? 'Conectado' : 'Sin conexión');
}

// ─── Destinations ─────────────────────────────────────────────────────────────
async function loadDestinations() {
  const r = await fetch('/api/destinations');
  destinations = await r.json();
  renderDestinations();
  updateDestSelect();
}

function renderDestinations() {
  const list = document.getElementById('destList');
  if (!destinations.length) {
    list.innerHTML = '<div class="empty-state">No hay destinos. Añade uno arriba.</div>';
    return;
  }
  list.innerHTML = destinations.map(d => `
    <div class="dest-item">
      <div class="dest-name">${d.name}</div>
      <div class="dest-ids">
        <div>Immich: ${d.immich_album_name || d.immich_album_id?.substring(0,8)+'...' || '—'}</div>
        <div>TG topic: ${d.telegram_topic_id || '—'}</div>
      </div>
      <span class="dest-badge">ID: ${d.id}</span>
      <button class="btn btn-edit btn-sm" onclick="openEditModal('${d.id}')" title="Editar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>
      <button class="btn btn-danger btn-sm" onclick="deleteDest('${d.id}')" title="Eliminar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
    </div>
  `).join('');
}

function updateDestSelect() {
  const sel = document.getElementById('destSelect');
  sel.innerHTML = '<option value="">— Selecciona un destino —</option>' +
    destinations.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
  checkUploadReady();
}

function toggleAddForm() {
  const f = document.getElementById('addDestForm');
  f.classList.toggle('show');
  if (f.classList.contains('show')) {
    loadImmichAlbums();
  }
}

async function loadImmichAlbums() {
  const sel = document.getElementById('newImmichAlbum');
  sel.innerHTML = '<option value="">Cargando...</option>';
  try {
    const r = await fetch('/api/immich/albums');
    const d = await r.json();
    if (d.error) { sel.innerHTML = '<option value="">Error: configura Immich primero</option>'; return; }
    sel.innerHTML = '<option value="">— Seleccionar álbum —</option>' +
      d.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
  } catch {
    sel.innerHTML = '<option value="">Error de conexión</option>';
  }
}


async function addDest() {
  const name = document.getElementById('newDestName').value.trim();
  const albumSel = document.getElementById('newImmichAlbum');
  const immich_album_id = albumSel.value;
  const immich_album_name = albumSel.options[albumSel.selectedIndex]?.text || '';
  const telegram_topic_id = document.getElementById('newTgTopic').value.trim();
  if (!name) { addNotification('app', 'Campo requerido', 'Escribe un nombre para el destino.', 'warning'); return; }
  if (!immich_album_id || !telegram_topic_id) { addNotification('app', 'Campo requerido', 'Selecciona un álbum de Immich e introduce el Topic ID de Telegram.', 'warning'); return; }

  await fetch('/api/destinations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, immich_album_id, immich_album_name, telegram_topic_id })
  });
  document.getElementById('newDestName').value = '';
  document.getElementById('addDestForm').classList.remove('show');
  await loadDestinations();
  addNotification('app', 'Destino añadido', `"${name}" se ha creado correctamente.`, 'success');
}

async function deleteDest(id) {
  if (!confirm('¿Eliminar este destino?')) return;
  await fetch('/api/destinations', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  });
  await loadDestinations();
  addNotification('app', 'Destino eliminado', 'El destino se ha eliminado correctamente.', 'success');
}

// ─── Edit modal ───────────────────────────────────────────────────────────────
async function openEditModal(id) {
  const dest = destinations.find(d => d.id === id);
  if (!dest) return;

  document.getElementById('editDestId').value = dest.id;
  document.getElementById('editDestName').value = dest.name;
  document.getElementById('editTgTopic').value = dest.telegram_topic_id || '';

  // Load albums and pre-select current one
  await loadEditImmichAlbums(dest.immich_album_id);

  document.getElementById('editModal').classList.add('show');
}

function closeEditModal() {
  document.getElementById('editModal').classList.remove('show');
}

async function loadEditImmichAlbums(selectedId) {
  const sel = document.getElementById('editImmichAlbum');
  sel.innerHTML = '<option value="">Cargando...</option>';
  try {
    const r = await fetch('/api/immich/albums');
    const d = await r.json();
    if (d.error) { sel.innerHTML = '<option value="">Error: configura Immich primero</option>'; return; }
    sel.innerHTML = '<option value="">— Seleccionar álbum —</option>' +
      d.map(a => `<option value="${a.id}" ${a.id === selectedId ? 'selected' : ''}>${a.name}</option>`).join('');
  } catch {
    sel.innerHTML = '<option value="">Error de conexión</option>';
  }
}

async function saveEditDest() {
  const id = document.getElementById('editDestId').value;
  const name = document.getElementById('editDestName').value.trim();
  const albumSel = document.getElementById('editImmichAlbum');
  const immich_album_id = albumSel.value;
  const immich_album_name = albumSel.options[albumSel.selectedIndex]?.text || '';
  const telegram_topic_id = document.getElementById('editTgTopic').value.trim();

  if (!name) { addNotification('app', 'Campo requerido', 'El nombre del destino no puede estar vacío.', 'warning'); return; }
  if (!immich_album_id || !telegram_topic_id) { addNotification('app', 'Campo requerido', 'Selecciona un álbum e introduce el Topic ID.', 'warning'); return; }

  await fetch('/api/destinations', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name, immich_album_id, immich_album_name, telegram_topic_id })
  });

  closeEditModal();
  await loadDestinations();
  addNotification('app', 'Destino actualizado', `"${name}" se ha actualizado correctamente.`, 'success', true);
}

// ─── File handling ────────────────────────────────────────────────────────────
function setupDropZone() {
  const dz = document.getElementById('dropZone');
  const fi = document.getElementById('fileInput');

  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('over');
    const files = e.dataTransfer.files;
    if (files.length > 0) addFiles(files);
  });
  fi.addEventListener('change', e => {
    if (e.target.files.length > 0) addFiles(e.target.files);
  });

  document.getElementById('destSelect').addEventListener('change', checkUploadReady);
}

function addFiles(files) {
  for(let i=0; i<files.length; i++) {
    currentFiles.push({
      id: Math.random().toString(36).substr(2, 9),
      file: files[i],
      asDocument: false
    });
  }
  renderFilePreviews();
}

function toggleAsDocument(id, checked) {
  const fItem = currentFiles.find(f => f.id === id);
  if (fItem) fItem.asDocument = checked;
}

function removeFile(id) {
  currentFiles = currentFiles.filter(f => f.id !== id);
  renderFilePreviews();
}

function clearAllFiles() {
  currentFiles = [];
  document.getElementById('fileInput').value = '';
  renderFilePreviews();
  hideResult();
}

function renderFilePreviews() {
  const list = document.getElementById('filePreviewList');
  const actions = document.getElementById('filePreviewActions');
  list.innerHTML = '';
  
  if (currentFiles.length === 0) {
    list.style.display = 'none';
    actions.style.display = 'none';
    checkUploadReady();
    return;
  }
  
  currentFiles.forEach(fItem => {
    const file = fItem.file;
    const div = document.createElement('div');
    div.className = 'file-preview show';
    div.style.marginTop = '0';
    
    let thumbHtml = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--muted);"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>';
    if (file.type.startsWith('image/')) {
      thumbHtml = `<img src="${URL.createObjectURL(file)}">`;
    } else if (file.type.startsWith('video/')) {
      thumbHtml = `<video src="${URL.createObjectURL(file)}" muted></video>`;
    }
    
    div.innerHTML = `
      <div class="file-thumb">${thumbHtml}</div>
      <div class="file-info">
        <div class="file-name">${file.name}</div>
        <div class="file-size">${formatSize(file.size)}</div>
      </div>
      <label class="btn-toggle ${fItem.asDocument ? 'active' : ''}" style="margin-right: 12px;">
        <input type="checkbox" onchange="toggleAsDocument('${fItem.id}', this.checked); this.parentElement.classList.toggle('active', this.checked)" ${fItem.asDocument ? 'checked' : ''}>
        <svg class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
        Archivo
      </label>
      <button class="btn btn-ghost btn-sm" onclick="removeFile('${fItem.id}')">✕</button>
    `;
    list.appendChild(div);
  });
  
  list.style.display = 'flex';
  actions.style.display = currentFiles.length > 1 ? 'flex' : 'none';
  hideResult();
  checkUploadReady();
}

function checkUploadReady() {
  const destSel = document.getElementById('destSelect').value;
  const ready = currentFiles.length > 0 && destSel;
  const btn = document.getElementById('uploadBtn');
  const hint = document.getElementById('uploadHint');
  btn.disabled = !ready;
  hint.textContent = currentFiles.length === 0 ? 'Selecciona un archivo' : !destSel ? 'Selecciona un destino' : '';
}

// ─── Upload Modal ─────────────────────────────────────────────────────────────
function closeUploadModal() {
  document.getElementById('uploadModal').classList.remove('show');
}

// ─── Upload ───────────────────────────────────────────────────────────────────
async function doUpload() {
  const destId = document.getElementById('destSelect').value;
  if (currentFiles.length === 0 || !destId) return;

  const btn = document.getElementById('uploadBtn');
  btn.disabled = true;

  // Reset and show modal
  const modal = document.getElementById('uploadModal');
  const tgProg = document.getElementById('tgUploadProgress');
  const imProg = document.getElementById('imUploadProgress');
  const tgRes = document.getElementById('tgUploadResult');
  const imRes = document.getElementById('imUploadResult');
  
  tgProg.style.display = 'block';
  imProg.style.display = 'block';
  tgRes.style.display = 'none';
  imRes.style.display = 'none';
  document.getElementById('uploadModalActions').style.display = 'none';
  document.getElementById('uploadModalClose').style.display = 'none';
  
  // Reset progress bars and styles
  const tgFill = tgProg.querySelector('.progress-fill');
  const imFill = imProg.querySelector('.progress-fill');
  const tgText = document.getElementById('tgUploadText');
  const imText = document.getElementById('imUploadText');
  const tgCol = document.getElementById('tgCol');
  const imCol = document.getElementById('imCol');
  
  tgCol.style.background = 'var(--surface2)';
  tgCol.style.borderColor = 'var(--border)';
  imCol.style.background = 'var(--surface2)';
  imCol.style.borderColor = 'var(--border)';
  
  tgFill.classList.remove('indeterminate');
  imFill.classList.remove('indeterminate');
  tgFill.style.width = '0%';
  imFill.style.width = '0%';
  tgText.textContent = 'Inicializando...';
  imText.textContent = 'Inicializando...';

  modal.classList.add('show');

  const fd = new FormData();
  currentFiles.forEach(f => {
    fd.append('files', f.file);
    fd.append('as_document', f.asDocument ? 'true' : 'false');
  });
  fd.append('destination_id', destId);

  try {
    const rStart = await fetch('/api/upload', { method: 'POST', body: fd });
    const dStart = await rStart.json();

    if (dStart.error) {
      throw new Error(dStart.error);
    }

    const taskId = dStart.task_id;

    // Poll status
    const pollInterval = setInterval(async () => {
      try {
        const rStat = await fetch('/api/upload_status/' + taskId);
        const task = await rStat.json();

        if (task.error) {
          clearInterval(pollInterval);
          throw new Error(task.error);
        }

        // Update progress UI independently
        ['tg', 'im'].forEach(api => {
          const t = task[api];
          const prog = api === 'tg' ? tgProg : imProg;
          const res = api === 'tg' ? tgRes : imRes;
          const fill = api === 'tg' ? tgFill : imFill;
          const text = api === 'tg' ? tgText : imText;
          
          if (t.status === 'completed') {
            prog.style.display = 'none';
            res.style.display = 'block';
            
            const col = api === 'tg' ? tgCol : imCol;
            const iconSuccess = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: text-bottom; margin-right: 4px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
            const iconWarn = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: text-bottom; margin-right: 4px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
            const iconError = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: text-bottom; margin-right: 4px;"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
            
            if (t.success > 0 && t.errors.length === 0) {
              res.innerHTML = `<span style="color:var(--success)">${iconSuccess} Se subió correctamente (${t.success})</span>`;
              col.style.background = 'rgba(16, 185, 129, 0.1)';
              col.style.borderColor = 'rgba(16, 185, 129, 0.3)';
            } else if (t.errors.length > 0) {
              const isPartial = t.success > 0;
              const prefix = isPartial ? `<span style="color:var(--warn)">${iconWarn} Parcial: ${t.success} subidos</span>\n` : `<span style="color:var(--danger)">${iconError} Error al subir</span>\n`;
              res.innerHTML = prefix + `<span style="color:var(--danger)">${t.errors.join('\n')}</span>`;
              
              if (isPartial) {
                col.style.background = 'rgba(245, 158, 11, 0.1)';
                col.style.borderColor = 'rgba(245, 158, 11, 0.3)';
              } else {
                col.style.background = 'rgba(239, 68, 68, 0.1)';
                col.style.borderColor = 'rgba(239, 68, 68, 0.3)';
              }
            } else {
              res.innerHTML = `<span style="color:var(--danger)">${iconError} Error desconocido</span>`;
              col.style.background = 'rgba(239, 68, 68, 0.1)';
              col.style.borderColor = 'rgba(239, 68, 68, 0.3)';
            }
          } else {
            if (t.total > 0) {
              let pct = (t.uploaded / t.total) * 100;
              if (pct > 100) pct = 100;
              fill.style.width = pct + '%';
              if (t.uploaded === 0) {
                text.textContent = 'Inicializando...';
              } else {
                text.textContent = `Subiendo... (${formatSize(t.uploaded)} / ${formatSize(t.total)})`;
              }
            } else {
              text.textContent = 'Inicializando...';
            }
          }
        });

        if (task.status === 'completed') {
          clearInterval(pollInterval);
          document.getElementById('uploadModalActions').style.display = 'flex';
          document.getElementById('uploadModalClose').style.display = 'block';

          const failedNames = new Set();
          if (task.tg && task.tg.errors) {
            task.tg.errors.forEach(e => {
              const parts = e.split(':');
              if (parts.length > 1) failedNames.add(parts[0].trim());
            });
          }
          if (task.im && task.im.errors) {
            task.im.errors.forEach(e => {
              const parts = e.split(':');
              if (parts.length > 1) failedNames.add(parts[0].trim());
            });
          }
          
          if (failedNames.size === 0) {
            clearAllFiles();
          } else {
            currentFiles = currentFiles.filter(f => failedNames.has(f.file.name));
            if (currentFiles.length === 0) {
              clearAllFiles();
            } else {
              renderFilePreviews();
              document.getElementById('fileInput').value = '';
            }
          }
          
          btn.disabled = false;
          checkUploadReady();
        }
      } catch (err) {
        clearInterval(pollInterval);
        handleUploadError(err);
      }
    }, 1000);

  } catch (e) {
    handleUploadError(e);
  }
}

function handleUploadError(e) {
  const tgProg = document.getElementById('tgUploadProgress');
  const imProg = document.getElementById('imUploadProgress');
  const tgRes = document.getElementById('tgUploadResult');
  const imRes = document.getElementById('imUploadResult');
  
  tgProg.style.display = 'none';
  imProg.style.display = 'none';
  tgRes.style.display = 'block';
  imRes.style.display = 'block';
  document.getElementById('uploadModalActions').style.display = 'flex';
  document.getElementById('uploadModalClose').style.display = 'block';
  
  const iconError = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: text-bottom; margin-right: 4px;"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
  
  if (tgRes.innerHTML === '') {
    tgRes.innerHTML = `<span style="color:var(--danger)">${iconError} Error de red: ${e.message}</span>`;
    document.getElementById('tgCol').style.background = 'rgba(239, 68, 68, 0.1)';
    document.getElementById('tgCol').style.borderColor = 'rgba(239, 68, 68, 0.3)';
  }
  if (imRes.innerHTML === '') {
    imRes.innerHTML = `<span style="color:var(--danger)">${iconError} Error de red: ${e.message}</span>`;
    document.getElementById('imCol').style.background = 'rgba(239, 68, 68, 0.1)';
    document.getElementById('imCol').style.borderColor = 'rgba(239, 68, 68, 0.3)';
  }
  
  document.getElementById('uploadBtn').disabled = false;
  checkUploadReady();
}

function hideResult() {
  // Legacy code handling removed inline result
}

function showError(msg) {
  // Legacy code handling removed inline result
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}


// ─── Persistent Notifications ─────────────────────────────────────────────────
let notifIdCounter = 0;

function addNotification(service, title, message, type = 'error', autoClose = false) {
  const container = document.getElementById('notifContainer');

  // Check if an identical notification already exists — skip if so
  const existing = container.querySelector(`.notif[data-service="${service}"]`);
  if (existing) {
    const existingTitle = existing.querySelector('.notif-title')?.textContent;
    const existingMsg = existing.querySelector('.notif-msg')?.textContent;
    if (existingTitle === title && existingMsg === message) return; // identical, no change needed
    // Different error — remove old one instantly
    existing.remove();
  }

  const id = 'notif-' + (++notifIdCounter);
  const icon = type === 'error' ? '🚨' : type === 'success' ? '✅' : '⚠️';

  const el = document.createElement('div');
  el.className = `notif ${type}`;
  el.id = id;
  el.dataset.service = service;
  el.innerHTML = `
    <span class="notif-icon">${icon}</span>
    <div class="notif-body">
      <div class="notif-title">${title}</div>
      <div class="notif-msg">${message}</div>
    </div>
    <button class="notif-close" onclick="dismissNotification('${id}')" title="Cerrar">✕</button>
  `;
  container.appendChild(el);

  if (autoClose) {
    setTimeout(() => dismissNotification(id), 3500);
  }
}

function dismissNotification(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('removing');
  setTimeout(() => el.remove(), 250);
}

function clearNotifications(service) {
  const container = document.getElementById('notifContainer');
  container.querySelectorAll(`.notif[data-service="${service}"]`).forEach(el => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 250);
  });
}