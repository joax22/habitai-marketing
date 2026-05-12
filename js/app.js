const API_BASE = 'http://localhost:3001';

// ── Analyze video with Claude ──
document.getElementById('btn-analyze-video').addEventListener('click', async () => {
  const url = document.getElementById('insp-url').value.trim();
  const errorEl = document.getElementById('analyze-error');
  const btn = document.getElementById('btn-analyze-video');
  const label = btn.querySelector('.analyze-label');
  const spinner = btn.querySelector('.analyze-spinner');

  errorEl.classList.add('hidden');
  if (!url) { showFieldError(errorEl, 'Paste a TikTok or Instagram URL first.'); return; }

  btn.disabled = true;
  label.classList.add('hidden');
  spinner.classList.remove('hidden');

  try {
    const res = await fetch(`${API_BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Analysis failed.');

    if (data.hook)      document.getElementById('insp-hook').value = data.hook;
    if (data.structure) document.getElementById('insp-structure').value = data.structure;
    if (data.why)       document.getElementById('insp-why').value = data.why;
    if (data.tags)      document.getElementById('insp-tags').value = data.tags;
  } catch (err) {
    showFieldError(errorEl, err.message);
  } finally {
    btn.disabled = false;
    label.classList.remove('hidden');
    spinner.classList.add('hidden');
  }
});

// ── Generate persona image with NanoBanana ──
document.getElementById('btn-generate-image').addEventListener('click', async () => {
  const description = document.getElementById('persona-face').value.trim();
  const name = document.getElementById('persona-name').value.trim();
  const niche = document.getElementById('persona-niche').value.trim();
  const errorEl = document.getElementById('generate-image-error');
  const btn = document.getElementById('btn-generate-image');
  const label = btn.querySelector('.analyze-label');
  const spinner = btn.querySelector('.analyze-spinner');

  errorEl.classList.add('hidden');
  if (!description) { showFieldError(errorEl, 'Add a face description first.'); return; }

  btn.disabled = true;
  label.classList.add('hidden');
  spinner.classList.remove('hidden');

  try {
    const res = await fetch(`${API_BASE}/api/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, name, niche }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Image generation failed.');

    document.getElementById('persona-image-img').src = data.image;
    document.getElementById('persona-image-data').value = data.image;
    document.getElementById('persona-image-preview').classList.remove('hidden');
  } catch (err) {
    showFieldError(errorEl, err.message);
  } finally {
    btn.disabled = false;
    label.classList.remove('hidden');
    spinner.classList.add('hidden');
  }
});

function showFieldError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── Storage helpers ──
const store = {
  get: (key) => JSON.parse(localStorage.getItem(key) || '[]'),
  set: (key, val) => localStorage.setItem(key, JSON.stringify(val)),
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

// ── Navigation ──
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
    if (btn.dataset.view === 'dashboard') renderDashboard();
    if (btn.dataset.view === 'inspiration') renderInspirations();
    if (btn.dataset.view === 'personas') renderPersonas();
    if (btn.dataset.view === 'scripts') { populateScriptSelects(); renderScripts(); }
    if (btn.dataset.view === 'pipeline') { populatePipelineSelects(); renderPipeline(); }
  });
});

// ── Modal helpers ──
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

document.querySelectorAll('.modal-close, [data-modal]').forEach(el => {
  el.addEventListener('click', () => closeModal(el.dataset.modal || el.closest('.modal-backdrop').id));
});

document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(backdrop.id); });
});

// ── Platform tag helper ──
function platformTag(platform) {
  const cls = {
    'TikTok': 'platform-tiktok',
    'Instagram Reels': 'platform-instagram',
    'YouTube Shorts': 'platform-youtube',
  }[platform] || 'platform-other';
  return `<span class="tag ${cls}">${platform}</span>`;
}

// ══════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════
function renderDashboard() {
  const inspirations = store.get('inspirations');
  const personas = store.get('personas');
  const scripts = store.get('scripts');
  const pipeline = store.get('pipeline');

  document.getElementById('stat-inspirations').textContent = inspirations.length;
  document.getElementById('stat-personas').textContent = personas.length;
  document.getElementById('stat-scripts').textContent = scripts.length;
  document.getElementById('stat-pipeline').textContent = pipeline.length;

  const el = document.getElementById('recent-scripts-list');
  if (!scripts.length) {
    el.innerHTML = '<div class="empty-state"><span>No scripts yet. Start in Script Builder.</span></div>';
    return;
  }
  el.innerHTML = scripts.slice(-5).reverse().map(s => {
    const persona = store.get('personas').find(p => p.id === s.personaId);
    return `
      <div class="card">
        <div class="card-body">
          <div class="card-title">${s.title}</div>
          <div class="script-card-hook">"${s.hook}"</div>
          <div class="card-meta" style="margin-top:6px">
            ${platformTag(s.platform)}
            ${persona ? `<span class="tag">${persona.name}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

// ══════════════════════════════════════════
// INSPIRATIONS
// ══════════════════════════════════════════
document.getElementById('btn-add-inspiration').addEventListener('click', () => {
  document.getElementById('inspiration-modal-title').textContent = 'Add Inspiration';
  document.getElementById('inspiration-edit-id').value = '';
  document.getElementById('form-inspiration').reset();
  openModal('modal-inspiration');
});

document.getElementById('form-inspiration').addEventListener('submit', e => {
  e.preventDefault();
  const items = store.get('inspirations');
  const editId = document.getElementById('inspiration-edit-id').value;
  const item = {
    id: editId || uid(),
    platform: document.getElementById('insp-platform').value,
    creator: document.getElementById('insp-creator').value.trim(),
    hook: document.getElementById('insp-hook').value.trim(),
    structure: document.getElementById('insp-structure').value.trim(),
    why: document.getElementById('insp-why').value.trim(),
    url: document.getElementById('insp-url').value.trim(),
    tags: document.getElementById('insp-tags').value.trim(),
    createdAt: editId ? (items.find(i => i.id === editId)?.createdAt || Date.now()) : Date.now(),
  };
  if (editId) {
    const idx = items.findIndex(i => i.id === editId);
    items[idx] = item;
  } else {
    items.push(item);
  }
  store.set('inspirations', items);
  closeModal('modal-inspiration');
  renderInspirations();
});

function renderInspirations() {
  const items = store.get('inspirations');
  const el = document.getElementById('inspiration-list');
  if (!items.length) {
    el.innerHTML = '<div class="empty-state"><span>No inspirations yet. Add one above.</span></div>';
    return;
  }
  el.innerHTML = items.slice().reverse().map(item => `
    <div class="card">
      <div class="card-body">
        <div class="card-title">${item.hook || '(no hook)'}</div>
        <div class="card-meta">
          ${platformTag(item.platform)}
          ${item.creator ? `<span>${item.creator}</span>` : ''}
          ${item.tags ? item.tags.split(',').map(t => `<span class="tag">${t.trim()}</span>`).join('') : ''}
        </div>
        ${item.why ? `<div class="card-excerpt">${item.why}</div>` : ''}
      </div>
      <div class="card-actions">
        <button class="btn-icon" onclick="editInspiration('${item.id}')">✏️</button>
        <button class="btn-icon danger" onclick="deleteInspiration('${item.id}')">🗑</button>
      </div>
    </div>
  `).join('');
}

window.editInspiration = (id) => {
  const item = store.get('inspirations').find(i => i.id === id);
  if (!item) return;
  document.getElementById('inspiration-modal-title').textContent = 'Edit Inspiration';
  document.getElementById('inspiration-edit-id').value = id;
  document.getElementById('insp-platform').value = item.platform;
  document.getElementById('insp-creator').value = item.creator || '';
  document.getElementById('insp-hook').value = item.hook || '';
  document.getElementById('insp-structure').value = item.structure || '';
  document.getElementById('insp-why').value = item.why || '';
  document.getElementById('insp-url').value = item.url || '';
  document.getElementById('insp-tags').value = item.tags || '';
  openModal('modal-inspiration');
};

window.deleteInspiration = (id) => {
  if (!confirm('Delete this inspiration?')) return;
  store.set('inspirations', store.get('inspirations').filter(i => i.id !== id));
  renderInspirations();
};

// ══════════════════════════════════════════
// PERSONAS
// ══════════════════════════════════════════
document.getElementById('btn-add-persona').addEventListener('click', () => {
  document.getElementById('persona-modal-title').textContent = 'New Persona';
  document.getElementById('persona-edit-id').value = '';
  document.getElementById('form-persona').reset();
  document.querySelectorAll('#modal-persona input[type="checkbox"]').forEach(cb => cb.checked = false);
  document.getElementById('persona-image-preview').classList.add('hidden');
  document.getElementById('persona-image-data').value = '';
  document.getElementById('persona-image-img').src = '';
  openModal('modal-persona');
});

document.getElementById('form-persona').addEventListener('submit', e => {
  e.preventDefault();
  const items = store.get('personas');
  const editId = document.getElementById('persona-edit-id').value;
  const platforms = [...document.querySelectorAll('#modal-persona .checkbox-group input:checked')].map(cb => cb.value);
  const item = {
    id: editId || uid(),
    name: document.getElementById('persona-name').value.trim(),
    niche: document.getElementById('persona-niche').value.trim(),
    vibe: document.getElementById('persona-vibe').value.trim(),
    face: document.getElementById('persona-face').value.trim(),
    audience: document.getElementById('persona-audience').value.trim(),
    platforms,
    notes: document.getElementById('persona-notes').value.trim(),
    image: document.getElementById('persona-image-data').value || '',
    createdAt: editId ? (items.find(i => i.id === editId)?.createdAt || Date.now()) : Date.now(),
  };
  if (editId) {
    const idx = items.findIndex(i => i.id === editId);
    items[idx] = item;
  } else {
    items.push(item);
  }
  store.set('personas', items);
  closeModal('modal-persona');
  renderPersonas();
});

function renderPersonas() {
  const items = store.get('personas');
  const el = document.getElementById('persona-list');
  if (!items.length) {
    el.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><span>No personas yet. Create your first AI influencer.</span></div>';
    return;
  }
  el.innerHTML = items.map(p => `
    <div class="persona-card">
      ${p.image
        ? `<img class="persona-img" src="${p.image}" alt="${p.name}" />`
        : `<div class="persona-avatar">${p.name.charAt(0).toUpperCase()}</div>`
      }
      <div class="persona-name">${p.name}</div>
      <div class="persona-niche">${p.niche}</div>
      ${p.vibe ? `<div class="persona-vibe">${p.vibe}</div>` : ''}
      ${p.platforms.length ? `<div class="persona-platforms">${p.platforms.map(pl => platformTag(pl)).join('')}</div>` : ''}
      ${p.audience ? `<div class="card-excerpt" style="margin-bottom:12px">Audience: ${p.audience}</div>` : ''}
      <div class="persona-card-actions">
        <button class="btn-icon" onclick="editPersona('${p.id}')">✏️</button>
        <button class="btn-icon danger" onclick="deletePersona('${p.id}')">🗑</button>
      </div>
    </div>
  `).join('');
}

window.editPersona = (id) => {
  const item = store.get('personas').find(p => p.id === id);
  if (!item) return;
  document.getElementById('persona-modal-title').textContent = 'Edit Persona';
  document.getElementById('persona-edit-id').value = id;
  document.getElementById('persona-name').value = item.name;
  document.getElementById('persona-niche').value = item.niche;
  document.getElementById('persona-vibe').value = item.vibe || '';
  document.getElementById('persona-face').value = item.face || '';
  document.getElementById('persona-audience').value = item.audience || '';
  document.getElementById('persona-notes').value = item.notes || '';
  document.querySelectorAll('#modal-persona .checkbox-group input').forEach(cb => {
    cb.checked = item.platforms.includes(cb.value);
  });
  if (item.image) {
    document.getElementById('persona-image-img').src = item.image;
    document.getElementById('persona-image-data').value = item.image;
    document.getElementById('persona-image-preview').classList.remove('hidden');
  } else {
    document.getElementById('persona-image-preview').classList.add('hidden');
    document.getElementById('persona-image-data').value = '';
  }
  openModal('modal-persona');
};

window.deletePersona = (id) => {
  if (!confirm('Delete this persona?')) return;
  store.set('personas', store.get('personas').filter(p => p.id !== id));
  renderPersonas();
};

// ══════════════════════════════════════════
// SCRIPT BUILDER
// ══════════════════════════════════════════
function populateScriptSelects() {
  const personas = store.get('personas');
  const inspirations = store.get('inspirations');

  const pSel = document.getElementById('script-persona');
  const cur = pSel.value;
  pSel.innerHTML = '<option value="">— Select Persona —</option>' +
    personas.map(p => `<option value="${p.id}">${p.name} · ${p.niche}</option>`).join('');
  pSel.value = cur;

  const iSel = document.getElementById('script-inspiration');
  const curI = iSel.value;
  iSel.innerHTML = '<option value="">— Select Inspiration (optional) —</option>' +
    inspirations.map(i => `<option value="${i.id}">${i.platform} · ${i.hook.substring(0, 50)}</option>`).join('');
  iSel.value = curI;
}

document.getElementById('form-script').addEventListener('submit', e => {
  e.preventDefault();
  const items = store.get('scripts');
  const editId = document.getElementById('script-edit-id').value;
  const item = {
    id: editId || uid(),
    title: document.getElementById('script-title').value.trim(),
    personaId: document.getElementById('script-persona').value,
    platform: document.getElementById('script-platform').value,
    inspirationId: document.getElementById('script-inspiration').value,
    hook: document.getElementById('script-hook').value.trim(),
    body: document.getElementById('script-body').value.trim(),
    cta: document.getElementById('script-cta').value.trim(),
    angle: document.getElementById('script-angle').value.trim(),
    createdAt: editId ? (items.find(i => i.id === editId)?.createdAt || Date.now()) : Date.now(),
  };
  if (editId) {
    items[items.findIndex(i => i.id === editId)] = item;
  } else {
    items.push(item);
  }
  store.set('scripts', items);
  clearScriptForm();
  renderScripts();
});

function clearScriptForm() {
  document.getElementById('script-edit-id').value = '';
  document.getElementById('form-script').reset();
}

document.getElementById('btn-clear-script').addEventListener('click', clearScriptForm);

function renderScripts() {
  const items = store.get('scripts');
  const el = document.getElementById('script-list');
  if (!items.length) {
    el.innerHTML = '<div class="empty-state"><span>No scripts yet.</span></div>';
    return;
  }
  const personas = store.get('personas');
  el.innerHTML = items.slice().reverse().map(s => {
    const persona = personas.find(p => p.id === s.personaId);
    return `
      <div class="card">
        <div class="card-body">
          <div class="card-title">${s.title}</div>
          <div class="script-card-hook">"${s.hook}"</div>
          <div class="card-meta" style="margin-top:6px">
            ${platformTag(s.platform)}
            ${persona ? `<span class="tag">${persona.name}</span>` : ''}
          </div>
        </div>
        <div class="card-actions">
          <button class="btn-icon" onclick="editScript('${s.id}')">✏️</button>
          <button class="btn-icon danger" onclick="deleteScript('${s.id}')">🗑</button>
        </div>
      </div>`;
  }).join('');
}

window.editScript = (id) => {
  const item = store.get('scripts').find(s => s.id === id);
  if (!item) return;
  document.getElementById('script-edit-id').value = id;
  document.getElementById('script-title').value = item.title;
  document.getElementById('script-persona').value = item.personaId || '';
  document.getElementById('script-platform').value = item.platform;
  document.getElementById('script-inspiration').value = item.inspirationId || '';
  document.getElementById('script-hook').value = item.hook;
  document.getElementById('script-body').value = item.body || '';
  document.getElementById('script-cta').value = item.cta || '';
  document.getElementById('script-angle').value = item.angle || '';
  window.scrollTo(0, 0);
};

window.deleteScript = (id) => {
  if (!confirm('Delete this script?')) return;
  store.set('scripts', store.get('scripts').filter(s => s.id !== id));
  renderScripts();
};

// ══════════════════════════════════════════
// PIPELINE
// ══════════════════════════════════════════
function populatePipelineSelects() {
  const personas = store.get('personas');
  const scripts = store.get('scripts');

  ['pipe-persona'].forEach(selId => {
    const sel = document.getElementById(selId);
    const cur = sel.value;
    sel.innerHTML = '<option value="">— Select Persona —</option>' +
      personas.map(p => `<option value="${p.id}">${p.name} · ${p.niche}</option>`).join('');
    sel.value = cur;
  });

  const sSel = document.getElementById('pipe-script');
  const curS = sSel.value;
  sSel.innerHTML = '<option value="">— Select Script (optional) —</option>' +
    scripts.map(s => `<option value="${s.id}">${s.title}</option>`).join('');
  sSel.value = curS;
}

document.getElementById('btn-add-pipeline').addEventListener('click', () => {
  document.getElementById('pipeline-modal-title').textContent = 'Add Content';
  document.getElementById('pipeline-edit-id').value = '';
  document.getElementById('form-pipeline').reset();
  populatePipelineSelects();
  openModal('modal-pipeline');
});

document.getElementById('form-pipeline').addEventListener('submit', e => {
  e.preventDefault();
  const items = store.get('pipeline');
  const editId = document.getElementById('pipeline-edit-id').value;
  const item = {
    id: editId || uid(),
    title: document.getElementById('pipe-title').value.trim(),
    personaId: document.getElementById('pipe-persona').value,
    platform: document.getElementById('pipe-platform').value,
    scriptId: document.getElementById('pipe-script').value,
    stage: document.getElementById('pipe-stage').value,
    notes: document.getElementById('pipe-notes').value.trim(),
    createdAt: editId ? (items.find(i => i.id === editId)?.createdAt || Date.now()) : Date.now(),
  };
  if (editId) {
    items[items.findIndex(i => i.id === editId)] = item;
  } else {
    items.push(item);
  }
  store.set('pipeline', items);
  closeModal('modal-pipeline');
  renderPipeline();
});

const STAGES = ['scripted', 'in-production', 'ready', 'live'];
const STAGE_LABELS = { 'scripted': 'Scripted', 'in-production': 'In Production', 'ready': 'Ready to Post', 'live': 'Live' };

function renderPipeline() {
  const items = store.get('pipeline');
  const personas = store.get('personas');

  STAGES.forEach(stage => {
    const col = document.getElementById('stage-' + stage);
    const stageItems = items.filter(i => i.stage === stage);
    if (!stageItems.length) { col.innerHTML = ''; return; }
    col.innerHTML = stageItems.map(item => {
      const persona = personas.find(p => p.id === item.personaId);
      const nextStage = STAGES[STAGES.indexOf(stage) + 1];
      const prevStage = STAGES[STAGES.indexOf(stage) - 1];
      return `
        <div class="kanban-card">
          <div class="kanban-card-title">${item.title}</div>
          <div class="kanban-card-meta">
            ${platformTag(item.platform)}
            ${persona ? `<span class="tag" style="margin-top:4px">${persona.name}</span>` : ''}
          </div>
          <div class="kanban-card-actions">
            ${prevStage ? `<button class="btn-stage" onclick="moveStage('${item.id}','${prevStage}')">← ${STAGE_LABELS[prevStage]}</button>` : ''}
            ${nextStage ? `<button class="btn-stage" onclick="moveStage('${item.id}','${nextStage}')">${STAGE_LABELS[nextStage]} →</button>` : ''}
            <button class="btn-stage" onclick="editPipelineItem('${item.id}')">✏️</button>
            <button class="btn-stage delete" onclick="deletePipelineItem('${item.id}')">Delete</button>
          </div>
        </div>`;
    }).join('');
  });
}

window.moveStage = (id, stage) => {
  const items = store.get('pipeline');
  const idx = items.findIndex(i => i.id === id);
  if (idx !== -1) { items[idx].stage = stage; store.set('pipeline', items); renderPipeline(); }
};

window.editPipelineItem = (id) => {
  const item = store.get('pipeline').find(i => i.id === id);
  if (!item) return;
  document.getElementById('pipeline-modal-title').textContent = 'Edit Content';
  document.getElementById('pipeline-edit-id').value = id;
  populatePipelineSelects();
  document.getElementById('pipe-title').value = item.title;
  document.getElementById('pipe-persona').value = item.personaId || '';
  document.getElementById('pipe-platform').value = item.platform;
  document.getElementById('pipe-script').value = item.scriptId || '';
  document.getElementById('pipe-stage').value = item.stage;
  document.getElementById('pipe-notes').value = item.notes || '';
  openModal('modal-pipeline');
};

window.deletePipelineItem = (id) => {
  if (!confirm('Delete this content item?')) return;
  store.set('pipeline', store.get('pipeline').filter(i => i.id !== id));
  renderPipeline();
};

// ── Init ──
renderDashboard();
