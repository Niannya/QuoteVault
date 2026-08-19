(() => {
  const post = (type, payload = {}) => window.chrome?.webview
    ? window.chrome.webview.postMessage({ type, payload })
    : console.log('[QuoteVault]', type, payload);

  let state = {
    people: [], categories: [], screenshots: [], settings: {}, selectedPersonId: null,
    selectedScreenshotId: null, topView: 'library', activePanel: 'preview'
  };
  let draft = null;
  let gridDensity = 1;
  let selectionMode = false;
  let selectedIds = new Set();
  let selectedMembers = new Map();
  let collapsedGroups = new Set();
  let editDirty = false;
  let windowState = 'normal';
  let dragPayload = null;
  let screenshotDragCandidate = null;
  // 截图统一使用 Win32 FileDrop 拖放：拖到 QQ 是真实图片文件，拖回左侧图库时
  // 由这份前端状态判断“移动 / Ctrl+复制”。这样图片、文字和卡片边框不会再有不同触发逻辑。
  let nativeScreenshotDrag = null;
  let suppressCardClickUntil = 0;
  let nextImportOcrEngine = null;
  let editTargetLibraryIds = [];
  let draftLibraryIds = [];
  let editTargetScreenshotId = null;
  let editDraftTags = null;
  let editDraftSearchText = null;
  let memberEditTargetId = null;
  let memberAvatarDraft = null;
  let memberEditDirty = false;
  let memberDragScrollHost = null;
  let memberDragPointerY = 0;
  let memberDragScrollRaf = 0;
  let layoutDrag = null;
  let hotkeyDraft = null;
  let stopHotkeyCapture = null;
  const ungroupedKey = '__ungrouped__';
  const layoutDefaults = { sidebar: 230, workbench: 340 };
  const layoutLimits = { sidebarMin: 170, sidebarMax: 420, workbenchMin: 260, workbenchMax: 360, centerMin: 320, splitters: 14 };

  const isMemberDrag = () => dragPayload?.kind === 'member' || dragPayload?.kind === 'members';
  function stopMemberDragAutoScroll() {
    if (memberDragScrollRaf) cancelAnimationFrame(memberDragScrollRaf);
    memberDragScrollRaf = 0;
    memberDragScrollHost = null;
  }
  function updateMemberDragAutoScroll(host, clientY) {
    if (!isMemberDrag()) return stopMemberDragAutoScroll();
    memberDragScrollHost = host;
    memberDragPointerY = clientY;
    if (memberDragScrollRaf) return;
    const step = () => {
      if (!isMemberDrag() || !memberDragScrollHost) return stopMemberDragAutoScroll();
      const r = memberDragScrollHost.getBoundingClientRect();
      const edge = 42;
      let dy = 0;
      if (memberDragPointerY < r.top + edge) dy = -Math.ceil((r.top + edge - memberDragPointerY) / 2.8);
      else if (memberDragPointerY > r.bottom - edge) dy = Math.ceil((memberDragPointerY - (r.bottom - edge)) / 2.8);
      dy = clamp(dy, -22, 22);
      if (dy) memberDragScrollHost.scrollTop += dy;
      memberDragScrollRaf = requestAnimationFrame(step);
    };
    memberDragScrollRaf = requestAnimationFrame(step);
  }

  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
  const selectedScreenshot = () => {
    const shot=state.screenshots.find(x=>x.id===state.selectedScreenshotId);
    if(!shot)return null;
    if(state.topView==='trash')return shot.deletedAt?shot:null;
    if(state.topView==='pending')return !shot.deletedAt&&shot.needsReview?shot:null;
    if(state.topView==='library')return state.selectedPersonId&&!shot.deletedAt&&!shot.needsReview&&screenshotLibraryIds(shot).includes(state.selectedPersonId)?shot:null;
    return null;
  };
  const memberById = id => state.people.find(x => x.id === id);
  const selectedMember = () => memberById(state.selectedPersonId);
  const screenshotLibraryIds = shot => Array.isArray(shot?.libraryIds) ? shot.libraryIds : [];
  const screenshotLibraries = shot => screenshotLibraryIds(shot).map(memberById).filter(Boolean);
  const screenshotLibraryLabel = shot => screenshotLibraries(shot).map(x=>x.displayName).join('、') || (shot?.needsReview ? '待处理' : '未选择图库');
  const keywords = value => String(value ?? '').split(/[,，;；]/).map(x => x.trim()).filter(Boolean);
  const hasFileDrag = event => [...(event.dataTransfer?.types || [])].includes('Files');
  const fmtDate = value => {
    const d = new Date(value);
    return Number.isNaN(d.valueOf()) ? '' : `${d.getMonth() + 1}月${d.getDate()}日`;
  };

  function bindImageFallbacks(root = document) {
    root.querySelectorAll?.('img[data-fallback-src]').forEach(img => {
      if (img.dataset.fallbackBound === '1') return;
      img.dataset.fallbackBound = '1';
      img.addEventListener('error', () => {
        const fallback = img.dataset.fallbackSrc;
        if (!fallback || img.dataset.fallbackUsed === '1') return;
        img.dataset.fallbackUsed = '1';
        img.src = fallback;
      });
    });
  }

  document.addEventListener('error', event => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    const fallback = img.dataset.fallbackSrc;
    if (!fallback || img.dataset.fallbackUsed === '1') return;
    img.dataset.fallbackUsed = '1';
    img.src = fallback;
  }, true);
  const checkSvg = '<svg viewBox="0 0 16 16"><path d="m3.5 8.2 2.8 2.8 6.2-6.2"/></svg>';
  const moreSvg = '<svg viewBox="0 0 18 18" width="17" height="17" fill="currentColor"><circle cx="4" cy="9" r="1.2"/><circle cx="9" cy="9" r="1.2"/><circle cx="14" cy="9" r="1.2"/></svg>';
  const starOutlineSvg = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m10 2.7 2.15 4.36 4.81.7-3.48 3.39.82 4.79L10 13.68l-4.3 2.26.82-4.79-3.48-3.39 4.81-.7L10 2.7Z"/></svg>';
  const starFilledSvg = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m10 2.7 2.15 4.36 4.81.7-3.48 3.39.82 4.79L10 13.68l-4.3 2.26.82-4.79-3.48-3.39 4.81-.7L10 2.7Z"/></svg>';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function applyTheme(value) {
    document.documentElement.dataset.theme=value==='light'?'light':'dark';
  }

  function fitLayout(sidebarWidth, workbenchWidth) {
    const workspace = document.querySelector('.workspace');
    const available = Math.max(
      layoutLimits.sidebarMin + layoutLimits.workbenchMin,
      (workspace?.clientWidth || 1120) - layoutLimits.splitters - layoutLimits.centerMin
    );
    let sidebar = clamp(Number(sidebarWidth) || layoutDefaults.sidebar, layoutLimits.sidebarMin, layoutLimits.sidebarMax);
    let workbench = clamp(Number(workbenchWidth) || layoutDefaults.workbench, layoutLimits.workbenchMin, layoutLimits.workbenchMax);
    let overflow = sidebar + workbench - available;
    if (overflow > 0) {
      const reduceWorkbench = Math.min(overflow, workbench - layoutLimits.workbenchMin);
      workbench -= reduceWorkbench;
      overflow -= reduceWorkbench;
      sidebar -= Math.min(overflow, sidebar - layoutLimits.sidebarMin);
    }
    return { sidebar: Math.round(sidebar), workbench: Math.round(workbench) };
  }

  function applyLayoutSettings(sidebarWidth = state.settings?.sidebarWidth, workbenchWidth = state.settings?.workbenchWidth) {
    const fitted = fitLayout(sidebarWidth, workbenchWidth);
    document.documentElement.style.setProperty('--sidebar-width', `${fitted.sidebar}px`);
    document.documentElement.style.setProperty('--workbench-width', `${fitted.workbench}px`);
    $('sidebarSplitter')?.setAttribute('aria-valuenow', fitted.sidebar);
    $('workbenchSplitter')?.setAttribute('aria-valuenow', fitted.workbench);
    return fitted;
  }

  function displayedLayout() {
    const workspace = document.querySelector('.workspace');
    const sidebarHidden = workspace?.classList.contains('sidebar-hidden');
    return {
      sidebar: sidebarHidden
        ? clamp(Number(state.settings?.sidebarWidth) || layoutDefaults.sidebar, layoutLimits.sidebarMin, layoutLimits.sidebarMax)
        : Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
      workbench: Math.round(document.querySelector('.workbench').getBoundingClientRect().width)
    };
  }

  function saveDisplayedLayout() {
    const current = displayedLayout();
    state.settings ??= {};
    state.settings.sidebarWidth = current.sidebar;
    state.settings.workbenchWidth = current.workbench;
    post('saveLayoutSettings', { sidebarWidth: current.sidebar, workbenchWidth: current.workbench });
  }

  function bindLayoutSplitter(node, target) {
    const finish = event => {
      if (!layoutDrag || layoutDrag.node !== node) return;
      if (node.hasPointerCapture?.(event.pointerId)) node.releasePointerCapture(event.pointerId);
      node.classList.remove('dragging');
      document.body.classList.remove('resizing-layout');
      layoutDrag = null;
      saveDisplayedLayout();
    };
    node.addEventListener('pointerdown', event => {
      if (event.button !== 0 || document.querySelector('.workspace').classList.contains('settings-mode')) return;
      const current = displayedLayout();
      layoutDrag = { node, target, pointerId: event.pointerId, startX: event.clientX, ...current };
      node.setPointerCapture?.(event.pointerId);
      node.classList.add('dragging');
      document.body.classList.add('resizing-layout');
      event.preventDefault();
    });
    node.addEventListener('pointermove', event => {
      if (!layoutDrag || layoutDrag.node !== node || layoutDrag.pointerId !== event.pointerId) return;
      const delta = event.clientX - layoutDrag.startX;
      const workspace = document.querySelector('.workspace');
      if (!workspace) return;
      const workspaceWidth = workspace.clientWidth;
      if (target === 'sidebar') {
        const max = workspaceWidth - layoutLimits.splitters - layoutLimits.centerMin - layoutDrag.workbench;
        applyLayoutSettings(clamp(layoutDrag.sidebar + delta, layoutLimits.sidebarMin, Math.min(layoutLimits.sidebarMax, max)), layoutDrag.workbench);
      } else {
        const effectiveSidebar = workspace.classList.contains('sidebar-hidden') ? 0 : layoutDrag.sidebar;
        const max = workspaceWidth - layoutLimits.splitters - layoutLimits.centerMin - effectiveSidebar;
        applyLayoutSettings(layoutDrag.sidebar, clamp(layoutDrag.workbench - delta, layoutLimits.workbenchMin, Math.min(layoutLimits.workbenchMax, max)));
      }
    });
    node.addEventListener('pointerup', finish);
    node.addEventListener('pointercancel', finish);
    node.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const current = displayedLayout();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      if (target === 'sidebar') applyLayoutSettings(current.sidebar + direction * 10, current.workbench);
      else applyLayoutSettings(current.sidebar, current.workbench - direction * 10);
      saveDisplayedLayout();
      event.preventDefault();
    });
  }

  function resetSelectionMode() {
    selectionMode = false; selectedIds.clear();
    $('batchMode')?.classList.remove('active');
    const cards = $('cards');
    cards?.classList.remove('selection-mode');
    cards?.querySelectorAll('.batch-selected').forEach(node => node.classList.remove('batch-selected'));
    if ($('batchbar')) renderBatchBar(visibleScreenshots());
  }

  function matchesScreenshot(shot, query, includeLibrary = false) {
    if (!query) return true;
    const haystack = `${shot.originalFileName}\n${shot.searchText||''}\n${(shot.tags||[]).join('\n')}${includeLibrary?`\n${screenshotLibraries(shot).map(x=>x.displayName).join('\n')}`:''}`;
    return haystack.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  }

  function ensureDynamicUi() {
    const toolbar = document.querySelector('.lib-toolbar');
    if (!$('batchMode')) {
      const button = document.createElement('button');
      button.id = 'batchMode'; button.className = 'iconbtn'; button.dataset.tooltip = '批量选择'; button.setAttribute('aria-label','批量选择');
      button.innerHTML = '<svg viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="2.5" width="13" height="13" rx="3"/><path d="m5.5 9 2.2 2.2 4.8-5"/></svg>';
      toolbar.insertBefore(button, $('gridDensityControl'));
      button.addEventListener('click', toggleSelectionMode);
    }
    if (!$('batchbar')) {
      const bar = document.createElement('div');
      bar.id = 'batchbar'; bar.className = 'batchbar';
      document.querySelector('.library-title').insertAdjacentElement('afterend', bar);
    }
    if (!$('settingsPage')) {
      const page = document.createElement('section');
      page.id = 'settingsPage'; page.className = 'settings-page';
      document.querySelector('.workspace').append(page);
    }
  }

  function ocrSummary(engine, confidence) {
    if (!engine) return '';
    if (engine === '未使用 OCR') return engine;
    return `${engine} · ${Math.round((confidence || 0) * 100)}%`;
  }

  function setBusy(value, text = '') {
    document.body.classList.toggle('loading', !!value);
    document.body.setAttribute('aria-busy', value ? 'true' : 'false');
    if (value && text) document.body.dataset.busyLabel = text;
    else delete document.body.dataset.busyLabel;
    let indicator = $('busyIndicator');
    if (value) {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'busyIndicator'; indicator.className = 'busy-indicator';
        indicator.setAttribute('role','status'); indicator.setAttribute('aria-live','polite');
        indicator.innerHTML = '<span class="busy-spinner"></span><span data-busy-text></span>';
        document.body.append(indicator);
      }
      indicator.querySelector('[data-busy-text]').textContent = text || '正在处理…';
    } else indicator?.remove();
  }

  function toast(message) {
    // Busy 状态与完成提示统一在右上角；完成时先收起 busy，避免两个提示叠在一起。
    $('busyIndicator')?.remove();
    document.querySelector('.toast')?.remove();
    const node = document.createElement('div');
    node.className = 'toast'; node.textContent = message;
    Object.assign(node.style, { position:'fixed', right:'22px', top:'58px', zIndex:260,
      background:'#242421', color:'#fff', padding:'11px 15px', borderRadius:'10px',
      boxShadow:'0 12px 35px #0005', fontSize:'12px', maxWidth:'min(420px,calc(100vw - 44px))' });
    document.body.append(node);
    setTimeout(() => node.remove(), 4200);
  }

  function showNotice(info) {
    modal(`<h2>${esc(info?.title||'提示')}</h2><p style="white-space:pre-wrap;line-height:1.7">${esc(info?.message||'')}</p><div class="modal-actions"><button class="btn primary" data-cancel>知道了</button></div>`);
  }

  function saveViewPreferences() {
    post('saveViewPreferences',{gridDensity,sidebarHidden:!!state.settings?.sidebarHidden,collapsedTreeNodes:[...collapsedGroups]});
  }

  function setSidebarHidden(hidden, persist = true) {
    state.settings ??= {};
    state.settings.sidebarHidden = !!hidden;
    document.querySelector('.workspace')?.classList.toggle('sidebar-hidden', !!hidden);
    const hideButton = $('sidebarToggle');
    if (hideButton) hideButton.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    const revealButton = $('sidebarReveal');
    if (revealButton) revealButton.hidden = !hidden;
    if (persist) saveViewPreferences();
  }

  function closeFloating() {
    document.querySelector('.context-menu')?.remove();
    document.querySelector('.app-tooltip')?.remove();
    document.querySelectorAll('[aria-expanded="true"]').forEach(node => node.setAttribute('aria-expanded','false'));
  }

  function showTooltip(anchor, message) {
    document.querySelector('.app-tooltip')?.remove();
    if (!message) return;
    const tooltip = document.createElement('div');
    tooltip.className = 'app-tooltip';
    tooltip.textContent = message;
    document.body.append(tooltip);
    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const left = Math.max(10, Math.min(innerWidth - tooltipRect.width - 10, anchorRect.left + (anchorRect.width - tooltipRect.width) / 2));
    let top = anchorRect.bottom + 8;
    if (top + tooltipRect.height > innerHeight - 10) top = anchorRect.top - tooltipRect.height - 8;
    Object.assign(tooltip.style, { left: `${left}px`, top: `${top}px` });
  }

  function showMenu(x, y, items, minimumWidth = 176) {
    closeFloating();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.minWidth = `${minimumWidth}px`;
    menu.innerHTML = items.map((item, i) => item.separator
      ? `<div class="separator"></div>`
      : `<button data-menu="${i}" class="${item.danger ? 'danger' : ''}${item.description ? ' menu-with-description' : ''}"${item.tooltip?` data-tooltip="${esc(item.tooltip)}"`:''}>${item.checked===undefined?'':`<span class="menu-check">${item.checked?checkSvg:''}</span>`}<span class="menu-copy"><span>${esc(item.label)}</span>${item.description?`<small>${esc(item.description)}</small>`:''}</span></button>`).join('');
    document.body.append(menu);
    menu.querySelectorAll('[data-menu]').forEach(button => button.addEventListener('click', event => {
      event.stopPropagation();
      const item = items[Number(button.dataset.menu)];
      closeFloating(); item.action?.();
    }));
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8))}px`;
  }

  function modal(html, onReady) {
    document.querySelector('.modal-layer')?.remove();
    const layer = document.createElement('div');
    layer.className = 'modal-layer'; layer.innerHTML = `<div class="inline-modal">${html}</div>`;
    document.body.append(layer);
    layer.addEventListener('mousedown', event => { if (event.target === layer&&!layer.classList.contains('locked')) layer.remove(); });
    layer.querySelector('[data-cancel]')?.addEventListener('click', () => layer.remove());
    onReady?.(layer);
    return layer;
  }

  function screenshotViewerDetails(shot, overrides = {}) {
    return {
      id: shot?.id ?? null,
      title: overrides.title ?? shot?.originalFileName ?? '截图',
      date: overrides.date ?? (shot?.importedAt ? new Date(shot.importedAt).toLocaleString('zh-CN') : ''),
      libraryName: overrides.libraryName ?? screenshotLibraryLabel(shot),
      engine: overrides.engine ?? shot?.ocrEngine ?? '',
      confidence: overrides.confidence ?? shot?.confidence ?? 0,
      searchText: overrides.searchText ?? shot?.searchText ?? '',
      tags: overrides.tags ?? shot?.tags ?? [],
      isFavorite: overrides.isFavorite ?? !!shot?.isFavorite
    };
  }

  function showImageViewer(src, details = {}) {
    closeFloating();
    document.querySelector('.image-viewer')?.remove();
    const tags = Array.isArray(details.tags) ? details.tags : [];
    const text = String(details.searchText ?? '').trim();
    const engine = details.engine ? ocrSummary(details.engine, details.confidence) : '';
    const layer=document.createElement('div');
    layer.className='image-viewer';
    layer.innerHTML=`<div class="image-viewer-shell">
      <header class="image-viewer-topbar">
        <div class="viewer-top-spacer"></div>
        <div class="viewer-title">${esc(details.title||'截图')}</div>
        <button type="button" class="image-viewer-close" aria-label="关闭" data-tooltip="关闭">×</button>
      </header>
      <section class="image-viewer-media">
        <div class="image-viewer-scroll"><div class="viewer-image-stage"><img src="${esc(src)}" alt="${esc(details.title||'截图')}" draggable="false"/></div></div>
      </section>
      <aside class="image-viewer-info">
        <div class="viewer-info-content">
          ${details.date?`<div class="viewer-date">${esc(details.date)}</div>`:''}
          <div class="viewer-info-list">
            ${details.libraryName?`<div class="viewer-info-row"><span>存放图库</span><b>${esc(details.libraryName)}</b></div>`:''}
            ${engine?`<div class="viewer-info-row"><span>OCR</span><b>${esc(engine)}</b></div>`:''}
          </div>
          <section class="viewer-info-section"><h3>可搜索文本</h3><div class="viewer-text">${text?esc(text):'<span class="muted">未填写可搜索文本</span>'}</div></section>
          <section class="viewer-info-section"><h3>标签</h3><div class="viewer-tags">${tags.length?tags.map(tag=>`<span class="chip">#${esc(tag)}</span>`).join(''):'<span class="muted">无标签</span>'}</div></section>
        </div>
      </aside>
      <footer class="image-viewer-toolbar">
        <div class="viewer-toolbar-left">
          ${details.id?`<button type="button" class="viewer-tool viewer-favorite ${details.isFavorite?'active':''}" data-viewer-favorite="${esc(details.id)}" aria-pressed="${details.isFavorite?'true':'false'}">${details.isFavorite?starFilledSvg:starOutlineSvg}<span>${details.isFavorite?'已收藏':'收藏'}</span></button>`:''}
        </div>
        <div class="viewer-zoom-controls" aria-label="图片缩放">
          <span class="viewer-zoom-value" data-viewer-zoom-value>100%</span>
          <button type="button" class="viewer-zoom-button" data-viewer-zoom-out aria-label="缩小" data-tooltip="缩小"><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="8" cy="8" r="5.25"/><path d="M4.9 8h6.2M12 12l3 3"/></svg></button>
          <input class="viewer-zoom-slider" data-viewer-zoom type="range" min="10" max="400" step="1" value="100" aria-label="缩放图片"/>
          <button type="button" class="viewer-zoom-button" data-viewer-zoom-in aria-label="放大" data-tooltip="放大"><svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="8" cy="8" r="5.25"/><path d="M4.9 8h6.2M8 4.9v6.2M12 12l3 3"/></svg></button>
        </div>
        <button type="button" class="viewer-tool viewer-copy" data-viewer-copy><svg viewBox="0 0 18 18" aria-hidden="true"><rect x="6" y="5" width="8" height="9" rx="1.5"/><path d="M4 12H3.5A1.5 1.5 0 0 1 2 10.5v-7A1.5 1.5 0 0 1 3.5 2h7A1.5 1.5 0 0 1 12 3.5V4"/></svg><span>复制到剪贴板</span></button>
      </footer>
    </div>`;
    document.body.append(layer);

    const scroll=layer.querySelector('.image-viewer-scroll');
    const image=layer.querySelector('.viewer-image-stage img');
    const slider=layer.querySelector('[data-viewer-zoom]');
    const zoomValue=layer.querySelector('[data-viewer-zoom-value]');
    let zoomPercent=100;
    let manuallyZoomed=false;
    let resizeObserver=null;

    const clampZoom=value=>Math.max(10,Math.min(400,Number(value)||100));
    const calculateFitZoom=()=>{
      if(!image.naturalWidth||!image.naturalHeight)return 100;
      const availableWidth=Math.max(1,scroll.clientWidth-28);
      const availableHeight=Math.max(1,scroll.clientHeight-28);
      return clampZoom(Math.min(100,availableWidth/image.naturalWidth*100,availableHeight/image.naturalHeight*100));
    };
    const applyZoom=(value,{preserveCenter=true}={})=>{
      const next=clampZoom(value);
      const old=zoomPercent||next;
      const oldWidth=image.clientWidth;
      const oldHeight=image.clientHeight;
      const wasContained=oldWidth<=scroll.clientWidth&&oldHeight<=scroll.clientHeight;
      const centerX=scroll.scrollLeft+scroll.clientWidth/2;
      const centerY=scroll.scrollTop+scroll.clientHeight/2;
      zoomPercent=next;
      image.style.width=`${Math.max(1,image.naturalWidth*next/100)}px`;
      image.style.height=`${Math.max(1,image.naturalHeight*next/100)}px`;
      slider.value=String(Math.round(next));
      zoomValue.textContent=`${Math.round(next)}%`;
      if(!preserveCenter)return;
      requestAnimationFrame(()=>{
        if(wasContained){
          scroll.scrollLeft=Math.max(0,(scroll.scrollWidth-scroll.clientWidth)/2);
          scroll.scrollTop=Math.max(0,(scroll.scrollHeight-scroll.clientHeight)/2);
        }else{
          const ratio=next/old;
          scroll.scrollLeft=Math.max(0,centerX*ratio-scroll.clientWidth/2);
          scroll.scrollTop=Math.max(0,centerY*ratio-scroll.clientHeight/2);
        }
      });
    };
    const fitImage=()=>applyZoom(calculateFitZoom(),{preserveCenter:false});
    const initializeZoom=()=>{
      fitImage();
      resizeObserver=new ResizeObserver(()=>{if(!manuallyZoomed)fitImage();});
      resizeObserver.observe(scroll);
    };
    if(image.complete&&image.naturalWidth)initializeZoom();else image.addEventListener('load',initializeZoom,{once:true});

    slider.addEventListener('input',()=>{manuallyZoomed=true;applyZoom(slider.value);});
    layer.querySelector('[data-viewer-zoom-out]').addEventListener('click',()=>{manuallyZoomed=true;applyZoom(zoomPercent-10);});
    layer.querySelector('[data-viewer-zoom-in]').addEventListener('click',()=>{manuallyZoomed=true;applyZoom(zoomPercent+10);});
    scroll.addEventListener('wheel',event=>{
      event.preventDefault();
      manuallyZoomed=true;
      const direction=event.deltaY<0?1:-1;
      const step=Math.max(5,Math.round(zoomPercent*0.1));
      applyZoom(zoomPercent+direction*step);
    },{passive:false});

    const close=()=>{resizeObserver?.disconnect();document.removeEventListener('keydown',onKey);layer.remove();};
    const onKey=event=>{if(event.key==='Escape')close();};
    layer.querySelector('.image-viewer-close').onclick=close;
    layer.querySelector('[data-viewer-copy]')?.addEventListener('click',event=>{
      event.stopPropagation();
      if(details.id)post('copyImage',{id:details.id});
      else post('copyDataUrlImage',{dataUrl:src});
    });
    layer.querySelector('[data-viewer-favorite]')?.addEventListener('click',event=>{
      event.stopPropagation();
      post('toggleFavorite',{id:event.currentTarget.dataset.viewerFavorite});
    });
    document.addEventListener('keydown',onKey);
  }

  function askConfirm(title, text, action, danger = false, confirmLabel = '确定') {
    modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="modal-actions"><button class="btn" data-cancel>取消</button><button class="btn ${danger ? 'danger' : 'primary'}" data-confirm>${esc(confirmLabel)}</button></div>`, layer => {
      layer.querySelector('[data-confirm]').addEventListener('click', () => { layer.remove(); action(); });
    });
  }

  function ocrEngineChoices() {
    return [
      {value:'None',label:'不使用 OCR'},
      {value:'PaddleOcrV6',label:`PaddleOCR v6${state.settings?.paddleAvailable?'':' · 未安装'}`,tooltip:'可选 OCR，约占用 900 MB，中文识别精度高'}
    ];
  }

  function customSelectMarkup(id, options, selected, className = '', ariaLabel = '选择选项') {
    const current=options.find(option=>option.value===selected)??options[0];
    return `<button type="button" class="custom-select ${className}" id="${id}" value="${esc(current.value)}" aria-label="${esc(ariaLabel)}" aria-haspopup="menu" aria-expanded="false"${current.tooltip?` data-tooltip="${esc(current.tooltip)}"`:''}><span>${esc(current.label)}</span><svg viewBox="0 0 14 14"><path d="m3.5 5.25 3.5 3.5 3.5-3.5"/></svg></button>`;
  }

  function setCustomSelectValue(button, option) {
    button.value=option.value;
    button.querySelector('span').textContent=option.label;
    if(option.tooltip)button.dataset.tooltip=option.tooltip;else delete button.dataset.tooltip;
  }

  function bindCustomSelect(id, options, onChange, commitSelection = true) {
    const button=$(id); if(!button)return;
    button.onclick=event=>{
      if(button.getAttribute('aria-expanded')==='true'&&document.querySelector('.context-menu')){
        closeFloating();event.stopPropagation();return;
      }
      const rect=button.getBoundingClientRect();
      const items=options.map(option=>({label:option.label,tooltip:option.tooltip,checked:option.value===button.value,action:()=>{if(commitSelection)setCustomSelectValue(button,option);onChange?.(option.value);}}));
      showMenu(rect.left,rect.bottom+5,items,Math.max(176,rect.width));
      button.setAttribute('aria-expanded','true');
      event.stopPropagation();
    };
  }

  function hotkeyFromSettings(settings) {
    return {ctrl:!!settings.hotKeyCtrl,alt:!!settings.hotKeyAlt,shift:!!settings.hotKeyShift,key:settings.hotKey||'Q'};
  }

  function hotkeyMainLabel(key) {
    return /^D[0-9]$/.test(key||'') ? key.slice(1) : key;
  }

  function hotkeyLabel(value) {
    return [value.ctrl?'Ctrl':'',value.alt?'Alt':'',value.shift?'Shift':'',hotkeyMainLabel(value.key)].filter(Boolean).join(' + ');
  }

  function capturedMainKey(event) {
    if(/^Key[A-Z]$/.test(event.code))return event.code.slice(3);
    if(/^Digit[0-9]$/.test(event.code))return `D${event.code.slice(5)}`;
    if(/^F([1-9]|1[0-2])$/.test(event.key))return event.key;
    return null;
  }

  function beginHotkeyCapture(button) {
    stopHotkeyCapture?.();
    const previous={...hotkeyDraft};
    const hint=$('hotKeyHint');
    button.classList.add('recording');
    button.querySelector('b').textContent='请按下新的快捷键…';
    hint.textContent='按 Esc 取消；支持字母、数字和 F1–F12';
    const finish=(restore=false)=>{
      document.removeEventListener('keydown',onKeyDown,true);
      document.removeEventListener('pointerdown',onOutside,true);
      button.classList.remove('recording');
      if(restore)hotkeyDraft=previous;
      button.querySelector('b').textContent=hotkeyLabel(hotkeyDraft);
      hint.textContent='点击快捷键框，然后直接按下新的组合键。';
      stopHotkeyCapture=null;
    };
    const onKeyDown=event=>{
      event.preventDefault();event.stopImmediatePropagation();
      if(event.key==='Escape'){finish(true);return;}
      if(['Control','Alt','Shift','Meta'].includes(event.key))return;
      const key=capturedMainKey(event);
      if(!key){toast('仅支持字母、数字或 F1–F12。');return;}
      if(!event.ctrlKey&&!event.altKey&&!event.shiftKey){toast('快捷键至少需要 Ctrl、Alt 或 Shift 中的一项。');return;}
      hotkeyDraft={ctrl:event.ctrlKey,alt:event.altKey,shift:event.shiftKey,key};
      finish();
    };
    const onOutside=event=>{if(!button.contains(event.target))finish(true);};
    document.addEventListener('keydown',onKeyDown,true);
    setTimeout(()=>document.addEventListener('pointerdown',onOutside,true),0);
    stopHotkeyCapture=()=>finish(true);
  }

  function showPaddleGuidePrompt() {
    modal(`<h2>获取 PaddleOCR</h2><p>PaddleOCR 是可选的本地 OCR。请前往 QuoteVault 的 GitHub 页面查看安装说明与下载方式。</p><div class="install-facts"><div><b>预计空间</b><span>约 900 MB</span></div><div><b>识别能力</b><span>适合中文和复杂聊天截图</span></div><div><b>数据处理</b><span>安装后在本机识别，不上传截图</span></div></div><div class="modal-actions"><button class="btn" data-cancel>取消</button><button class="btn primary" data-open-guide>打开 GitHub</button></div>`,layer=>{
      layer.querySelector('[data-open-guide]').onclick=()=>{layer.remove();post('openPaddleOcrGuide');};
    });
  }

  function requestOcrChange(engine, target='settings', id=null, confirmOverwrite=false, onAccepted=null) {
    const payload={engine,target,id};
    const apply=()=>{
      if(engine==='PaddleOcrV6'&&!state.settings?.paddleAvailable){
        showPaddleGuidePrompt();
      } else {onAccepted?.();post('setOcrEngine',payload);}
    };
    if(confirmOverwrite) askConfirm('重新识别截图','切换识别方式会重新识别当前截图，并替换当前的可搜索文本。是否继续？',apply,false,'切换并识别');
    else apply();
  }

  function groupPath(group) {
    const names = [group.name]; let current = group;
    while (current?.parentId) {
      current = state.categories.find(x => x.id === current.parentId);
      if (current) names.unshift(current.name);
    }
    return names.join(' / ');
  }

  function openCreateMenu(anchor, groupId = null) {
    const rect = anchor?.getBoundingClientRect?.() ?? { left: 18, bottom: 120 };
    showMenu(rect.left, rect.bottom + 5, [
      { label: groupId ? '新建子群组' : '新建群组', action: () => openGroupModal(null, groupId) },
      { label: '新建成员', action: () => openMemberModal(null, groupId) }
    ]);
  }

  function openGroupModal(group = null, parentId = null) {
    modal(`<h2>${group ? '重命名群组' : parentId ? '新建子群组' : '新建群组'}</h2><p>群组用于整理成员图库，可以继续创建子群组。</p><div class="modal-field"><label>群组名称</label><input id="entityName" value="${esc(group?.name || '')}" autofocus /></div><div class="modal-actions"><button class="btn" data-cancel>取消</button><button class="btn primary" data-save>${group ? '保存' : '创建'}</button></div>`, layer => {
      const save = () => {
        const name = $('entityName').value.trim(); if (!name) return $('entityName').focus();
        post(group ? 'updateGroup' : 'createGroup', group ? { id: group.id, name } : { name, parentId }); layer.remove();
      };
      layer.querySelector('[data-save]').addEventListener('click', save);
      $('entityName').addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    });
  }

  function openMemberModal(member = null, defaultGroupId = null) {
    if (member) return openMemberEditor(member);
    const checked = new Set(defaultGroupId ? [defaultGroupId] : []);
    const checks = state.categories.map(group => `<label class="group-check"><input type="checkbox" value="${group.id}" ${checked.has(group.id) ? 'checked' : ''}/><span>${esc(groupPath(group))}</span></label>`).join('') || '<span class="muted">尚未创建群组；成员将暂时显示在“未分组”。</span>';
    modal(`<h2>新建成员</h2><p>成员就是一个截图图库；创建后可以在编辑页补充头像、QQ号和备注。</p><div class="modal-field"><label>ID</label><input id="entityName" value="" autofocus /></div><div class="modal-field"><label>加入群组</label><div class="group-checks">${checks}</div></div><div class="modal-actions"><button class="btn" data-cancel>取消</button><button class="btn primary" data-save>创建图库</button></div>`, layer => {
      const save = () => {
        const name = $('entityName').value.trim(); if (!name) return $('entityName').focus();
        const groupIds = [...layer.querySelectorAll('.group-check input:checked')].map(x => x.value);
        post('createMember', { name, groupIds }); layer.remove();
      };
      layer.querySelector('[data-save]').addEventListener('click', save);
      $('entityName').addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    });
  }

  function openMemberEditor(member) {
    if (!member) return;
    memberEditTargetId = member.id;
    memberAvatarDraft = member.avatarDataUrl || '';
    memberEditDirty = false;
    state.selectedPersonId = member.id;
    state.selectedScreenshotId = null;
    clearMemberSelection(false);
    resetSelectionMode();
    post('editMember', { id: member.id });
    setActivePanel('edit', true);
  }

  function renderMemberEditor(host, member) {
    if (!member) return emptyPanel(host, '选择一个成员图库', '选择成员后可以编辑头像、ID、QQ号和备注。');
    if (memberEditTargetId !== member.id) {
      memberEditTargetId = member.id;
      memberAvatarDraft = member.avatarDataUrl || '';
      memberEditDirty = false;
    }
    const palette = ['a1','a2','a3','a4','a5'];
    const cls = palette[Math.abs(hash(member.id)) % palette.length];
    const avatar = memberAvatarDraft
      ? `<img src="${esc(memberAvatarDraft)}" alt="成员头像"/>`
      : `<span class="avatar ${cls}">${esc(member.displayName.slice(0,1) || '?')}</span>`;
    const memberGroups = new Set(member.categoryIds || []);
    const groupChecks = state.categories.length
      ? state.categories.map(group => `<label class="member-group-check"><input type="checkbox" value="${group.id}" ${memberGroups.has(group.id)?'checked':''}/><span>${esc(groupPath(group))}</span></label>`).join('')
      : '<span class="muted member-group-empty">尚未创建群组</span>';
    host.innerHTML=`<div class="panel-header"><h2>编辑成员</h2><span class="muted">成员资料仅保存在本机</span></div><div class="member-profile-head"><div class="member-avatar-large" id="memberAvatarPreview">${avatar}</div><div class="member-avatar-actions"><button class="btn" id="chooseMemberAvatar">选择头像</button><button class="btn" id="clearMemberAvatar" ${memberAvatarDraft?'':'disabled'}>恢复默认</button></div></div><div class="formrow"><label>ID</label><input class="field" id="memberDisplayName" maxlength="80" value="${esc(member.displayName||'')}"/></div><div class="formrow"><label>QQ号</label><input class="field" id="memberQqNumber" maxlength="40" value="${esc(member.qqNumber||'')}" inputmode="numeric"/></div><div class="formrow"><label>备注</label><textarea class="field textarea member-note" id="memberNote" maxlength="1000">${esc(member.note||'')}</textarea></div><div class="formrow"><label>群组</label><div class="member-group-checks" id="memberGroupChecks">${groupChecks}</div></div><div class="actions"><button class="btn" id="cancelMemberEdit">取消</button><button class="btn primary" id="saveMemberEdit">保存修改</button></div>`;
    const markDirty=()=>{memberEditDirty=true;};
    ['memberDisplayName','memberQqNumber','memberNote'].forEach(id=>$(id).addEventListener('input',markDirty));
    $('memberGroupChecks')?.querySelectorAll('input[type="checkbox"]').forEach(input=>input.addEventListener('change',markDirty));
    $('chooseMemberAvatar').onclick=()=>post('chooseMemberAvatar');
    $('clearMemberAvatar').onclick=()=>{memberAvatarDraft='';memberEditDirty=true;const palette=['a1','a2','a3','a4','a5'];const cls=palette[Math.abs(hash(member.id))%palette.length];$('memberAvatarPreview').innerHTML=`<span class="avatar ${cls}">${esc(($('memberDisplayName').value||member.displayName||'?').slice(0,1))}</span>`;$('clearMemberAvatar').disabled=true;};
    $('cancelMemberEdit').onclick=()=>{memberEditDirty=false;memberEditTargetId=null;memberAvatarDraft=null;setActivePanel('preview',true);};
    $('saveMemberEdit').onclick=()=>{
      const name=$('memberDisplayName').value.trim();if(!name)return $('memberDisplayName').focus();
      const groupIds=[...($('memberGroupChecks')?.querySelectorAll('input[type="checkbox"]:checked')||[])].map(x=>x.value);
      post('updateMember',{id:member.id,name,qqNumber:$('memberQqNumber').value,note:$('memberNote').value,avatarDataUrl:memberAvatarDraft||'',groupIds});
      memberEditDirty=false;memberEditTargetId=null;memberAvatarDraft=null;setActivePanel('preview',true);
    };
  }

  function updateMemberSelectionHeading() {
    const heading = document.querySelector('.sidehead b');
    if (!heading) return;
    const active = selectedMembers.size > 0;
    heading.textContent = active ? `已选 ${selectedMembers.size} 个成员` : '成员图库';
  }

  function clearMemberSelection(updateUi = true) {
    selectedMembers.clear();
    if (!updateUi) return;
    document.querySelectorAll('.friend.member-batch-selected').forEach(node => node.classList.remove('member-batch-selected'));
    updateMemberSelectionHeading();
  }

  function confirmDeleteSelectedMembers() {
    const ids=[...selectedMembers.keys()];
    if(!ids.length)return;
    askConfirm('删除成员',`删除所选 ${ids.length} 个成员？其中的截图不会被删除，而会转入待处理。`,()=>{post('deleteMembers',{ids});clearMemberSelection();},true,`删除 ${ids.length} 个`);
  }

  function bindMemberMarqueeSelection(host) {
    host.onpointerdown = event => {
      if (event.button !== 0 || event.target.closest('[data-person],[data-group],[data-ungrouped],button,input,a')) return;
      event.preventDefault();
      const pointerId = event.pointerId;
      const hostRect = () => host.getBoundingClientRect();
      const initialRect = hostRect();
      const start = {
        x: event.clientX - initialRect.left + host.scrollLeft,
        y: event.clientY - initialRect.top + host.scrollTop
      };
      const startClient = { x: event.clientX, y: event.clientY };
      const base = event.ctrlKey ? new Map(selectedMembers) : new Map();
      let active = false;
      let rectNode = null;
      let lastClientX = event.clientX;
      let lastClientY = event.clientY;
      let rafId = 0;

      try { host.setPointerCapture?.(pointerId); } catch {}

      const updateSelection = () => {
        if (!active) return;
        const r = hostRect();
        const currentClientX = clamp(lastClientX, r.left, r.right);
        const currentClientY = clamp(lastClientY, r.top, r.bottom);
        const current = {
          x: currentClientX - r.left + host.scrollLeft,
          y: currentClientY - r.top + host.scrollTop
        };
        const left = Math.min(start.x, current.x), top = Math.min(start.y, current.y);
        const right = Math.max(start.x, current.x), bottom = Math.max(start.y, current.y);

        // 选框起点固定在按下鼠标时的“内容位置”，而不是固定在屏幕像素上。
        // 滚动时它会随同内容离开视口，行为与文件资源管理器一致。
        const startViewportX = r.left + start.x - host.scrollLeft;
        const startViewportY = r.top + start.y - host.scrollTop;
        const rawLeft = Math.min(startViewportX, currentClientX);
        const rawTop = Math.min(startViewportY, currentClientY);
        const rawRight = Math.max(startViewportX, currentClientX);
        const rawBottom = Math.max(startViewportY, currentClientY);
        const visualLeft = clamp(rawLeft, r.left, r.right);
        const visualTop = clamp(rawTop, r.top, r.bottom);
        const visualRight = clamp(rawRight, r.left, r.right);
        const visualBottom = clamp(rawBottom, r.top, r.bottom);
        Object.assign(rectNode.style, {
          left: `${visualLeft}px`,
          top: `${visualTop}px`,
          width: `${Math.max(0, visualRight - visualLeft)}px`,
          height: `${Math.max(0, visualBottom - visualTop)}px`
        });

        selectedMembers = new Map(base);
        host.querySelectorAll('.friend[data-person]').forEach(node => {
          const nr = node.getBoundingClientRect();
          const nodeLeft = nr.left - r.left + host.scrollLeft;
          const nodeTop = nr.top - r.top + host.scrollTop;
          const nodeRight = nodeLeft + nr.width;
          const nodeBottom = nodeTop + nr.height;
          const hit = nodeLeft < right && nodeRight > left && nodeTop < bottom && nodeBottom > top;
          if (hit) selectedMembers.set(node.dataset.person, node.dataset.sourceGroup || null);
          node.classList.toggle('member-batch-selected', selectedMembers.has(node.dataset.person));
        });
        updateMemberSelectionHeading();
      };

      const autoScroll = () => {
        if (!active) return;
        const r = hostRect();
        const edge = 34;
        let dy = 0;
        if (lastClientY < r.top + edge) dy = -Math.ceil((r.top + edge - lastClientY) / 3);
        else if (lastClientY > r.bottom - edge) dy = Math.ceil((lastClientY - (r.bottom - edge)) / 3);
        dy = clamp(dy, -18, 18);
        if (dy) host.scrollTop += dy;
        rafId = requestAnimationFrame(autoScroll);
      };

      const move = e => {
        if (e.pointerId !== pointerId) return;
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        if (!active && Math.hypot(e.clientX - startClient.x, e.clientY - startClient.y) < 4) return;
        if (!active) {
          active = true;
          rectNode = document.createElement('div');
          rectNode.className = 'selection-rect';
          document.body.append(rectNode);
          host.addEventListener('scroll', updateSelection, { passive: true });
          rafId = requestAnimationFrame(autoScroll);
        }
        updateSelection();
      };
      const up = e => {
        if (e.pointerId !== pointerId) return;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        host.removeEventListener('scroll', updateSelection);
        cancelAnimationFrame(rafId);
        try { host.releasePointerCapture?.(pointerId); } catch {}
        rectNode?.remove();
        if (!active && !event.ctrlKey) clearMemberSelection();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    };
  }

  function libraryScreenshotCount(personId) {
    return state.screenshots.filter(x => !x.deletedAt && !x.needsReview && screenshotLibraryIds(x).includes(personId)).length;
  }

  function renderTree() {
    $('trashCount').textContent = state.screenshots.filter(x => x.deletedAt).length;
    $('pendingCount').textContent = state.screenshots.filter(x => !x.deletedAt && x.needsReview).length;
    $('trashNav').classList.toggle('active', state.topView === 'trash');
    $('pendingNav').classList.toggle('active', state.topView === 'pending');
    const host = $('peopleTree');
    const query = $('sideSearch').value.trim().toLocaleLowerCase();
    const memberMatches = person => !query || `${person.displayName||''} ${person.qqNumber||''} ${person.note||''}`.toLocaleLowerCase().includes(query);
    const personHtml = (person, sourceGroupId = '') => {
      const count = libraryScreenshotCount(person.id);
      const palette = ['a1','a2','a3','a4','a5']; const cls = palette[Math.abs(hash(person.id)) % palette.length];
      const selectedClass = selectedMembers.has(person.id) ? ' member-batch-selected' : '';
      const avatar = person.avatarDataUrl ? `<span class="avatar member-avatar-image"><img src="${esc(person.avatarDataUrl)}" alt=""/></span>` : `<span class="avatar ${cls}">${esc(person.displayName.slice(0,1) || '?')}</span>`;
      return `<div class="friend ${state.selectedPersonId === person.id && state.topView === 'library' ? 'active' : ''}${selectedClass}" draggable="true" data-person="${person.id}" data-source-group="${sourceGroupId}">${avatar}<span>${esc(person.displayName)}</span><span class="count">${count}</span><span class="member-check" aria-hidden="true">${checkSvg}</span></div>`;
    };
    const categoryHtml = (group, depth = 0) => {
      const assigned = state.people.filter(x => x.categoryIds.includes(group.id) && memberMatches(x));
      const children = state.categories.filter(x => x.parentId === group.id);
      const nested = children.map(x => categoryHtml(x, depth + 1)).join('');
      const groupMatches = !query || group.name.toLocaleLowerCase().includes(query);
      const visibleAssigned = groupMatches && query ? state.people.filter(x=>x.categoryIds.includes(group.id)) : assigned;
      if (query && !groupMatches && !assigned.length && !nested) return '';
      const collapsed = collapsedGroups.has(group.id);
      return `<div class="group" style="margin-left:${depth * 9}px" data-group-wrap="${group.id}"><div class="group-title" data-group="${group.id}"><span class="chev">${collapsed ? '▶' : '▼'}</span>${esc(group.name)}</div><div class="group-content ${collapsed ? 'hidden' : ''}">${visibleAssigned.map(x=>personHtml(x,group.id)).join('')}${nested}</div></div>`;
    };
    const roots = state.categories.filter(x => !x.parentId).map(x => categoryHtml(x)).join('');
    const ungrouped = state.people.filter(x => !x.categoryIds.length && memberMatches(x));
    const ungroupedCollapsed = collapsedGroups.has(ungroupedKey);
    const other = ungrouped.length ? `<div class="group" data-group-wrap="${ungroupedKey}"><div class="group-title" data-ungrouped><span class="chev">${ungroupedCollapsed?'▶':'▼'}</span>未分组</div><div class="group-content ${ungroupedCollapsed?'hidden':''}">${ungrouped.map(x=>personHtml(x,'')).join('')}</div></div>` : '';
    const globalMatches = query ? state.screenshots.filter(x=>!x.deletedAt && matchesScreenshot(x,query,true)).slice(0,8) : [];
    const global = query ? `<div class="global-results"><div class="global-results-title">全局截图 · ${globalMatches.length}${globalMatches.length===8?'＋':''}</div>${globalMatches.map(shot=>`<button class="global-shot" data-global-shot="${shot.id}"><b>${esc((shot.searchText||'').split('\n').find(Boolean)||shot.originalFileName)}</b><span>${esc(screenshotLibraryLabel(shot))}</span></button>`).join('')||'<div class="muted" style="padding:8px">未找到匹配截图</div>'}</div>` : '';
    host.innerHTML = (roots + other || (!query?'<div class="muted" style="padding:14px 9px">尚未创建成员</div>':'')) + global;
    host.querySelector('[data-ungrouped]')?.addEventListener('click',()=>{collapsedGroups.has(ungroupedKey)?collapsedGroups.delete(ungroupedKey):collapsedGroups.add(ungroupedKey);saveViewPreferences();renderTree();});
    host.querySelectorAll('[data-global-shot]').forEach(node=>node.onclick=()=>{resetSelectionMode();clearMemberSelection();memberEditTargetId=null;memberAvatarDraft=null;memberEditDirty=false;post('selectGlobalScreenshot',{id:node.dataset.globalShot});});
    host.querySelectorAll('[data-person]').forEach(node => {
      node.addEventListener('click', e => {
        if (e.ctrlKey) {
          if (selectedMembers.has(node.dataset.person)) selectedMembers.delete(node.dataset.person);
          else selectedMembers.set(node.dataset.person, node.dataset.sourceGroup || null);
          renderTree();
          return;
        }
        memberEditTargetId=null;memberAvatarDraft=null;memberEditDirty=false;
        clearMemberSelection(false);
        resetSelectionMode();
        post('selectPerson', { id: node.dataset.person });
      });
      node.addEventListener('dblclick', e => { e.preventDefault(); openMemberEditor(memberById(node.dataset.person)); });
      node.addEventListener('contextmenu', e => {
        e.preventDefault();
        const member = memberById(node.dataset.person);
        const batch = selectedMembers.has(member.id) && selectedMembers.size > 1;
        const items = batch
          ? [{ label:`删除所选 ${selectedMembers.size} 个成员`, danger:true, action:confirmDeleteSelectedMembers },{ separator:true },{ label:'清除选择', action:()=>clearMemberSelection() }]
          : [{ label:'编辑成员', action:()=>openMemberEditor(member) }, { separator:true },{ label:'删除成员', danger:true, action:()=>askConfirm('删除成员',`删除“${member.displayName}”？其中的截图不会被删除，而会转入待处理。`,()=>post('deleteMember',{id:member.id}),true) }];
        showMenu(e.clientX,e.clientY,items);
      });
      node.addEventListener('dragstart',e=>{
        if (selectedMembers.has(node.dataset.person) && selectedMembers.size > 1) {
          dragPayload={kind:'members',members:[...selectedMembers].map(([memberId,sourceGroupId])=>({memberId,sourceGroupId}))};
        } else {
          dragPayload={kind:'member',memberId:node.dataset.person,sourceGroupId:node.dataset.sourceGroup||null};
        }
        e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',JSON.stringify(dragPayload));
        updateMemberDragAutoScroll(host,e.clientY);
      });
      node.addEventListener('dragend',()=>{stopMemberDragAutoScroll();dragPayload=null;document.querySelectorAll('.drag-over,.reorder-before,.reorder-after,.drop-copy,.drop-move').forEach(x=>x.classList.remove('drag-over','reorder-before','reorder-after','drop-copy','drop-move'));});
      node.addEventListener('dragover',e=>{
        // 外部文件管理器拖入不会在这里导入；文件导入只由右侧“添加”区域处理。
        if(nativeScreenshotDrag){
          const sameLibrary=nativeScreenshotDrag.sourceView==='library'&&nativeScreenshotDrag.sourceLibraryId===node.dataset.person;
          if(sameLibrary)return;
          e.preventDefault();
          const copy=nativeScreenshotDrag.sourceView==='library'&&e.ctrlKey;
          e.dataTransfer.dropEffect=copy?'copy':'move';
          node.classList.toggle('drop-copy',copy);node.classList.toggle('drop-move',!copy);node.classList.add('drag-over');return;
        }
        if(dragPayload?.kind!=='member'&&dragPayload?.kind!=='members')return;
        const movingIds=dragPayload.kind==='members'?new Set(dragPayload.members.map(x=>x.memberId)):new Set([dragPayload.memberId]);
        if(movingIds.has(node.dataset.person))return;
        e.preventDefault();e.dataTransfer.dropEffect='move';
        node.classList.remove('drag-over','reorder-before','reorder-after','drop-copy','drop-move');
        const rect=node.getBoundingClientRect();
        node.classList.add(e.clientY < rect.top + rect.height/2 ? 'reorder-before' : 'reorder-after');
      });
      node.addEventListener('dragleave',()=>node.classList.remove('drag-over','reorder-before','reorder-after','drop-copy','drop-move'));
      node.addEventListener('drop',e=>{
        if(nativeScreenshotDrag){
          const drag=nativeScreenshotDrag;
          const sameLibrary=drag.sourceView==='library'&&drag.sourceLibraryId===node.dataset.person;
          if(sameLibrary)return;
          e.preventDefault();node.classList.remove('drag-over','reorder-before','reorder-after','drop-copy','drop-move');
          const copy=drag.sourceView==='library'&&e.ctrlKey;
          post(copy?'copyScreenshotsToLibrary':'moveScreenshotsToLibrary',{ids:drag.ids,targetMemberId:node.dataset.person,sourceLibraryId:drag.sourceLibraryId,sourceView:drag.sourceView});
          resetSelectionMode();nativeScreenshotDrag=null;return;
        }
        if(dragPayload?.kind!=='member'&&dragPayload?.kind!=='members')return;
        const movingIds=dragPayload.kind==='members'?new Set(dragPayload.members.map(x=>x.memberId)):new Set([dragPayload.memberId]);
        if(movingIds.has(node.dataset.person))return;
        e.preventDefault();
        const position=node.classList.contains('reorder-before')?'before':'after';
        node.classList.remove('drag-over','reorder-before','reorder-after');
        const members=dragPayload.kind==='members'?dragPayload.members:[{memberId:dragPayload.memberId,sourceGroupId:dragPayload.sourceGroupId}];
        post('reorderMembers',{members,targetMemberId:node.dataset.person,targetGroupId:node.dataset.sourceGroup||null,position});
        clearMemberSelection(false);dragPayload=null;
      });
    });
    host.querySelectorAll('[data-group]').forEach(node => {
      node.addEventListener('click', () => { const id=node.dataset.group; collapsedGroups.has(id)?collapsedGroups.delete(id):collapsedGroups.add(id); saveViewPreferences();renderTree(); });
      node.addEventListener('contextmenu', e => { e.preventDefault(); const group=state.categories.find(x=>x.id===node.dataset.group); showMenu(e.clientX,e.clientY,[
        {label:'新建子群组',action:()=>openGroupModal(null,group.id)}, {label:'新建成员',action:()=>openMemberModal(null,group.id)},
        {label:'重命名',action:()=>openGroupModal(group)}, {separator:true},
        {label:'删除群组',danger:true,action:()=>askConfirm('删除群组',`删除“${group.name}”？其成员不会被删除。`,()=>post('deleteGroup',{id:group.id}),true)}
      ]); });
      node.addEventListener('dragover',e=>{if(dragPayload?.kind!=='member'&&dragPayload?.kind!=='members')return;e.preventDefault();e.dataTransfer.dropEffect='move';node.classList.add('drag-over');});
      node.addEventListener('dragleave',()=>node.classList.remove('drag-over'));
      node.addEventListener('drop',e=>{
        if(dragPayload?.kind!=='member'&&dragPayload?.kind!=='members')return;
        e.preventDefault();node.classList.remove('drag-over');
        if(dragPayload.kind==='members') post('moveMembers',{members:dragPayload.members,targetGroupId:node.dataset.group});
        else post('moveMember',{memberId:dragPayload.memberId,sourceGroupId:dragPayload.sourceGroupId,targetGroupId:node.dataset.group});
        clearMemberSelection(false);dragPayload=null;
      });
    });
    // 拖动成员时，左右栏里的成员树和截图框选一样支持边缘自动滚动；
    // 拖动过程中滚轮也直接滚动成员树，不需要先松开鼠标。
    host.addEventListener('dragover',event=>{
      if(!isMemberDrag())return;
      updateMemberDragAutoScroll(host,event.clientY);
    });
    host.addEventListener('dragleave',event=>{
      if(!isMemberDrag())return;
      const r=host.getBoundingClientRect();
      if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top-4||event.clientY>r.bottom+4) stopMemberDragAutoScroll();
    });
    host.addEventListener('wheel',event=>{
      if(!isMemberDrag())return;
      event.preventDefault();
      stopMemberDragAutoScroll();
      memberDragScrollHost=host;
      host.scrollTop += event.deltaY;
      updateMemberDragAutoScroll(host,memberDragPointerY||event.clientY);
    },{passive:false});
    updateMemberSelectionHeading();
    bindMemberMarqueeSelection(host);
  }

  function hash(text) { let value=0; for(const ch of String(text)) value=((value<<5)-value+ch.charCodeAt(0))|0; return value; }

  function visibleScreenshots() {
    let items = state.screenshots;
    if (state.topView === 'trash') items = items.filter(x => !!x.deletedAt);
    else if (state.topView === 'pending') items = items.filter(x => !x.deletedAt && x.needsReview);
    else if (state.selectedPersonId) items = items.filter(x => !x.deletedAt && !x.needsReview && screenshotLibraryIds(x).includes(state.selectedPersonId));
    else items = [];
    const query = $('centerSearch').value.trim().toLocaleLowerCase();
    if (query) items = items.filter(x => matchesScreenshot(x, query));
    const mode=state.settings?.screenshotSort||'newest';
    const timeOf=shot=>new Date(state.topView==='trash'&&shot.deletedAt?shot.deletedAt:shot.importedAt).valueOf()||0;
    const compare=(a,b)=>mode==='oldest'?timeOf(a)-timeOf(b)
      :mode==='nameAsc'?a.originalFileName.localeCompare(b.originalFileName,'zh-CN',{numeric:true,sensitivity:'base'})
      :mode==='nameDesc'?b.originalFileName.localeCompare(a.originalFileName,'zh-CN',{numeric:true,sensitivity:'base'})
      :timeOf(b)-timeOf(a);
    return [...items].sort((a,b)=>{
      if(state.settings?.favoritesFirst && !!a.isFavorite!==!!b.isFavorite) return a.isFavorite?-1:1;
      return compare(a,b);
    });
  }


  function sortChoices() {
    const trash=state.topView==='trash';
    return [
      {value:'newest',label:trash?'最近删除':'最近添加'},
      {value:'oldest',label:trash?'最早删除':'最早添加'},
      {value:'nameAsc',label:'文件名 A–Z'},
      {value:'nameDesc',label:'文件名 Z–A'}
    ];
  }

  function openSortMenu() {
    const button=$('sortMenu'),choices=sortChoices(),selected=state.settings?.screenshotSort||'newest',rect=button.getBoundingClientRect();
    showMenu(rect.right-Math.max(176,rect.width),rect.bottom+5,choices.map(choice=>({label:choice.label,checked:choice.value===selected,action:()=>{state.settings.screenshotSort=choice.value;post('saveScreenshotSort',{value:choice.value});renderCenter();}})),Math.max(176,rect.width));
    button.setAttribute('aria-expanded','true');
  }

  function syncScreenshotSelectionUi(items = visibleScreenshots()) {
    const host = $('cards');
    if (host) {
      host.querySelectorAll('.card[data-shot]').forEach(card => card.classList.toggle('batch-selected', selectedIds.has(card.dataset.shot)));
      host.classList.toggle('selection-mode', selectionMode || selectedIds.size > 0);
    }
    renderBatchBar(items);
  }

  function toggleSelectionMode() {
    selectionMode = !selectionMode;
    selectedIds.clear();
    $('batchMode').classList.toggle('active', selectionMode);
    syncScreenshotSelectionUi();
  }

  function renderBatchBar(items) {
    const selectionActive = selectionMode || selectedIds.size > 0;
    const bar = $('batchbar');
    if (!selectionActive) {
      bar.classList.remove('active');
      bar.dataset.entering = '';
      return;
    }
    const trash = state.topView === 'trash';
    const hasSelection=selectedIds.size>0;
    const selectableIds = new Set(items.map(x=>x.id));
    const selectedVisibleCount = [...selectedIds].filter(id=>selectableIds.has(id)).length;
    const allSelected = items.length>0 && selectedVisibleCount===items.length;
    const actions=!hasSelection?'':trash
      ? '<button class="btn" id="batchRestore">恢复</button><button class="btn danger" id="batchDelete">永久删除</button>'
      : state.topView==='pending'
        ? '<button class="btn" id="batchMoveLibrary">移动到图库…</button><button class="btn danger" id="batchTrash">移到回收站</button>'
        : '<button class="btn" id="batchCopyLibrary">复制到图库…</button><button class="btn" id="batchMoveLibrary">移动到图库…</button><button class="btn danger" id="batchRemoveLibrary">从当前图库移除</button>';
    const wasActive = bar.classList.contains('active');
    bar.innerHTML = `<div class="batchbar-group batchbar-selection"><b>已选择 ${selectedIds.size} 张</b><button class="btn" id="selectAll">${allSelected?'取消全选':'全选'}</button><button class="btn" id="invertSelection">反选</button>${hasSelection&&!allSelected?'<button class="btn" id="clearSelection">清除</button>':''}</div><div class="batchbar-group batchbar-actions">${actions}<button class="btn" id="exitBatch">完成</button></div>`;
    if (wasActive) {
      bar.classList.add('active');
    } else if (bar.dataset.entering !== '1') {
      bar.dataset.entering = '1';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (selectionMode || selectedIds.size > 0) bar.classList.add('active');
        bar.dataset.entering = '';
      }));
    }
    $('selectAll').onclick=()=>{
      if(allSelected) selectedIds.clear();
      else items.forEach(x=>selectedIds.add(x.id));
      syncScreenshotSelectionUi(items);
    };
    $('invertSelection').onclick=()=>{
      const previous=new Set(selectedIds);
      items.forEach(x=>previous.has(x.id)?selectedIds.delete(x.id):selectedIds.add(x.id));
      syncScreenshotSelectionUi(items);
    };
    $('clearSelection')&&($('clearSelection').onclick=()=>{selectedIds.clear();syncScreenshotSelectionUi(items);});
    $('exitBatch').onclick=resetSelectionMode;
    $('batchTrash') && ($('batchTrash').onclick=()=>batchAction('trash'));
    $('batchRestore') && ($('batchRestore').onclick=()=>batchAction('restore'));
    $('batchDelete') && ($('batchDelete').onclick=()=>askConfirm('永久删除',`永久删除选中的 ${selectedIds.size} 张截图？`,()=>batchAction('deleteForever'),true));
    $('batchCopyLibrary') && ($('batchCopyLibrary').onclick=()=>openTransferScreenshotsModal([...selectedIds],'copy'));
    $('batchMoveLibrary') && ($('batchMoveLibrary').onclick=()=>openTransferScreenshotsModal([...selectedIds],'move'));
    $('batchRemoveLibrary') && ($('batchRemoveLibrary').onclick=()=>{if(!state.selectedPersonId||!selectedIds.size)return;post('removeScreenshotsFromLibrary',{ids:[...selectedIds],libraryId:state.selectedPersonId});resetSelectionMode();});
  }

  function batchAction(action) { if(!selectedIds.size)return; post('batchAction',{action,ids:[...selectedIds]}); selectedIds.clear(); }


  function updateSearchClear(which) {
    const input=$(which==='side'?'sideSearch':'centerSearch');
    const button=$(which==='side'?'sideSearchClear':'centerSearchClear');
    button?.classList.toggle('visible',!!input?.value);
  }

  function bindScreenshotDropTarget(node, action) {
    node.addEventListener('dragover',event=>{if(!nativeScreenshotDrag||nativeScreenshotDrag.sourceView!=='library')return;event.preventDefault();event.dataTransfer.dropEffect='move';node.classList.add('drag-over');});
    node.addEventListener('dragleave',()=>node.classList.remove('drag-over'));
    node.addEventListener('drop',event=>{if(!nativeScreenshotDrag||nativeScreenshotDrag.sourceView!=='library')return;const drag=nativeScreenshotDrag;event.preventDefault();node.classList.remove('drag-over');post('batchAction',{action,ids:drag.ids});resetSelectionMode();nativeScreenshotDrag=null;});
  }

  function bindMarqueeSelection(host) {
    const zone = host.closest('.library') ?? host;
    zone.onpointerdown = event => {
      if (event.button !== 0) return;
      if (event.target.closest('button,input,textarea,select,a,[contenteditable="true"],.card,.batchbar,.context-menu,.modal-layer')) return;

      // 像文件资源管理器一样：可从截图区域四周的空白处起框，
      // 但工具栏、标题区仍保留给普通交互。
      const initialHostRect = host.getBoundingClientRect();
      if (event.clientY < initialHostRect.top || event.clientY > initialHostRect.bottom) return;
      event.preventDefault();

      const pointerId = event.pointerId;
      const contentPoint = (clientX, clientY) => {
        const r = host.getBoundingClientRect();
        return {
          x: clamp(clientX, r.left, r.right) - r.left + host.scrollLeft,
          y: clamp(clientY, r.top, r.bottom) - r.top + host.scrollTop
        };
      };
      const start = contentPoint(event.clientX, event.clientY);
      const startClient = { x: event.clientX, y: event.clientY };
      const base = event.ctrlKey ? new Set(selectedIds) : new Set();
      let active = false;
      let rectNode = null;
      let lastClientX = event.clientX;
      let lastClientY = event.clientY;
      let rafId = 0;

      try { zone.setPointerCapture?.(pointerId); } catch {}

      const updateSelection = () => {
        if (!active) return;
        const r = host.getBoundingClientRect();
        const current = contentPoint(lastClientX, lastClientY);
        const left = Math.min(start.x, current.x), top = Math.min(start.y, current.y);
        const right = Math.max(start.x, current.x), bottom = Math.max(start.y, current.y);

        // 视觉选框从真正按下的位置开始；进入滚动区域后，起点随内容滚动，
        // 因此可从左右留白起框，也能跨屏自动滚动。
        const startViewportY = r.top + start.y - host.scrollTop;
        const currentViewportX = clamp(lastClientX, r.left, r.right);
        const currentViewportY = clamp(lastClientY, r.top, r.bottom);
        const zoneRect = zone.getBoundingClientRect();
        const rawLeft = Math.min(startClient.x, currentViewportX);
        const rawTop = Math.min(startViewportY, currentViewportY);
        const rawRight = Math.max(startClient.x, currentViewportX);
        const rawBottom = Math.max(startViewportY, currentViewportY);
        const visualLeft = clamp(rawLeft, zoneRect.left, zoneRect.right);
        const visualTop = clamp(rawTop, r.top, r.bottom);
        const visualRight = clamp(rawRight, zoneRect.left, zoneRect.right);
        const visualBottom = clamp(rawBottom, r.top, r.bottom);
        Object.assign(rectNode.style, {
          left: `${visualLeft}px`,
          top: `${visualTop}px`,
          width: `${Math.max(0, visualRight - visualLeft)}px`,
          height: `${Math.max(0, visualBottom - visualTop)}px`
        });

        selectedIds = new Set(base);
        host.querySelectorAll('.card[data-shot]').forEach(card => {
          const cr = card.getBoundingClientRect();
          const cardLeft = cr.left - r.left + host.scrollLeft;
          const cardTop = cr.top - r.top + host.scrollTop;
          const cardRight = cardLeft + cr.width;
          const cardBottom = cardTop + cr.height;
          const hit = cardLeft < right && cardRight > left && cardTop < bottom && cardBottom > top;
          if (hit) selectedIds.add(card.dataset.shot);
          card.classList.toggle('batch-selected', selectedIds.has(card.dataset.shot));
        });
        host.classList.toggle('selection-mode', selectionMode || selectedIds.size > 0);
        renderBatchBar(visibleScreenshots());
      };

      const autoScroll = () => {
        if (!active) return;
        const r = host.getBoundingClientRect();
        const edge = 46;
        let dy = 0;
        if (lastClientY < r.top + edge) dy = -Math.ceil((r.top + edge - lastClientY) / 2.8);
        else if (lastClientY > r.bottom - edge) dy = Math.ceil((lastClientY - (r.bottom - edge)) / 2.8);
        dy = clamp(dy, -24, 24);
        if (dy) host.scrollTop += dy;
        rafId = requestAnimationFrame(autoScroll);
      };

      const move = e => {
        if (e.pointerId !== pointerId) return;
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        if (!active && Math.hypot(e.clientX - startClient.x, e.clientY - startClient.y) < 4) return;
        if (!active) {
          active = true;
          selectedIds = new Set(base);
          host.classList.toggle('selection-mode', selectionMode || selectedIds.size > 0);
          rectNode = document.createElement('div');
          rectNode.className = 'selection-rect';
          document.body.append(rectNode);
          host.addEventListener('scroll', updateSelection, { passive: true });
          rafId = requestAnimationFrame(autoScroll);
        }
        updateSelection();
      };

      const up = e => {
        if (e.pointerId !== pointerId) return;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        host.removeEventListener('scroll', updateSelection);
        cancelAnimationFrame(rafId);
        try { zone.releasePointerCapture?.(pointerId); } catch {}
        rectNode?.remove();
        if (!active && !event.ctrlKey && selectedIds.size) {
          selectedIds.clear();
          syncScreenshotSelectionUi();
        }
      };

      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    };
  }

  function renderCenter() {
    if (state.topView === 'settings') return;
    const items = visibleScreenshots(); renderBatchBar(items);
    const title = state.topView === 'trash' ? '回收站' : state.topView === 'pending' ? '待处理图库' : selectedMember()?.displayName ?? '选择一个成员图库';
    $('libraryTitle').textContent=title;
    $('librarySub').textContent=state.topView==='trash'?`${items.length} 张已删除截图`:state.topView==='pending'?`${items.length} 张等待整理`:state.selectedPersonId?`${items.length} 张截图`:'';
    $('sortLabel').textContent=(sortChoices().find(choice=>choice.value===(state.settings?.screenshotSort||'newest'))??sortChoices()[0]).label;
    $('centerSearch').placeholder=state.topView==='trash'?'搜索回收站中的文本或标签':state.topView==='pending'?'搜索待处理截图':'搜索当前图库中的文本或标签';
    const favoriteFirst=$('favoriteFirstToggle');
    if(favoriteFirst){
      const active=!!state.settings?.favoritesFirst;
      favoriteFirst.classList.toggle('active',active);
      favoriteFirst.setAttribute('aria-pressed',active?'true':'false');
    }
    const host=$('cards');
    host.dataset.density=String(gridDensity);
    const densitySlider=$('gridDensity');
    if(densitySlider&&Number(densitySlider.value)!==gridDensity)densitySlider.value=String(gridDensity);
    host.classList.toggle('selection-mode',selectionMode||selectedIds.size>0);
    if(!state.selectedPersonId && state.topView!=='pending' && state.topView!=='trash') {
      host.innerHTML=`<div class="empty-state" style="grid-column:1/-1"><div><h2>选择一个成员图库</h2><p>从左侧选择成员，或新建群组与成员。</p><button class="btn primary" id="emptyCreate">新建成员图库</button></div></div>`;
      $('emptyCreate').onclick=()=>openMemberModal(); return;
    }
    if(!items.length){
      const searching=!!$('centerSearch').value.trim();
      const emptyTitle=searching?'未找到匹配的截图':state.topView==='trash'?'回收站是空的':state.topView==='pending'?'没有待处理截图':'这个图库还没有截图';
      const emptyText=searching?'尝试修改关键词，或清除搜索条件。':state.topView==='trash'?'移入回收站的截图会显示在这里。':state.topView==='pending'?'从“添加”选择暂存，或使用全局快捷键快速收录。':'切换到右侧“添加”开始收录。';
      host.innerHTML=`<div class="empty-state" style="grid-column:1/-1"><div><h2>${emptyTitle}</h2><p>${emptyText}</p>${searching?'<button class="btn" id="emptyClearSearch">清除搜索</button>':''}</div></div>`;
      $('emptyClearSearch') && ($('emptyClearSearch').onclick=()=>{$('centerSearch').value='';updateSearchClear('center');renderCenter();});return;
    }
    const previousScrollTop = host.scrollTop;
    host.innerHTML=items.map(shot=>{
      const library=screenshotLibraryLabel(shot);
      const lines=(shot.searchText||'').split('\n').map(x=>x.trim()).filter(Boolean);
      const snippet=lines[0]||'未填写可搜索文本';
      const detail=lines.slice(0,4).join(' · ');
      return `<article class="card ${shot.id===state.selectedScreenshotId?'selected':''} ${selectedIds.has(shot.id)?'batch-selected':''}" draggable="false" data-shot="${shot.id}">
        <span class="select-dot">${checkSvg}</span>
        <button type="button" class="favorite-button ${shot.isFavorite?'active':''}" data-favorite="${shot.id}" aria-pressed="${shot.isFavorite?'true':'false'}" data-tooltip="${shot.isFavorite?'取消收藏':'收藏'}">${shot.isFavorite?starFilledSvg:starOutlineSvg}</button>
        <button class="card-more" data-more="${shot.id}" data-tooltip="更多操作" aria-label="更多操作">${moreSvg}</button>
        <div class="thumb"><img class="real-image" draggable="false" src="${esc(shot.thumbnailUrl||shot.imageUrl)}" data-fallback-src="${esc(shot.imageUrl)}" alt="截图" loading="lazy" decoding="async"/></div>
        <div class="cardline"><span class="snippet">${esc(snippet)}</span><span class="date">${fmtDate(shot.importedAt)}</span></div>
        <div class="mini">${esc(library)}${shot.needsReview?' · 待整理':''}${shot.tags?.length?' · #'+esc(shot.tags.join(' #')):''}</div>
        <div class="card-details">${esc(detail)}</div>
      </article>`;
    }).join('');
    host.scrollTop = previousScrollTop;
    bindImageFallbacks(host);
    host.querySelectorAll('[data-shot]').forEach(card=>{
      card.onclick=e=>{
        if(performance.now()<suppressCardClickUntil){e.preventDefault();return;}
        if(e.target.closest('[data-more],[data-favorite]'))return;
        if(selectionMode||e.ctrlKey){
          selectedIds.has(card.dataset.shot)?selectedIds.delete(card.dataset.shot):selectedIds.add(card.dataset.shot);
          card.classList.toggle('batch-selected',selectedIds.has(card.dataset.shot));
          host.classList.toggle('selection-mode',selectionMode||selectedIds.size>0);
          renderBatchBar(items);
          return;
        }
        // 框选后的普通单击回到单张查看；Ctrl+单击才继续增减多选。
        if(selectedIds.size){
          selectedIds.clear();
          host.querySelectorAll('.batch-selected').forEach(node=>node.classList.remove('batch-selected'));
          host.classList.toggle('selection-mode',selectionMode);
          renderBatchBar(items);
        }
        state.selectedScreenshotId=card.dataset.shot;
        host.querySelectorAll('.card.selected').forEach(node=>node.classList.remove('selected'));
        card.classList.add('selected');
        renderWorkbench();
        memberEditTargetId=null;memberAvatarDraft=null;memberEditDirty=false;post('selectScreenshot',{id:card.dataset.shot});
      };
      card.ondblclick=e=>{
        if(selectionMode||e.ctrlKey||e.target.closest('[data-more],[data-favorite]'))return;
        const shot=state.screenshots.find(item=>item.id===card.dataset.shot);
        if(shot){e.preventDefault();showImageViewer(shot.imageUrl,screenshotViewerDetails(shot));}
      };
      card.oncontextmenu=e=>{e.preventDefault();showScreenshotMenu(e.clientX,e.clientY,card.dataset.shot);};
      const cancelScreenshotDragCandidate=event=>{
        if(!screenshotDragCandidate||screenshotDragCandidate.card!==card)return;
        if(event&&screenshotDragCandidate.pointerId!==event.pointerId)return;
        try{if(card.hasPointerCapture?.(screenshotDragCandidate.pointerId))card.releasePointerCapture(screenshotDragCandidate.pointerId);}catch{}
        screenshotDragCandidate=null;
      };
      card.addEventListener('pointerdown',event=>{
        if(event.button!==0||event.target.closest('button,input,textarea,select,a,[contenteditable="true"]'))return;
        if(state.topView!=='library'&&state.topView!=='pending')return;
        screenshotDragCandidate={card,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,started:false};
        try{card.setPointerCapture?.(event.pointerId);}catch{}
      });
      card.addEventListener('pointermove',event=>{
        const candidate=screenshotDragCandidate;
        if(!candidate||candidate.card!==card||candidate.pointerId!==event.pointerId||candidate.started)return;
        const distance=Math.hypot(event.clientX-candidate.startX,event.clientY-candidate.startY);
        if(distance<7)return;
        candidate.started=true;
        const id=card.dataset.shot;
        const ids=selectedIds.has(id)&&selectedIds.size>1?[...selectedIds]:[id];
        nativeScreenshotDrag={ids,sourceView:state.topView,sourceLibraryId:state.selectedPersonId};
        suppressCardClickUntil=performance.now()+800;
        try{if(card.hasPointerCapture?.(event.pointerId))card.releasePointerCapture(event.pointerId);}catch{}
        screenshotDragCandidate=null;
        post('beginExternalScreenshotDrag',{ids});
        event.preventDefault();
      });
      card.addEventListener('pointerup',cancelScreenshotDragCandidate);
      card.addEventListener('pointercancel',cancelScreenshotDragCandidate);
      card.addEventListener('dragstart',event=>event.preventDefault());
    });
    host.querySelectorAll('[data-more]').forEach(button=>button.onclick=e=>{e.stopPropagation();const r=button.getBoundingClientRect();showScreenshotMenu(r.right,r.bottom+4,button.dataset.more);});
    host.querySelectorAll('[data-favorite]').forEach(button=>button.onclick=e=>{e.stopPropagation();post('toggleFavorite',{id:button.dataset.favorite});});
    bindMarqueeSelection(host);
  }

  function showScreenshotMenu(x,y,id){
    const shot=state.screenshots.find(s=>s.id===id); if(!shot)return;
    const view={label:'查看大图与信息',action:()=>showImageViewer(shot.imageUrl,screenshotViewerDetails(shot))};
    const favorite={label:shot.isFavorite?'取消收藏':'收藏',action:()=>post('toggleFavorite',{id})};
    const removeCurrent=state.topView==='library'&&state.selectedPersonId&&screenshotLibraryIds(shot).includes(state.selectedPersonId)
      ? {label:'从当前图库移除',action:()=>post('removeScreenshotsFromLibrary',{ids:[id],libraryId:state.selectedPersonId})}
      : null;
    showMenu(x,y,shot.deletedAt?[
      view,favorite,{separator:true},{label:'恢复截图',action:()=>post('restoreFromTrash',{id})},{separator:true},{label:'永久删除',danger:true,action:()=>askConfirm('永久删除','删除后无法恢复，确定继续？',()=>post('permanentDelete',{id}),true)}
    ]:shot.needsReview?[
      view,favorite,{label:'继续处理',action:()=>{state.selectedScreenshotId=id;setActivePanel('edit',true)}},{label:'移动到图库…',action:()=>openTransferScreenshotsModal([id],'move')},{separator:true},{label:'移到回收站',danger:true,action:()=>post('moveToTrash',{id})}
    ]:[
      view,favorite,{label:'复制到剪贴板',action:()=>post('copyImage',{id})},{separator:true},{label:'复制到图库…',action:()=>openTransferScreenshotsModal([id],'copy')},{label:'移动到图库…',action:()=>openTransferScreenshotsModal([id],'move')},...(removeCurrent?[removeCurrent]:[]),{label:'在资源管理器中显示',action:()=>post('showFile',{id})},{separator:true},{label:'从所有图库移到回收站',danger:true,action:()=>post('moveToTrash',{id})}
    ]);
  }

  function openTransferScreenshotsModal(ids, mode='copy') {
    const moving=mode==='move';
    const memberButton=(p,depth=0)=>{const current=state.topView==='library'&&p.id===state.selectedPersonId;return `<button class="library-choice" data-library="${p.id}" style="--depth:${depth}"${current?' disabled':''}><span class="avatar a${Math.abs(hash(p.id))%5+1}">${esc(p.displayName.slice(0,1)||'?')}</span><span>${esc(p.displayName)}</span>${current?'<small style="margin-left:auto;color:var(--muted)">当前</small>':''}</button>`;};
    const groupBlock=(group,depth=0)=>{const members=state.people.filter(p=>p.categoryIds.includes(group.id));const children=state.categories.filter(x=>x.parentId===group.id);const body=members.map(p=>memberButton(p,depth)).join('')+children.map(x=>groupBlock(x,depth+1)).join('');return body?`<div class="library-group"><div class="library-group-title" style="--depth:${depth}">${esc(group.name)}</div>${body}</div>`:'';};
    const grouped=state.categories.filter(x=>!x.parentId).map(x=>groupBlock(x)).join('');
    const ungrouped=state.people.filter(p=>!p.categoryIds.length).map(p=>memberButton(p)).join('');
    const picker=grouped+(ungrouped?`<div class="library-group"><div class="library-group-title">未分组</div>${ungrouped}</div>`:'');
    const title=moving?'移动到图库':'复制到图库';
    const description=moving?(state.topView==='pending'?'移入后会离开待处理，但仍停留在待处理页面继续整理。':'截图会从当前图库移到目标图库；如果还属于其他图库，不会影响那些图库。'):'截图会保留在现有图库中，并同时加入目标图库。';
    modal(`<h2>${title}</h2><p>${description}</p><div class="modal-field"><label>目标成员图库</label><div class="library-picker" id="movePicker">${picker||'<div class="picker-empty">没有可用的目标图库</div>'}</div></div><div class="modal-actions"><button class="btn" data-cancel>取消</button><button class="btn primary" data-transfer disabled>${moving?'移动':'复制'}</button></div>`,layer=>{
      let target=null;const transfer=layer.querySelector('[data-transfer]');
      layer.querySelectorAll('[data-library]').forEach(button=>button.onclick=()=>{target=button.dataset.library;layer.querySelectorAll('[data-library]').forEach(x=>x.classList.toggle('active',x===button));transfer.disabled=false;});
      transfer.onclick=()=>{if(!target)return;layer.remove();post(moving?'moveScreenshotsToLibrary':'copyScreenshotsToLibrary',{ids,targetMemberId:target,sourceLibraryId:state.selectedPersonId,sourceView:state.topView});resetSelectionMode();};
    });
  }

  function setActivePanel(name, force=false) {
    if(!force&&memberEditDirty&&state.activePanel==='edit'&&name!=='edit') return askConfirm('放弃修改','成员资料尚未保存，确定放弃吗？',()=>{memberEditDirty=false;memberEditTargetId=null;memberAvatarDraft=null;setActivePanel(name,true);});
    if(!force&&editDirty&&state.activePanel==='edit'&&name!=='edit') return askConfirm('放弃修改','编辑内容尚未保存，确定放弃吗？',()=>{editDirty=false;editTargetScreenshotId=null;editTargetLibraryIds=[];editDraftTags=null;editDraftSearchText=null;setActivePanel(name,true);});
    if(state.topView==='trash'&&name!=='preview')name='preview';
    if(state.topView==='pending'&&name==='add')name='preview';
    if(name!==state.activePanel)resetSelectionMode();
    state.activePanel=name;
    document.querySelectorAll('.tab').forEach(tab=>tab.classList.toggle('active',tab.dataset.panel===name));
    document.querySelectorAll('.panel').forEach(panel=>panel.classList.toggle('active',panel.id===name));
    renderWorkbench();post('panelChanged',{name});
  }

  function renderWorkbench(){
    $('pendingCount').textContent=state.screenshots.filter(x=>!x.deletedAt&&x.needsReview).length;
    document.querySelectorAll('.tab').forEach(tab=>tab.classList.toggle('hidden',(state.topView==='trash'&&tab.dataset.panel!=='preview')||(state.topView==='pending'&&tab.dataset.panel==='add')));
    renderPreview();renderAdd();renderEdit();
  }
  const emptyPanel=(host,title,text)=>host.innerHTML=`<div class="empty-state"><div><h2>${esc(title)}</h2><p>${esc(text)}</p></div></div>`;

  function renderPreview(){
    const host=$('preview'),shot=selectedScreenshot();
    if(!shot){emptyPanel(host,state.topView==='trash'?'选择回收站中的截图':state.topView==='pending'?'选择一张待处理截图':'选择一张截图',state.topView==='trash'?'选择后可以还原或永久删除。':state.topView==='pending'?'选择后可以继续填写文本、标签并选择图库。':'选择后可查看大图、可搜索文本并复制原图。');return;}
    const text=shot.searchText?.trim()?esc(shot.searchText):'<span class="muted">未填写可搜索文本</span>';
    const actions=state.topView==='trash'?`<button class="btn" id="cancelPreview">取消</button><button class="btn" id="restoreShot">还原截图</button><button class="btn danger" id="deleteForever">永久删除</button>`:state.topView==='pending'?`<button class="btn" id="cancelPreview">取消</button><button class="btn primary" id="editPending">继续处理</button>`:`<button class="btn" id="cancelPreview">取消</button><button class="btn primary" id="copyShot">复制到剪贴板</button>`;
    host.innerHTML=`<div class="panel-header"><h2>${state.topView==='trash'?'回收站预览':state.topView==='pending'?'待处理截图':'截图预览'}</h2><span class="muted">${new Date(shot.importedAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span></div><button type="button" class="bigpreview zoomable-preview" id="previewImageZoom" data-tooltip="查看大图与详细信息" aria-label="查看截图大图与详细信息"><img src="${esc(shot.imageUrl)}" alt="截图预览"/></button>${shot.ocrEngine?`<div class="engine-note">${esc(ocrSummary(shot.ocrEngine,shot.confidence))}</div>`:''}${shot.tags?.length?`<div class="section"><div class="section-title">标签</div><div class="chips">${shot.tags.map(x=>`<span class="chip">#${esc(x)}</span>`).join('')}</div></div>`:''}<div class="section"><div class="section-title">可搜索文本</div><div class="message-box">${text}</div></div><div class="actions">${actions}</div>`;
    bindImageFallbacks(host);
    $('previewImageZoom').onclick=()=>showImageViewer(shot.imageUrl,screenshotViewerDetails(shot));
    $('cancelPreview').onclick=()=>{state.selectedScreenshotId=null;$('cards')?.querySelectorAll('.card.selected').forEach(node=>node.classList.remove('selected'));renderWorkbench();post('clearScreenshotSelection');};
    $('copyShot') && ($('copyShot').onclick=()=>post('copyImage',{id:shot.id}));
    $('restoreShot') && ($('restoreShot').onclick=()=>post('restoreFromTrash',{id:shot.id}));
    $('deleteForever') && ($('deleteForever').onclick=()=>askConfirm('永久删除','删除后无法恢复，确定继续？',()=>post('permanentDelete',{id:shot.id}),true));
    $('editPending') && ($('editPending').onclick=()=>setActivePanel('edit'));
  }

  function renderAdd(){
    const host=$('add'),current=selectedMember();
    const importEngine=nextImportOcrEngine??state.settings?.ocrEngine??'None';
    if(!draft){host.innerHTML=`<div class="panel-header"><h2>添加截图</h2></div><div class="ocr-quick"><label for="addOcrEngine">本次识别</label>${customSelectMarkup('addOcrEngine',ocrEngineChoices(),importEngine,'','选择本次 OCR 方式')}</div><div class="dropzone" id="dropzone"><div><div class="dropicon">＋</div><b>拖入截图或选择本地文件</b><div class="or">支持多选 PNG、JPG、BMP、GIF</div><button class="btn" id="chooseImage">选择图片</button></div></div><div class="formrow"><button class="btn" id="clipboardImage" style="width:100%">从剪贴板读取图片</button></div><div class="formrow"><label>默认加入图库</label><div class="field" style="display:flex;align-items:center">${esc(current?.displayName||'未选择成员图库')}</div><button class="btn" id="quickCreateMember" style="width:100%;margin-top:8px">＋ 新建成员图库</button></div><div class="pending-note">文本和标签都可以留空。单张图片读取后可以选择多个图库；批量导入会进入待处理。</div>`;
      bindCustomSelect('addOcrEngine',ocrEngineChoices(),engine=>requestOcrChange(engine,'next',null,false,()=>{nextImportOcrEngine=engine;renderAdd();}),false);
      $('chooseImage').onclick=()=>post('chooseImage',{engine:$('addOcrEngine').value,libraryId:current?.id||null});$('clipboardImage').onclick=()=>post('prepareClipboard',{engine:$('addOcrEngine').value});$('quickCreateMember').onclick=()=>openMemberModal();
      const dz=$('dropzone');['dragenter','dragover'].forEach(n=>dz.addEventListener(n,e=>{e.preventDefault();dz.style.borderColor='#444';}));['dragleave','drop'].forEach(n=>dz.addEventListener(n,e=>{e.preventDefault();dz.style.borderColor='';}));
      dz.addEventListener('drop',e=>{if(nativeScreenshotDrag){e.preventDefault();return;}readDroppedFiles([...e.dataTransfer.files].filter(f=>f.type.startsWith('image/')),$('addOcrEngine').value,current?.id||null);});return;
    }
    const engineKey=draft.ocrEngineKey||state.settings?.ocrEngine||'None';
    const targets=draftLibraryIds.map(memberById).filter(Boolean);
    const targetLabel=targets.length?targets.map(x=>x.displayName).join('、'):'选择成员图库';
    host.innerHTML=`<div class="panel-header"><h2>添加截图</h2><span class="muted">${esc(ocrSummary(draft.ocrEngine||'未使用 OCR',draft.confidence))}</span></div><div class="ocr-quick"><label for="draftOcrEngine">当前截图</label>${customSelectMarkup('draftOcrEngine',ocrEngineChoices(),engineKey,'','选择当前截图 OCR 方式')}<button class="btn" id="rerunDraftOcr" ${engineKey==='None'?'disabled':''}>重新识别</button></div><button type="button" class="edit-image-preview draft-image-preview" id="draftImageZoom" data-tooltip="查看大图与详细信息" aria-label="查看待添加截图大图与详细信息"><img class="real-image" src="${esc(draft.dataUrl)}" alt="待添加截图"/></button><div class="section text-section"><div class="section-title">可搜索文本（可选）</div><textarea class="search-textarea" id="draftSearchText" placeholder="OCR 结果会显示在这里，也可以手动输入或留空">${esc(draft.searchText||'')}</textarea></div><div class="section"><div class="section-title">标签（可选，以逗号分隔）</div><input class="keyword-input" id="draftTags" value="${esc(draft.tags||'')}" placeholder="例如：加班，名场面"/></div><div class="section"><div class="section-title">存放图库</div><button class="library-target" id="chooseDraftLibraries"><span>${esc(targetLabel)}</span><span>${targets.length?`${targets.length} 个图库`:'选择…'}</span></button></div><div class="actions"><button class="btn" id="cancelDraft">取消</button><button class="btn" id="commitPending">暂存</button><button class="btn primary" id="commitCurrent" ${targets.length?'':'disabled'}>保存到图库</button></div>`;
    $('draftImageZoom').onclick=()=>showImageViewer(draft.dataUrl,{
      title:draft.name||'待添加截图',
      libraryName:targets.map(x=>x.displayName).join('、')||'尚未选择图库',
      engine:draft.ocrEngine||'未使用 OCR',
      confidence:draft.confidence||0,
      searchText:$('draftSearchText')?.value??draft.searchText??'',
      tags:keywords($('draftTags')?.value??draft.tags??'')
    });
    bindCustomSelect('draftOcrEngine',ocrEngineChoices(),engine=>requestOcrChange(engine,'draft',null,true,()=>{draft.tags=$('draftTags').value;}),false);
    $('rerunDraftOcr').onclick=()=>askConfirm('重新识别截图','重新识别会替换当前的可搜索文本，标签不会改变。是否继续？',()=>{draft.tags=$('draftTags').value;requestOcrChange(engineKey,'draft');},false,'重新识别');
    $('chooseDraftLibraries').onclick=()=>chooseLibraries(draftLibraryIds,ids=>{draft.searchText=$('draftSearchText').value;draft.tags=$('draftTags').value;draftLibraryIds=ids;renderAdd();});
    $('cancelDraft').onclick=()=>{draft=null;draftLibraryIds=[];post('cancelDraft');renderAdd();};
    $('commitPending').onclick=()=>commitDraft(true);$('commitCurrent').onclick=()=>commitDraft(false);
  }

  function commitDraft(pending){post('commitDraft',{pending,libraryIds:draftLibraryIds,tags:keywords($('draftTags')?.value),searchText:$('draftSearchText')?.value||''});}
  function readDroppedFiles(files,engine,libraryId){if(!files.length)return;Promise.all(files.map(file=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve({name:file.name,dataUrl:r.result});r.onerror=reject;r.readAsDataURL(file);}))).then(items=>items.length===1?post('prepareDroppedImage',{...items[0],engine}):post('prepareDroppedImages',{items,engine,libraryId}));}
  function chooseLibraries(selectedIds,onChoose){
    const selected=new Set((selectedIds||[]).filter(id=>memberById(id)));
    const avatarMarkup=p=>p.avatarDataUrl?`<span class="avatar member-avatar-image"><img src="${esc(p.avatarDataUrl)}" alt=""/></span>`:`<span class="avatar a${Math.abs(hash(p.id))%5+1}">${esc(p.displayName.slice(0,1)||'?')}</span>`;
    const memberButton=(p,depth=0)=>`<button class="library-choice ${selected.has(p.id)?'active':''}" data-library="${p.id}" style="--depth:${depth}">${avatarMarkup(p)}<span>${esc(p.displayName)}</span><span class="library-choice-check">${selected.has(p.id)?checkSvg:''}</span></button>`;
    const groupBlock=(group,depth=0)=>{const members=state.people.filter(p=>p.categoryIds.includes(group.id));const children=state.categories.filter(x=>x.parentId===group.id);const body=members.map(p=>memberButton(p,depth)).join('')+children.map(x=>groupBlock(x,depth+1)).join('');return body?`<div class="library-group"><div class="library-group-title" style="--depth:${depth}">${esc(group.name)}</div>${body}</div>`:'';};
    const grouped=state.categories.filter(x=>!x.parentId).map(x=>groupBlock(x)).join('');
    const ungrouped=state.people.filter(p=>!p.categoryIds.length).map(p=>memberButton(p)).join('');
    const picker=grouped+(ungrouped?`<div class="library-group"><div class="library-group-title">未分组</div>${ungrouped}</div>`:'');
    modal(`<h2>选择存放图库</h2><div class="library-picker">${picker||'<div class="picker-empty">尚未创建成员图库</div>'}</div><div class="modal-actions"><button class="btn" data-cancel>取消</button><button class="btn primary" data-confirm-libraries>确定</button></div>`,layer=>{
      const confirm=layer.querySelector('[data-confirm-libraries]');
      const refresh=button=>{const id=button.dataset.library;button.classList.toggle('active',selected.has(id));button.querySelector('.library-choice-check').innerHTML=selected.has(id)?checkSvg:'';};
      layer.querySelectorAll('[data-library]').forEach(button=>button.onclick=()=>{const id=button.dataset.library;selected.has(id)?selected.delete(id):selected.add(id);refresh(button);});
      confirm.onclick=()=>{layer.remove();onChoose([...selected]);};
    });
  }

  function renderEdit(){
    const host=$('edit'),shot=selectedScreenshot();
    if(!shot||shot.deletedAt){
      const member=memberById(memberEditTargetId)||selectedMember();
      if(member&&state.topView==='library'){renderMemberEditor(host,member);return;}
      emptyPanel(host,'选择一张截图','从图库或待处理中选择截图后，可以修改可搜索文本和标签。');return;
    }
    memberEditTargetId=null;memberAvatarDraft=null;memberEditDirty=false;
    const engineKey=shot.ocrEngineKey||'None';
    if(editTargetScreenshotId!==shot.id){editTargetScreenshotId=shot.id;editTargetLibraryIds=[...screenshotLibraryIds(shot)];editDraftTags=null;editDraftSearchText=null;}
    const targets=editTargetLibraryIds.map(memberById).filter(Boolean);
    const targetLabel=targets.length?targets.map(x=>x.displayName).join('、'):'选择成员图库';
    host.innerHTML=`<div class="panel-header"><h2>${state.topView==='pending'?'继续处理截图':'编辑截图'}</h2><span class="muted">文本和标签均可留空</span></div><div class="ocr-quick"><label for="editOcrEngine">当前截图</label>${customSelectMarkup('editOcrEngine',ocrEngineChoices(),engineKey,'','选择当前截图 OCR 方式')}<button class="btn" id="rerunOcr" ${engineKey==='None'?'disabled':''}>重新识别</button></div><button type="button" class="edit-image-preview" id="editImagePreview" data-tooltip="查看大图与详细信息" aria-label="查看当前截图大图"><img src="${esc(shot.imageUrl)}" alt="当前编辑截图"/></button><div class="section text-section edit-text-section"><div class="section-title">可搜索文本（可选）</div><textarea class="search-textarea" id="editSearchText" placeholder="输入以后可能用于搜索这张截图的文字，也可以留空">${esc(editDraftSearchText??shot.searchText??'')}</textarea></div><div class="section"><div class="section-title">标签（可选，以逗号分隔）</div><input class="keyword-input" id="editTags" value="${esc(editDraftTags??(shot.tags||[]).join('，'))}"/></div><div class="section"><div class="section-title">存放图库</div><button class="library-target" id="chooseEditLibraries"><span>${esc(targetLabel)}</span><span>${targets.length?`${targets.length} 个图库`:'选择…'}</span></button></div><div class="actions"><button class="btn" id="cancelEdit">取消</button><button class="btn primary" id="saveEdit" ${targets.length?'':'disabled'}>${state.topView==='pending'?'保存到图库':'保存修改'}</button></div>`;
    $('editImagePreview').onclick=()=>showImageViewer(shot.imageUrl,screenshotViewerDetails(shot,{
      libraryName:targets.map(x=>x.displayName).join('、')||'未选择图库',
      searchText:$('editSearchText')?.value??editDraftSearchText??shot.searchText??'',
      tags:keywords($('editTags')?.value??editDraftTags??(shot.tags||[]).join('，'))
    }));
    $('editSearchText').oninput=()=>{editDirty=true;editDraftSearchText=$('editSearchText').value;};$('editTags').oninput=()=>{editDirty=true;editDraftTags=$('editTags').value;};
    $('cancelEdit').onclick=()=>{editDirty=false;editTargetScreenshotId=null;editTargetLibraryIds=[];editDraftTags=null;editDraftSearchText=null;setActivePanel('preview',true);};$('saveEdit').onclick=saveEdit;
    $('chooseEditLibraries').onclick=()=>chooseLibraries(editTargetLibraryIds,ids=>{editDraftSearchText=$('editSearchText').value;editDraftTags=$('editTags').value;editTargetLibraryIds=ids;editDirty=true;renderEdit();});
    bindCustomSelect('editOcrEngine',ocrEngineChoices(),engine=>requestOcrChange(engine,'edit',shot.id,true,()=>{editDirty=false;editDraftSearchText=null;}),false);
    $('rerunOcr').onclick=()=>askConfirm('重新识别截图','重新识别会替换当前的可搜索文本，标签不会改变。是否继续？',()=>{editDirty=false;editDraftSearchText=null;requestOcrChange(engineKey,'edit',shot.id);},false,'重新识别');
  }
  function saveEdit(){const shot=selectedScreenshot();post('saveEdit',{id:shot.id,libraryIds:editTargetLibraryIds,tags:keywords($('editTags').value),searchText:$('editSearchText').value});editDirty=false;editTargetScreenshotId=null;editTargetLibraryIds=[];editDraftTags=null;editDraftSearchText=null;}

  function renderSettings(){
    stopHotkeyCapture?.();
    const s=state.settings||{};
    const selected=s.ocrEngine==='PaddleOcrV6'?'PaddleOcrV6':'None';
    const theme=s.theme==='light'?'light':'dark';
    const themeChoices=[{value:'dark',label:'黑色'},{value:'light',label:'白色'}];
    hotkeyDraft=hotkeyFromSettings(s);
    const searchIcon='<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="5"/><path d="m12 12 3 3"/></svg>';
    $('settingsPage').innerHTML=`<div class="settings-shell"><aside class="settings-nav"><div class="settings-search">${searchIcon}<input id="settingsSearch" placeholder="搜索设置" aria-label="搜索设置"/><button id="settingsSearchClear" aria-label="清除搜索">×</button></div><nav class="settings-nav-list" aria-label="设置分类"><button class="active" data-settings-nav="settingsLayout">界面与布局</button><button data-settings-nav="settingsOcr">默认 OCR 引擎</button><button data-settings-nav="settingsHotkey">全局收录快捷键</button><button data-settings-nav="settingsData">数据与备份</button></nav></aside><main class="settings-content" id="settingsContent"><section class="settings-card" id="settingsLayout" data-settings-search="界面 布局 主题 深色 浅色 黑色 白色 宽度 分隔线 恢复 默认"><h2>界面与布局</h2><p>选择界面主题，或拖动主界面分隔线调整各区域宽度。</p><div class="settings-control-row"><div><b>主题</b><span>切换黑色或白色界面</span></div>${customSelectMarkup('themeSelect',themeChoices,theme,'','选择界面主题')}</div><div class="smallrow"><button class="btn" id="resetLayout">恢复默认布局</button></div></section><section class="settings-card" id="settingsOcr" data-settings-search="ocr 识别 paddle 默认 引擎 模型 安装 删除"><h2>默认 OCR 引擎</h2><p>选择以后添加截图时默认使用的识别方式；添加和编辑页面可以为当前截图临时切换。</p><div class="ocr-row">${customSelectMarkup('ocrEngine',ocrEngineChoices(),selected,'','选择默认 OCR 方式')}${s.paddleAvailable?'<button class="btn danger-outline" id="removePaddleOcr">删除 PaddleOCR</button>':''}</div></section><section class="settings-card" id="settingsHotkey" data-settings-search="快捷键 全局 收录 剪贴板 待处理 键盘"><h2>全局收录快捷键</h2><p>按下快捷键后，将剪贴板图片静默加入待处理。</p><div class="hotkey-row"><button type="button" class="hotkey-recorder" id="hotKeyRecorder"><b>${esc(hotkeyLabel(hotkeyDraft))}</b></button><button class="btn primary" id="saveHotKey">保存快捷键</button></div><div class="hotkey-hint" id="hotKeyHint">点击快捷键框，然后直接按下新的组合键。</div></section><section class="settings-card" id="settingsData" data-settings-search="数据 备份 恢复 导出 zip 原图 索引"><h2>数据与备份</h2><p>备份包含索引、群组、成员图库、可搜索文本、标签和全部原图。</p><div class="smallrow"><button class="btn" id="backupData">导出完整备份</button><button class="btn" id="restoreData">从备份恢复</button></div></section><div class="settings-empty" id="settingsEmpty">没有匹配的设置</div></main></div>`;
    bindCustomSelect('ocrEngine',ocrEngineChoices(),engine=>requestOcrChange(engine,'settings',null,false,()=>{nextImportOcrEngine=null;}),false);
    bindCustomSelect('themeSelect',themeChoices,value=>{applyTheme(value);post('saveThemeSettings',{theme:value});});
    bindSettingsNavigation();
    $('hotKeyRecorder').onclick=()=>beginHotkeyCapture($('hotKeyRecorder'));
    $('saveHotKey').onclick=()=>{
      stopHotkeyCapture?.();
      post('saveHotKeySettings',{hotKeyCtrl:hotkeyDraft.ctrl,hotKeyAlt:hotkeyDraft.alt,hotKeyShift:hotkeyDraft.shift,hotKey:hotkeyDraft.key});
    };
    $('resetLayout').onclick=()=>{applyLayoutSettings(layoutDefaults.sidebar,layoutDefaults.workbench);post('resetLayoutSettings');toast('已恢复默认布局。');};
    $('removePaddleOcr')&&($('removePaddleOcr').onclick=()=>askConfirm('删除 PaddleOCR','将从本机删除约 900 MB 的运行环境和识别模型。已经保存的截图和文字不会受到影响。',()=>post('uninstallPaddleOcr'),true,'删除'));
    $('backupData').onclick=()=>post('createBackup');$('restoreData').onclick=()=>askConfirm('恢复备份','恢复会替换当前图库；操作前会自动创建安全备份。',()=>post('restoreBackup'));
  }

  function bindSettingsNavigation(){
    const search=$('settingsSearch'),clear=$('settingsSearchClear'),empty=$('settingsEmpty'),content=$('settingsContent');
    const cards=[...content.querySelectorAll('.settings-card')];
    const buttons=[...document.querySelectorAll('[data-settings-nav]')];
    const activate=id=>buttons.forEach(button=>button.classList.toggle('active',button.dataset.settingsNav===id));
    buttons.forEach(button=>button.onclick=()=>{const card=$(button.dataset.settingsNav);if(!card||card.classList.contains('hidden'))return;activate(card.id);card.scrollIntoView({behavior:'smooth',block:'start'});});
    const filter=()=>{
      const query=search.value.trim().toLocaleLowerCase();let visible=0;
      cards.forEach(card=>{const show=!query||`${card.querySelector('h2')?.textContent||''} ${card.dataset.settingsSearch||''}`.toLocaleLowerCase().includes(query);card.classList.toggle('hidden',!show);document.querySelector(`[data-settings-nav="${card.id}"]`)?.classList.toggle('hidden',!show);if(show)visible++;});
      clear.classList.toggle('visible',!!query);empty.classList.toggle('visible',visible===0);
      const first=cards.find(card=>!card.classList.contains('hidden'));if(first)activate(first.id);
    };
    search.oninput=filter;clear.onclick=()=>{search.value='';filter();search.focus();};
    content.onscroll=()=>{const visible=cards.filter(card=>!card.classList.contains('hidden'));if(!visible.length)return;const top=content.getBoundingClientRect().top+20;const current=visible.reduce((best,card)=>Math.abs(card.getBoundingClientRect().top-top)<Math.abs(best.getBoundingClientRect().top-top)?card:best,visible[0]);activate(current.id);};
  }

  function renderApp(){
    ensureDynamicUi();applyLayoutSettings();const settings=state.topView==='settings';document.querySelector('.workspace').classList.toggle('settings-mode',settings);
    document.querySelectorAll('[data-top]').forEach(x=>x.classList.toggle('active',x.dataset.top===(settings?'settings':'library')));
    if(settings){closeFloating();renderSettings();return;} updateSearchClear('side');updateSearchClear('center');renderTree();renderCenter();renderWorkbench();
  }

  function bindStaticEvents(){
    bindLayoutSplitter($('sidebarSplitter'),'sidebar');bindLayoutSplitter($('workbenchSplitter'),'workbench');
    $('sortMenu').onclick=event=>{if($('sortMenu').getAttribute('aria-expanded')==='true'&&document.querySelector('.context-menu'))closeFloating();else openSortMenu();event.stopPropagation();};
    document.querySelectorAll('.tab').forEach(tab=>tab.onclick=()=>setActivePanel(tab.dataset.panel));
    document.querySelectorAll('[data-top]').forEach(tab=>tab.onclick=()=>{resetSelectionMode();state.topView=tab.dataset.top;state.selectedScreenshotId=null;post('topViewChanged',{name:state.topView});renderApp();if(state.topView==='library')setActivePanel('preview',true);});
    $('trashNav').onclick=()=>{resetSelectionMode();state.topView='trash';state.selectedScreenshotId=null;post('topViewChanged',{name:'trash'});renderApp();setActivePanel('preview',true);};
    $('pendingNav').onclick=()=>{resetSelectionMode();state.topView='pending';state.selectedScreenshotId=null;post('topViewChanged',{name:'pending'});renderApp();setActivePanel('preview',true);};
    bindScreenshotDropTarget($('pendingNav'),'pending');
    bindScreenshotDropTarget($('trashNav'),'trash');
    $('sideSearch').oninput=()=>{updateSearchClear('side');renderTree();};
    $('centerSearch').oninput=()=>{resetSelectionMode();updateSearchClear('center');renderCenter();};
    $('sideSearchClear').onclick=()=>{$('sideSearch').value='';updateSearchClear('side');renderTree();$('sideSearch').focus();};
    $('centerSearchClear').onclick=()=>{$('centerSearch').value='';updateSearchClear('center');renderCenter();$('centerSearch').focus();};
    $('managePeople').onclick=e=>openCreateMenu(e.currentTarget);
    $('sidebarToggle').onclick=()=>setSidebarHidden(true);
    $('sidebarReveal').onclick=()=>setSidebarHidden(false);
    document.querySelector('.sidebar').addEventListener('contextmenu',e=>{if(e.target.closest('[data-person],[data-group],button,input,.side-actions'))return;e.preventDefault();showMenu(e.clientX,e.clientY,[{label:'新建群组',action:()=>openGroupModal()},{label:'新建成员',action:()=>openMemberModal()}]);});
    $('gridDensity').oninput=event=>{
      gridDensity=clamp(Number(event.currentTarget.value)||0,0,2);
      const cards=$('cards');
      if(cards) cards.dataset.density=String(gridDensity);
    };
    $('gridDensity').onchange=()=>{state.settings.gridDensity=gridDensity;saveViewPreferences();};
    $('favoriteFirstToggle').onclick=()=>{const next=!state.settings?.favoritesFirst;state.settings.favoritesFirst=next;post('saveFavoritesFirst',{value:next});renderCenter();};
    $('minimizeWindow').onclick=e=>{e.stopPropagation();post('windowAction',{action:'minimize'});};$('maximizeWindow').onclick=e=>{e.stopPropagation();post('windowAction',{action:'maximize'});};$('closeWindow').onclick=e=>{e.stopPropagation();post('windowAction',{action:'close'});};
    $('titlebar').onmousedown=e=>{if(!e.target.closest('.window-actions'))post('windowAction',{action:'drag'});};
    $('titlebar').ondblclick=e=>{if(!e.target.closest('.window-actions'))post('windowAction',{action:'maximize'});};
    document.addEventListener('pointerdown',e=>{if(!e.target.closest('.context-menu,.card-more,.favorite-button,#managePeople,.custom-select,.sort,#gridDensityControl,#favoriteFirstToggle,#sidebarToggle,#sidebarReveal'))closeFloating();});
    document.addEventListener('dragover',e=>{if(hasFileDrag(e))e.preventDefault();});
    document.addEventListener('drop',e=>{if(hasFileDrag(e))e.preventDefault();});
    document.addEventListener('pointerover',e=>{const anchor=e.target.closest?.('[data-tooltip]');if(anchor&&!anchor.contains(e.relatedTarget))showTooltip(anchor,anchor.dataset.tooltip);});
    document.addEventListener('pointerout',e=>{const anchor=e.target.closest?.('[data-tooltip]');if(anchor&&!anchor.contains(e.relatedTarget))document.querySelector('.app-tooltip')?.remove();});
    document.addEventListener('focusin',e=>{const anchor=e.target.closest?.('[data-tooltip]');if(anchor)showTooltip(anchor,anchor.dataset.tooltip);});
    document.addEventListener('focusout',e=>{if(e.target.closest?.('[data-tooltip]'))document.querySelector('.app-tooltip')?.remove();});
    document.addEventListener('keydown',e=>{if(e.key==='Delete'&&selectedMembers.size&&!e.target.closest('input,textarea,[contenteditable="true"]')){e.preventDefault();confirmDeleteSelectedMembers();return;}if(e.key==='Escape'){closeFloating();const layer=document.querySelector('.modal-layer');if(!layer?.classList.contains('locked'))layer?.remove();}});
    window.addEventListener('resize',()=>{if(!layoutDrag)applyLayoutSettings();});
  }

  function setWindowIcon(mode){windowState=mode;const svg=$('maximizeWindow').querySelector('svg');svg.innerHTML=mode==='maximized'?'<rect x="5" y="3" width="8" height="8" rx="1"/><path d="M11 11v2H3V5h2"/>':'<rect x="3.25" y="3.25" width="9.5" height="9.5" rx="1"/>';}

  window.quoteVault={
    setState(next){state={...state,...next};const validMembers=new Set(state.people.map(x=>x.id));selectedMembers=new Map([...selectedMembers].filter(([id])=>validMembers.has(id)));if(memberEditTargetId&&!validMembers.has(memberEditTargetId)){memberEditTargetId=null;memberAvatarDraft=null;memberEditDirty=false;}applyTheme(state.settings?.theme);gridDensity=clamp(Number.isInteger(state.settings?.gridDensity)?state.settings.gridDensity:1,0,2);collapsedGroups=new Set(state.settings?.collapsedTreeNodes||[]);if(next.appVersion)$('appVersion').textContent=`${next.appVersion} · 本地聊天截图库`;setSidebarHidden(!!state.settings?.sidebarHidden,false);renderApp();setActivePanel(state.activePanel||'preview',true);},
    setDraft(next){const stillAdding=state.topView==='library'&&state.activePanel==='add';const wasDraft=!!draft;if(draft&&Object.hasOwn(draft,'tags'))next.tags=draft.tags;draft=next;if(!wasDraft)draftLibraryIds=state.selectedPersonId?[state.selectedPersonId]:[];setBusy(false);if(stillAdding)setActivePanel('add',true);else{renderApp();toast('截图已读取，可在“添加”中继续处理。');}},
    clearDraft(){draft=null;draftLibraryIds=[];renderAdd();},setBusy(value,text){Array.isArray(value)?setBusy(value[0],value[1]):setBusy(value,text);},
    showError:toast,showNotice,setWindowState:setWindowIcon,externalDragEnded(){screenshotDragCandidate=null;nativeScreenshotDrag=null;suppressCardClickUntil=performance.now()+300;document.querySelectorAll('.drag-over,.drop-copy,.drop-move').forEach(x=>x.classList.remove('drag-over','drop-copy','drop-move'));},
    setMemberAvatar(info){if(!memberEditTargetId)return;memberAvatarDraft=info?.dataUrl||'';memberEditDirty=true;const preview=$('memberAvatarPreview');if(preview&&memberAvatarDraft)preview.innerHTML=`<img src="${esc(memberAvatarDraft)}" alt="成员头像"/>`;if($('clearMemberAvatar'))$('clearMemberAvatar').disabled=!memberAvatarDraft;},
    favoriteChanged(info){
      const shot=state.screenshots.find(item=>item.id===info?.id);if(!shot)return;
      shot.isFavorite=!!info.isFavorite;
      document.querySelectorAll(`[data-favorite="${info.id}"]`).forEach(button=>{button.classList.toggle('active',shot.isFavorite);button.setAttribute('aria-pressed',shot.isFavorite?'true':'false');button.dataset.tooltip=shot.isFavorite?'取消收藏':'收藏';button.innerHTML=shot.isFavorite?starFilledSvg:starOutlineSvg;});
      const viewer=document.querySelector(`[data-viewer-favorite="${info.id}"]`);
      if(viewer){viewer.classList.toggle('active',shot.isFavorite);viewer.setAttribute('aria-pressed',shot.isFavorite?'true':'false');viewer.dataset.tooltip=shot.isFavorite?'取消收藏':'收藏';viewer.innerHTML=`${shot.isFavorite?starFilledSvg:starOutlineSvg}<span>${shot.isFavorite?'已收藏':'收藏'}</span>`;}
      if(state.settings?.favoritesFirst)renderCenter();
    },
    showDuplicate(info){modal(`<h2>发现重复图片</h2><p>图库中已经存在“${esc(info.originalFileName)}”。请选择如何处理。</p><div class="modal-actions"><button class="btn" data-skip>跳过</button><button class="btn" data-view>查看已有截图</button><button class="btn primary" data-import>仍然导入</button></div>`,layer=>{layer.querySelector('[data-skip]').onclick=()=>{layer.remove();post('resolveDuplicate',{action:'skip'});};layer.querySelector('[data-view]').onclick=()=>{layer.remove();post('resolveDuplicate',{action:'view'});};layer.querySelector('[data-import]').onclick=()=>{layer.remove();post('resolveDuplicate',{action:'import'});};});}
  };
  document.addEventListener('DOMContentLoaded',()=>{ensureDynamicUi();bindStaticEvents();post('ready');});
})();
