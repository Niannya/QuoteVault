(() => {
  const post = (type, payload = {}) => window.chrome?.webview
    ? window.chrome.webview.postMessage({ type, payload })
    : console.log('[QuoteVault]', type, payload);

  let state = {
    people: [], categories: [], screenshots: [], settings: {}, selectedPersonId: null,
    selectedScreenshotId: null, topView: 'library', activePanel: 'preview'
  };
  let draft = null;
  let viewMode = 'grid';
  let selectionMode = false;
  let selectedIds = new Set();
  let collapsedGroups = new Set();
  let editDirty = false;
  let windowState = 'normal';
  let dragPayload = null;
  const ungroupedKey = '__ungrouped__';

  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
  const selectedScreenshot = () => {
    const shot=state.screenshots.find(x=>x.id===state.selectedScreenshotId);
    if(!shot)return null;
    if(state.topView==='trash')return shot.deletedAt?shot:null;
    if(state.topView==='pending')return !shot.deletedAt&&shot.needsReview?shot:null;
    if(state.topView==='library')return state.selectedPersonId&&!shot.deletedAt&&!shot.needsReview&&shot.personIds.includes(state.selectedPersonId)?shot:null;
    return null;
  };
  const memberById = id => state.people.find(x => x.id === id);
  const selectedMember = () => memberById(state.selectedPersonId);
  const screenshotMembers = shot => (shot?.personIds ?? []).map(memberById).filter(Boolean);
  const keywords = value => String(value ?? '').split(/[,，;；]/).map(x => x.trim()).filter(Boolean);
  const fmtDate = value => {
    const d = new Date(value);
    return Number.isNaN(d.valueOf()) ? '' : `${d.getMonth() + 1}月${d.getDate()}日`;
  };
  const checkSvg = '<svg viewBox="0 0 16 16"><path d="m3.5 8.2 2.8 2.8 6.2-6.2"/></svg>';
  const moreSvg = '<svg viewBox="0 0 18 18" width="17" height="17" fill="currentColor"><circle cx="4" cy="9" r="1.2"/><circle cx="9" cy="9" r="1.2"/><circle cx="14" cy="9" r="1.2"/></svg>';

  function resetSelectionMode() {
    selectionMode = false; selectedIds.clear();
    $('batchMode')?.classList.remove('active');
  }

  function matchesScreenshot(shot, query) {
    if (!query) return true;
    const haystack = `${shot.originalFileName}\n${shot.messages.map(m=>m.text).join('\n')}\n${screenshotMembers(shot).map(p=>p.displayName).join('\n')}\n${(shot.keywords||[]).join('\n')}`;
    return haystack.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  }

  function ensureDynamicUi() {
    const toolbar = document.querySelector('.lib-toolbar');
    if (!$('batchMode')) {
      const button = document.createElement('button');
      button.id = 'batchMode'; button.className = 'iconbtn'; button.title = '批量选择'; button.setAttribute('aria-label','批量选择');
      button.innerHTML = '<svg viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="2.5" width="13" height="13" rx="3"/><path d="m5.5 9 2.2 2.2 4.8-5"/></svg>';
      toolbar.insertBefore(button, $('gridView'));
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
    const status = document.querySelector('.statusbar span');
    if (text) status.textContent = text;
    else if (!value) {
      const engine=state.settings?.ocrEngine;
      status.textContent=engine==='None'?'本地模式 · OCR 已关闭':engine==='PaddleOcrV6'?(state.settings?.paddleAvailable?'本地模式 · PaddleOCR v6 就绪':'本地模式 · PaddleOCR 未安装'):'本地模式 · Tesseract 就绪';
    }
  }

  function toast(message) {
    document.querySelector('.toast')?.remove();
    const node = document.createElement('div');
    node.className = 'toast'; node.textContent = message;
    Object.assign(node.style, { position:'fixed', right:'22px', bottom:'42px', zIndex:100,
      background:'#242421', color:'#fff', padding:'11px 15px', borderRadius:'10px',
      boxShadow:'0 12px 35px #0003', fontSize:'12px', maxWidth:'420px' });
    document.body.append(node);
    setTimeout(() => node.remove(), 3200);
  }

  function closeFloating() {
    document.querySelector('.context-menu')?.remove();
  }

  function showMenu(x, y, items) {
    closeFloating();
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = items.map((item, i) => item.separator
      ? `<div class="separator"></div>`
      : `<button data-menu="${i}" class="${item.danger ? 'danger' : ''}">${esc(item.label)}</button>`).join('');
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
    layer.addEventListener('mousedown', event => { if (event.target === layer) layer.remove(); });
    layer.querySelector('[data-cancel]')?.addEventListener('click', () => layer.remove());
    onReady?.(layer);
    return layer;
  }

  function askConfirm(title, text, action, danger = false, confirmLabel = '确定') {
    modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="modal-actions"><button class="btn" data-cancel>取消</button><button class="btn ${danger ? 'danger' : 'primary'}" data-confirm>${esc(confirmLabel)}</button></div>`, layer => {
      layer.querySelector('[data-confirm]').addEventListener('click', () => { layer.remove(); action(); });
    });
  }

  function ocrEngineOptions(selected=state.settings?.ocrEngine||'None') {
    return `<option value="None" ${selected==='None'?'selected':''}>不使用 OCR</option><option value="PaddleOcrV6" ${selected==='PaddleOcrV6'?'selected':''}>PaddleOCR v6${state.settings?.paddleAvailable?'':' · 未安装'}</option><option value="Tesseract" ${selected==='Tesseract'?'selected':''}>Tesseract 5</option>`;
  }

  function requestOcrChange(engine, target='settings', id=null, confirmOverwrite=false, onAccepted=null) {
    const payload={engine,target,id};
    const apply=()=>{
      if(engine==='PaddleOcrV6'&&!state.settings?.paddleAvailable){
        askConfirm('安装 PaddleOCR','PaddleOCR 运行环境和识别模型尚未安装。下载后预计占用约 900 MB，文件保存在本机。是否现在下载安装？',()=>{onAccepted?.();post('installPaddleOcr',payload);},false,'安装并启用');
      } else {onAccepted?.();post('setOcrEngine',payload);}
    };
    if(confirmOverwrite) askConfirm('重新识别截图','切换识别方式会重新识别当前截图，并替换尚未保存的消息内容。是否继续？',apply,false,'切换并识别');
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
    const checked = new Set(member?.categoryIds ?? (defaultGroupId ? [defaultGroupId] : []));
    const checks = state.categories.map(group => `<label class="group-check"><input type="checkbox" value="${group.id}" ${checked.has(group.id) ? 'checked' : ''}/><span>${esc(groupPath(group))}</span></label>`).join('') || '<span class="muted">尚未创建群组；成员将暂时显示在“未分组”。</span>';
    modal(`<h2>${member ? '编辑成员' : '新建成员'}</h2><p>成员就是一个截图图库；同一成员可以加入多个群组。</p><div class="modal-field"><label>成员名称</label><input id="entityName" value="${esc(member?.displayName || '')}" autofocus /></div><div class="modal-field"><label>加入群组</label><div class="group-checks">${checks}</div></div><div class="modal-actions"><button class="btn" data-cancel>取消</button><button class="btn primary" data-save>${member ? '保存' : '创建图库'}</button></div>`, layer => {
      const save = () => {
        const name = $('entityName').value.trim(); if (!name) return $('entityName').focus();
        const groupIds = [...layer.querySelectorAll('.group-check input:checked')].map(x => x.value);
        post(member ? 'updateMember' : 'createMember', member ? { id: member.id, name, groupIds } : { name, groupIds }); layer.remove();
      };
      layer.querySelector('[data-save]').addEventListener('click', save);
      $('entityName').addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    });
  }

  function renderTree() {
    $('trashCount').textContent = state.screenshots.filter(x => x.deletedAt).length;
    $('pendingCount').textContent = state.screenshots.filter(x => !x.deletedAt && x.needsReview).length;
    $('trashNav').classList.toggle('active', state.topView === 'trash');
    $('pendingNav').classList.toggle('active', state.topView === 'pending');
    const host = $('peopleTree');
    const query = $('sideSearch').value.trim().toLocaleLowerCase();
    const personHtml = (person, sourceGroupId = '') => {
      const count = state.screenshots.filter(x => !x.deletedAt && !x.needsReview && x.personIds.includes(person.id)).length;
      const palette = ['a1','a2','a3','a4','a5']; const cls = palette[Math.abs(hash(person.id)) % palette.length];
      return `<div class="friend ${state.selectedPersonId === person.id && state.topView === 'library' ? 'active' : ''}" draggable="true" data-person="${person.id}" data-source-group="${sourceGroupId}"><span class="avatar ${cls}">${esc(person.displayName.slice(0,1) || '?')}</span><span>${esc(person.displayName)}</span><span class="count">${count}</span></div>`;
    };
    const categoryHtml = (group, depth = 0) => {
      const assigned = state.people.filter(x => x.categoryIds.includes(group.id) && (!query || x.displayName.toLocaleLowerCase().includes(query)));
      const children = state.categories.filter(x => x.parentId === group.id);
      const nested = children.map(x => categoryHtml(x, depth + 1)).join('');
      const groupMatches = !query || group.name.toLocaleLowerCase().includes(query);
      const visibleAssigned = groupMatches && query ? state.people.filter(x=>x.categoryIds.includes(group.id)) : assigned;
      if (query && !groupMatches && !assigned.length && !nested) return '';
      const collapsed = collapsedGroups.has(group.id);
      return `<div class="group" style="margin-left:${depth * 9}px" data-group-wrap="${group.id}"><div class="group-title" data-group="${group.id}"><span class="chev">${collapsed ? '▶' : '▼'}</span>${esc(group.name)}</div><div class="group-content ${collapsed ? 'hidden' : ''}">${visibleAssigned.map(x=>personHtml(x,group.id)).join('')}${nested}</div></div>`;
    };
    const roots = state.categories.filter(x => !x.parentId).map(x => categoryHtml(x)).join('');
    const ungrouped = state.people.filter(x => !x.categoryIds.length && (!query || x.displayName.toLocaleLowerCase().includes(query)));
    const ungroupedCollapsed = collapsedGroups.has(ungroupedKey);
    const other = ungrouped.length ? `<div class="group" data-group-wrap="${ungroupedKey}"><div class="group-title" data-ungrouped><span class="chev">${ungroupedCollapsed?'▶':'▼'}</span>未分组</div><div class="group-content ${ungroupedCollapsed?'hidden':''}">${ungrouped.map(x=>personHtml(x,'')).join('')}</div></div>` : '';
    const globalMatches = query ? state.screenshots.filter(x=>!x.deletedAt && matchesScreenshot(x,query)).slice(0,8) : [];
    const global = query ? `<div class="global-results"><div class="global-results-title">全局截图 · ${globalMatches.length}${globalMatches.length===8?'＋':''}</div>${globalMatches.map(shot=>`<button class="global-shot" data-global-shot="${shot.id}"><b>${esc(shot.messages.find(x=>x.text)?.text||shot.originalFileName)}</b><span>${esc(screenshotMembers(shot).map(x=>x.displayName).join('、')|| (shot.needsReview?'待处理':'未关联成员'))}</span></button>`).join('')||'<div class="muted" style="padding:8px">未找到匹配截图</div>'}</div>` : '';
    host.innerHTML = (roots + other || (!query?'<div class="muted" style="padding:14px 9px">尚未创建成员</div>':'')) + global;
    host.querySelector('[data-ungrouped]')?.addEventListener('click',()=>{collapsedGroups.has(ungroupedKey)?collapsedGroups.delete(ungroupedKey):collapsedGroups.add(ungroupedKey);renderTree();});
    host.querySelectorAll('[data-global-shot]').forEach(node=>node.onclick=()=>{resetSelectionMode();post('selectGlobalScreenshot',{id:node.dataset.globalShot});});
    host.querySelectorAll('[data-person]').forEach(node => {
      node.addEventListener('click', () => {resetSelectionMode();post('selectPerson', { id: node.dataset.person });});
      node.addEventListener('contextmenu', e => { e.preventDefault(); const member = memberById(node.dataset.person); showMenu(e.clientX,e.clientY,[
        { label:'编辑成员与群组', action:()=>openMemberModal(member) }, { separator:true },
        { label:'删除成员', danger:true, action:()=>askConfirm('删除成员',`删除“${member.displayName}”？截图不会被删除，但会解除关联。`,()=>post('deleteMember',{id:member.id}),true) }
      ]); });
      node.addEventListener('dragstart',e=>{dragPayload={kind:'member',memberId:node.dataset.person,sourceGroupId:node.dataset.sourceGroup||null};e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',JSON.stringify(dragPayload));});
      node.addEventListener('dragend',()=>{dragPayload=null;document.querySelectorAll('.drag-over').forEach(x=>x.classList.remove('drag-over'));});
      node.addEventListener('dragover',e=>{if(dragPayload?.kind!=='screenshots')return;e.preventDefault();e.dataTransfer.dropEffect='move';node.classList.add('drag-over');});
      node.addEventListener('dragleave',()=>node.classList.remove('drag-over'));
      node.addEventListener('drop',e=>{if(dragPayload?.kind!=='screenshots')return;e.preventDefault();node.classList.remove('drag-over');post('moveScreenshots',{ids:dragPayload.ids,sourceMemberId:dragPayload.sourceMemberId,targetMemberId:node.dataset.person});resetSelectionMode();dragPayload=null;});
    });
    host.querySelectorAll('[data-group]').forEach(node => {
      node.addEventListener('click', () => { const id=node.dataset.group; collapsedGroups.has(id)?collapsedGroups.delete(id):collapsedGroups.add(id); renderTree(); });
      node.addEventListener('contextmenu', e => { e.preventDefault(); const group=state.categories.find(x=>x.id===node.dataset.group); showMenu(e.clientX,e.clientY,[
        {label:'新建子群组',action:()=>openGroupModal(null,group.id)}, {label:'新建成员',action:()=>openMemberModal(null,group.id)},
        {label:'重命名',action:()=>openGroupModal(group)}, {separator:true},
        {label:'删除群组',danger:true,action:()=>askConfirm('删除群组',`删除“${group.name}”？其成员不会被删除。`,()=>post('deleteGroup',{id:group.id}),true)}
      ]); });
      node.addEventListener('dragover',e=>{if(dragPayload?.kind!=='member')return;e.preventDefault();e.dataTransfer.dropEffect='move';node.classList.add('drag-over');});
      node.addEventListener('dragleave',()=>node.classList.remove('drag-over'));
      node.addEventListener('drop',e=>{if(dragPayload?.kind!=='member')return;e.preventDefault();node.classList.remove('drag-over');post('moveMember',{memberId:dragPayload.memberId,sourceGroupId:dragPayload.sourceGroupId,targetGroupId:node.dataset.group});dragPayload=null;});
    });
  }

  function hash(text) { let value=0; for(const ch of String(text)) value=((value<<5)-value+ch.charCodeAt(0))|0; return value; }

  function visibleScreenshots() {
    let items = state.screenshots;
    if (state.topView === 'trash') items = items.filter(x => !!x.deletedAt);
    else if (state.topView === 'pending') items = items.filter(x => !x.deletedAt && x.needsReview);
    else if (state.selectedPersonId) items = items.filter(x => !x.deletedAt && !x.needsReview && x.personIds.includes(state.selectedPersonId));
    else items = [];
    const query = $('centerSearch').value.trim().toLocaleLowerCase();
    if (query) items = items.filter(x => matchesScreenshot(x, query));
    return [...items].sort((a,b)=>new Date(b.importedAt)-new Date(a.importedAt));
  }

  function toggleSelectionMode() {
    selectionMode = !selectionMode; selectedIds.clear();
    $('batchMode').classList.toggle('active', selectionMode); renderCenter();
  }

  function renderBatchBar(items) {
    const bar = $('batchbar'); bar.classList.toggle('active', selectionMode);
    if (!selectionMode) { bar.innerHTML=''; return; }
    const trash = state.topView === 'trash';
    const pending=state.topView==='pending';
    bar.innerHTML = `<b>已选择 ${selectedIds.size} 张</b><button class="btn" id="selectAll">全选</button><button class="btn" id="clearSelection">清除</button><span class="spacer"></span>${trash ? '<button class="btn" id="batchRestore">恢复</button><button class="btn danger" id="batchDelete">永久删除</button>' : `${!pending?'<button class="btn" id="batchMove">移动…</button>':''}<button class="btn danger" id="batchTrash">移到回收站</button>`}<button class="btn" id="exitBatch">完成</button>`;
    $('selectAll').onclick=()=>{items.forEach(x=>selectedIds.add(x.id));renderCenter();};
    $('clearSelection').onclick=()=>{selectedIds.clear();renderCenter();}; $('exitBatch').onclick=toggleSelectionMode;
    $('batchTrash') && ($('batchTrash').onclick=()=>batchAction('trash'));
    $('batchRestore') && ($('batchRestore').onclick=()=>batchAction('restore'));
    $('batchDelete') && ($('batchDelete').onclick=()=>askConfirm('永久删除',`永久删除选中的 ${selectedIds.size} 张截图？`,()=>batchAction('deleteForever'),true));
    $('batchMove') && ($('batchMove').onclick=()=>openMoveScreenshotsModal([...selectedIds]));
  }

  function batchAction(action) { if(!selectedIds.size)return; post('batchAction',{action,ids:[...selectedIds]}); selectedIds.clear(); }

  function updateSearchClear(which) {
    const input=$(which==='side'?'sideSearch':'centerSearch');
    const button=$(which==='side'?'sideSearchClear':'centerSearchClear');
    button?.classList.toggle('visible',!!input?.value);
  }

  function bindScreenshotDropTarget(node, action) {
    node.addEventListener('dragover',event=>{if(dragPayload?.kind!=='screenshots'||dragPayload.sourceView!=='library')return;event.preventDefault();event.dataTransfer.dropEffect='move';node.classList.add('drag-over');});
    node.addEventListener('dragleave',()=>node.classList.remove('drag-over'));
    node.addEventListener('drop',event=>{if(dragPayload?.kind!=='screenshots'||dragPayload.sourceView!=='library')return;event.preventDefault();node.classList.remove('drag-over');post('batchAction',{action,ids:dragPayload.ids});resetSelectionMode();dragPayload=null;});
  }

  function bindMarqueeSelection(host) {
    host.onpointerdown=event=>{
      if(event.button!==0||event.target!==host)return;
      const start={x:event.clientX,y:event.clientY};let active=false;let rectNode=null;
      const move=e=>{
        if(!active&&Math.hypot(e.clientX-start.x,e.clientY-start.y)<4)return;
        if(!active){active=true;selectionMode=true;selectedIds.clear();$('batchMode').classList.add('active');rectNode=document.createElement('div');rectNode.className='selection-rect';document.body.append(rectNode);}
        const left=Math.min(start.x,e.clientX),top=Math.min(start.y,e.clientY),right=Math.max(start.x,e.clientX),bottom=Math.max(start.y,e.clientY);
        Object.assign(rectNode.style,{left:`${left}px`,top:`${top}px`,width:`${right-left}px`,height:`${bottom-top}px`});
        host.querySelectorAll('.card').forEach(card=>{const r=card.getBoundingClientRect(),hit=r.left<right&&r.right>left&&r.top<bottom&&r.bottom>top;card.classList.toggle('batch-selected',hit);hit?selectedIds.add(card.dataset.shot):selectedIds.delete(card.dataset.shot);});
        renderBatchBar(visibleScreenshots());host.classList.add('selection-mode');
      };
      const up=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);rectNode?.remove();if(active)renderCenter();};
      document.addEventListener('pointermove',move);document.addEventListener('pointerup',up,{once:true});
    };
  }

  function renderCenter() {
    if (state.topView === 'settings') return;
    const items = visibleScreenshots(); renderBatchBar(items);
    const title = state.topView === 'trash' ? '回收站' : state.topView === 'pending' ? '待处理图库' : selectedMember()?.displayName ?? '选择一个成员图库';
    $('libraryTitle').textContent=title;
    $('librarySub').textContent=state.topView==='trash'?`${items.length} 张已删除截图`:state.topView==='pending'?`${items.length} 张等待整理`:state.selectedPersonId?`${items.length} 张截图`:'';
    $('centerSearch').placeholder=state.topView==='trash'?'搜索回收站中的截图':state.topView==='pending'?'搜索待处理截图':'搜索当前图库中的消息、成员或关键词';
    const host=$('cards'); host.classList.toggle('list',viewMode==='list'); host.classList.toggle('selection-mode',selectionMode);
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
    host.innerHTML=items.map(shot=>{
      const members=screenshotMembers(shot).map(x=>x.displayName).join('、')||'未关联成员';
      const snippet=shot.messages.find(x=>x.text.trim())?.text||'尚未识别文字';
      const detail=shot.messages.slice(0,3).map(m=>m.text).join(' · ');
      return `<article class="card ${shot.id===state.selectedScreenshotId?'selected':''} ${selectedIds.has(shot.id)?'batch-selected':''}" draggable="${state.topView==='library'}" data-shot="${shot.id}"><span class="select-dot">${checkSvg}</span><button class="card-more" data-more="${shot.id}" title="更多操作" aria-label="更多操作">${moreSvg}</button><div class="thumb"><img class="real-image" src="${esc(shot.imageUrl)}" alt="截图"/></div><div class="cardline"><span class="snippet">${esc(snippet)}</span><span class="date">${fmtDate(shot.importedAt)}</span></div><div class="mini">${esc(members)} · ${shot.messages.length} 条消息${shot.needsReview?' · 待整理':''}${shot.keywords?.length?' · #'+esc(shot.keywords.join(' #')):''}</div><div class="card-details">${esc(detail)}</div></article>`;
    }).join('');
    host.querySelectorAll('[data-shot]').forEach(card=>{
      card.onclick=e=>{if(e.target.closest('[data-more]'))return;if(selectionMode){selectedIds.has(card.dataset.shot)?selectedIds.delete(card.dataset.shot):selectedIds.add(card.dataset.shot);renderCenter();}else post('selectScreenshot',{id:card.dataset.shot});};
      card.oncontextmenu=e=>{e.preventDefault();showScreenshotMenu(e.clientX,e.clientY,card.dataset.shot);};
      card.ondragstart=e=>{if(state.topView!=='library'){e.preventDefault();return;}const id=card.dataset.shot;const ids=selectionMode&&selectedIds.has(id)?[...selectedIds]:[id];dragPayload={kind:'screenshots',ids,sourceMemberId:state.selectedPersonId,sourceView:state.topView};e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',JSON.stringify(dragPayload));};
      card.ondragend=()=>{dragPayload=null;document.querySelectorAll('.drag-over').forEach(x=>x.classList.remove('drag-over'));};
    });
    host.querySelectorAll('[data-more]').forEach(button=>button.onclick=e=>{e.stopPropagation();const r=button.getBoundingClientRect();showScreenshotMenu(r.right,r.bottom+4,button.dataset.more);});
    bindMarqueeSelection(host);
  }

  function showScreenshotMenu(x,y,id){
    const shot=state.screenshots.find(s=>s.id===id); if(!shot)return;
    showMenu(x,y,shot.deletedAt?[
      {label:'恢复到图库',action:()=>post('restoreFromTrash',{id})},{separator:true},{label:'永久删除',danger:true,action:()=>askConfirm('永久删除','删除后无法恢复，确定继续？',()=>post('permanentDelete',{id}),true)}
    ]:shot.needsReview?[
      {label:'继续编辑',action:()=>{state.selectedScreenshotId=id;setActivePanel('edit',true)}},{label:'完成整理',action:()=>post('finishPending',{id})},{separator:true},{label:'移到回收站',danger:true,action:()=>post('moveToTrash',{id})}
    ]:[
      {label:'复制到剪贴板',action:()=>post('copyImage',{id})},{label:'移动到其他图库…',action:()=>openMoveScreenshotsModal([id])},{label:'在资源管理器中显示',action:()=>post('showFile',{id})},{separator:true},{label:'移到回收站',danger:true,action:()=>post('moveToTrash',{id})}
    ]);
  }

  function openMoveScreenshotsModal(ids) {
    const available=state.people.filter(p=>p.id!==state.selectedPersonId);
    const memberButton=(p,depth=0)=>`<button class="library-choice" data-library="${p.id}" style="--depth:${depth}"><span class="avatar a${Math.abs(hash(p.id))%5+1}">${esc(p.displayName.slice(0,1)||'?')}</span><span>${esc(p.displayName)}</span></button>`;
    const groupBlock=(group,depth=0)=>{const members=available.filter(p=>p.categoryIds.includes(group.id));const children=state.categories.filter(x=>x.parentId===group.id);const body=members.map(p=>memberButton(p,depth)).join('')+children.map(x=>groupBlock(x,depth+1)).join('');return body?`<div class="library-group"><div class="library-group-title" style="--depth:${depth}">${esc(group.name)}</div>${body}</div>`:'';};
    const grouped=state.categories.filter(x=>!x.parentId).map(x=>groupBlock(x)).join('');
    const ungrouped=available.filter(p=>!p.categoryIds.length).map(p=>memberButton(p)).join('');
    const picker=grouped+(ungrouped?`<div class="library-group"><div class="library-group-title">未分组</div>${ungrouped}</div>`:'');
    modal(`<h2>移动到其他图库</h2><p>所选截图将从当前成员图库移动到目标成员图库。</p><div class="modal-field"><label>目标成员图库</label><div class="library-picker" id="movePicker">${picker||'<div class="picker-empty">没有可用的目标图库</div>'}</div></div><div class="modal-actions"><button class="btn" data-cancel>取消</button><button class="btn primary" data-move disabled>移动</button></div>`,layer=>{
      let target=null;const move=layer.querySelector('[data-move]');
      layer.querySelectorAll('[data-library]').forEach(button=>button.onclick=()=>{target=button.dataset.library;layer.querySelectorAll('[data-library]').forEach(x=>x.classList.toggle('active',x===button));move.disabled=false;});
      move.onclick=()=>{if(!target)return;layer.remove();post('moveScreenshots',{ids,sourceMemberId:state.selectedPersonId,targetMemberId:target});resetSelectionMode();};
    });
  }

  function setActivePanel(name, force=false) {
    if(!force&&editDirty&&state.activePanel==='edit'&&name!=='edit') return askConfirm('放弃修改','编辑内容尚未保存，确定放弃吗？',()=>{editDirty=false;setActivePanel(name,true);});
    if(state.topView==='trash'&&name!=='preview')name='preview';
    if(state.topView==='pending'&&name==='add')name='preview';
    if(name!==state.activePanel)resetSelectionMode();
    state.activePanel=name;
    document.querySelectorAll('.tab').forEach(tab=>tab.classList.toggle('active',tab.dataset.panel===name));
    document.querySelectorAll('.panel').forEach(panel=>panel.classList.toggle('active',panel.id===name));
    renderCenter();renderWorkbench();post('panelChanged',{name});
  }

  function renderWorkbench(){
    $('pendingCount').textContent=state.screenshots.filter(x=>!x.deletedAt&&x.needsReview).length;
    document.querySelectorAll('.tab').forEach(tab=>tab.classList.toggle('hidden',(state.topView==='trash'&&tab.dataset.panel!=='preview')||(state.topView==='pending'&&tab.dataset.panel==='add')));
    renderPreview();renderAdd();renderEdit();
  }
  const emptyPanel=(host,title,text)=>host.innerHTML=`<div class="empty-state"><div><h2>${esc(title)}</h2><p>${esc(text)}</p></div></div>`;

  function renderPreview(){
    const host=$('preview'),shot=selectedScreenshot();
    if(!shot){emptyPanel(host,state.topView==='trash'?'选择回收站中的截图':state.topView==='pending'?'选择一张待处理截图':'选择一张截图',state.topView==='trash'?'选择后可以还原或永久删除。':state.topView==='pending'?'选择后可以继续编辑或完成整理。':'选择后可查看大图、消息内容并复制原图。');return;}
    const members=screenshotMembers(shot), messages=shot.messages.map(m=>`<div><span class="msg-person">${esc(memberById(m.personId)?.displayName||'未指定')}</span>${esc(m.text)}</div>`).join('')||'<span class="muted">尚未识别到消息</span>';
    const actions=state.topView==='trash'?`<button class="btn" id="cancelPreview">取消</button><button class="btn" id="restoreShot">还原截图</button><button class="btn danger" id="deleteForever">永久删除</button>`:state.topView==='pending'?`<button class="btn" id="cancelPreview">取消</button><button class="btn" id="editPending">继续编辑</button><button class="btn primary" id="finishPending">完成整理</button>`:`<button class="btn" id="cancelPreview">取消</button><button class="btn primary" id="copyShot">复制到剪贴板</button>`;
    host.innerHTML=`<div class="panel-header"><h2>${state.topView==='trash'?'回收站预览':state.topView==='pending'?'待处理截图':'截图预览'}</h2><span class="muted">${new Date(shot.importedAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span></div><div class="bigpreview"><img class="real-image" src="${esc(shot.imageUrl)}" alt="截图预览"/></div>${shot.ocrEngine?`<div class="engine-note">${esc(ocrSummary(shot.ocrEngine,shot.confidence))}</div>`:''}<div class="section"><div class="section-title">关联成员</div><div class="chips">${members.map(x=>`<span class="chip">${esc(x.displayName)}</span>`).join('')||'<span class="muted">未关联</span>'}</div></div>${shot.keywords?.length?`<div class="section"><div class="section-title">关键词</div><div class="chips">${shot.keywords.map(x=>`<span class="chip">#${esc(x)}</span>`).join('')}</div></div>`:''}<div class="section"><div class="section-title">消息内容</div><div class="message-box">${messages}</div></div><div class="actions">${actions}</div>`;
    $('cancelPreview').onclick=()=>post('clearScreenshotSelection');
    $('copyShot') && ($('copyShot').onclick=()=>post('copyImage',{id:shot.id}));
    $('restoreShot') && ($('restoreShot').onclick=()=>post('restoreFromTrash',{id:shot.id}));
    $('deleteForever') && ($('deleteForever').onclick=()=>askConfirm('永久删除','删除后无法恢复，确定继续？',()=>post('permanentDelete',{id:shot.id}),true));
    $('editPending') && ($('editPending').onclick=()=>setActivePanel('edit'));
    $('finishPending') && ($('finishPending').onclick=()=>post('finishPending',{id:shot.id}));
  }

  function renderAdd(){
    const host=$('add'),current=selectedMember();
    if(!draft){host.innerHTML=`<div class="panel-header"><h2>添加截图</h2></div><div class="ocr-quick"><label for="addOcrEngine">识别方式</label><select id="addOcrEngine">${ocrEngineOptions()}</select></div><div class="dropzone" id="dropzone"><div><div class="dropicon">＋</div><b>拖入截图或选择本地文件</b><div class="or">支持多选 PNG、JPG、BMP、GIF</div><button class="btn" id="chooseImage">选择图片</button></div></div><div class="formrow"><button class="btn" id="clipboardImage" style="width:100%">从剪贴板读取图片</button></div><div class="formrow"><label>默认加入</label><div class="field" style="display:flex;align-items:center">${esc(current?.displayName||'请先选择成员图库')}</div><button class="btn" id="quickCreateMember" style="width:100%;margin-top:8px">＋ 新建成员图库</button></div><div class="pending-note">单张图片可直接加入当前图库；批量导入会进入待处理，方便统一整理。</div>`;
      $('addOcrEngine').onchange=e=>requestOcrChange(e.target.value,'settings');
      $('chooseImage').onclick=()=>post('chooseImage');$('clipboardImage').onclick=()=>post('prepareClipboard');$('quickCreateMember').onclick=()=>openMemberModal();
      const dz=$('dropzone');['dragenter','dragover'].forEach(n=>dz.addEventListener(n,e=>{e.preventDefault();dz.style.borderColor='#444';}));['dragleave','drop'].forEach(n=>dz.addEventListener(n,e=>{e.preventDefault();dz.style.borderColor='';}));
      dz.addEventListener('drop',e=>readDroppedFiles([...e.dataTransfer.files].filter(f=>f.type.startsWith('image/'))));return;
    }
    const rows=(draft.messages?.length?draft.messages:[{id:crypto.randomUUID(),text:'',personId:current?.id||null}]).map(m=>({...m,personId:m.personId||current?.id||null}));
    host.innerHTML=`<div class="panel-header"><h2>添加并校正</h2><span class="muted">${esc(ocrSummary(draft.ocrEngine||'OCR',draft.confidence))}</span></div><div class="ocr-quick"><label for="draftOcrEngine">识别方式</label><select id="draftOcrEngine">${ocrEngineOptions()}</select><button class="btn" id="rerunDraftOcr" ${state.settings?.ocrEngine==='None'?'disabled':''}>重新识别</button></div><div class="bigpreview"><img class="real-image" src="${esc(draft.dataUrl)}"/></div><div class="edit-tip">识别到的昵称显示在 ID 栏；群等级不会写入消息内容</div><div class="message-editor compact"><div class="message-editor-head"><span>ID（可不指定）</span><span>消息内容</span></div><div class="message-list" id="draftChatStream">${rows.map(messageRow).join('')}</div><button class="message-add" id="addDraftMessage">＋ 添加一条消息</button></div><div class="section"><div class="section-title">目标图库</div><div class="chips">${current?`<span class="chip">${esc(current.displayName)}</span>`:'<span class="muted">未选择成员图库</span>'}</div></div><div class="section"><div class="section-title">关键词（可选，以逗号分隔）</div><input class="keyword-input" id="draftKeywords" placeholder="例如：加班，名场面"/></div><div class="actions"><button class="btn" id="cancelDraft">取消</button><button class="btn" id="commitPending">暂存</button><button class="btn primary" id="commitCurrent" ${current?'':'disabled'}>加入图库</button></div>`;
    bindMessageEditor(host);
    $('draftOcrEngine').onchange=e=>{const engine=e.target.value;e.target.value=state.settings?.ocrEngine||'None';requestOcrChange(engine,'draft',null,true);};
    $('rerunDraftOcr').onclick=()=>askConfirm('重新识别截图','重新识别会替换尚未保存的消息内容。是否继续？',()=>requestOcrChange(state.settings?.ocrEngine||'None','draft'),false,'重新识别');
    $('addDraftMessage').onclick=()=>{$('draftChatStream').insertAdjacentHTML('beforeend',messageRow({id:crypto.randomUUID(),personId:null,text:''}));bindMessageEditor(host);$('draftChatStream').lastElementChild.querySelector('[data-text]').focus();};
    $('cancelDraft').onclick=()=>{draft=null;post('cancelDraft');renderAdd();};
    $('commitPending').onclick=()=>commitDraft(true,current);$('commitCurrent').onclick=()=>commitDraft(false,current);
  }

  function collectMessageRows(streamId){return [...$(streamId).querySelectorAll('.message-row')].map((r,i)=>({id:r.dataset.message||crypto.randomUUID(),sortOrder:i,personId:r.querySelector('[data-speaker]').value||null,detectedNickname:r.dataset.detected||null,text:r.querySelector('[data-text]').value.trim()})).filter(x=>x.text);}
  function commitDraft(pending,current){post('commitDraft',{pending,personId:current?.id||null,keywords:keywords($('draftKeywords')?.value),messages:collectMessageRows('draftChatStream')});}
  function readDroppedFiles(files){if(!files.length)return;Promise.all(files.map(file=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve({name:file.name,dataUrl:r.result});r.onerror=reject;r.readAsDataURL(file);}))).then(items=>items.length===1?post('prepareDroppedImage',items[0]):post('prepareDroppedImages',{items}));}
  function speakerOptions(id,detectedNickname){const detected=!id&&detectedNickname?`<option value="" selected>识别到：${esc(detectedNickname)}（请选择成员）</option>`:'';return `${detected}<option value="" ${!id&&!detectedNickname?'selected':''}>未指定</option>${state.people.map(p=>`<option value="${p.id}" ${p.id===id?'selected':''}>${esc(p.displayName)}</option>`).join('')}`;}

  function renderEdit(){
    const host=$('edit'),shot=selectedScreenshot(); if(!shot||shot.deletedAt){emptyPanel(host,'选择一张截图','从成员图库中选择截图后，可直接修改聊天内容。');return;}
    const rows=shot.messages.length?shot.messages:[{id:crypto.randomUUID(),personId:state.selectedPersonId,text:''}];
    host.innerHTML=`<div class="panel-header"><h2>${state.topView==='pending'?'继续处理截图':'编辑截图'}</h2><span class="muted">${rows.length} 条消息</span></div><div class="ocr-quick"><label for="editOcrEngine">识别方式</label><select id="editOcrEngine">${ocrEngineOptions()}</select><button class="btn" id="rerunOcr" ${state.settings?.ocrEngine==='None'?'disabled':''}>重新识别</button></div><div class="edit-tip">识别到的昵称显示在 ID 栏；群等级不会写入消息内容</div><div class="message-editor"><div class="message-editor-head"><span>ID（可不指定）</span><span>消息内容</span><span></span></div><div class="message-list" id="chatStream">${rows.map(messageRow).join('')}</div><button class="message-add" id="addMessage">＋ 添加一条消息</button></div><div class="section"><div class="section-title">关键词（可选）</div><input class="keyword-input" id="editKeywords" value="${esc((shot.keywords||[]).join('，'))}" placeholder="以逗号分隔"/></div><div class="actions"><button class="btn" id="cancelEdit">取消</button><button class="btn primary" id="saveEdit">${state.topView==='pending'?'保存并完成':'保存修改'}</button></div>`;
    bindEdit();$('addMessage').onclick=()=>{$('chatStream').insertAdjacentHTML('beforeend',messageRow({id:crypto.randomUUID(),personId:null,text:''}));editDirty=true;bindEdit();$('chatStream').lastElementChild.querySelector('[data-text]').focus();};
    $('cancelEdit').onclick=()=>{editDirty=false;setActivePanel('preview',true);};$('saveEdit').onclick=saveEdit;
    $('editOcrEngine').onchange=e=>{const engine=e.target.value;e.target.value=state.settings?.ocrEngine||'None';requestOcrChange(engine,'edit',shot.id,true,()=>editDirty=false);};
    $('rerunOcr').onclick=()=>askConfirm('重新识别截图','重新识别会替换尚未保存的消息内容。是否继续？',()=>{editDirty=false;requestOcrChange(state.settings?.ocrEngine||'None','edit',shot.id);},false,'重新识别');
  }
  function messageRow(m){return `<div class="message-row" data-message="${esc(m.id||'')}" data-detected="${esc(m.detectedNickname||'')}"><select class="message-speaker" data-speaker aria-label="消息 ID">${speakerOptions(m.personId,m.detectedNickname)}</select><textarea class="message-text" data-text rows="2" aria-label="消息内容" placeholder="输入消息内容">${esc(m.text)}</textarea><button class="message-remove" data-remove title="删除这条消息" aria-label="删除这条消息">×</button></div>`;}
  function bindMessageEditor(host){host.querySelectorAll('[data-remove]').forEach(n=>n.onclick=()=>n.closest('.message-row').remove());}
  function bindEdit(){const h=$('edit');h.querySelectorAll('textarea,select,input').forEach(n=>n.oninput=()=>editDirty=true);h.querySelectorAll('[data-remove]').forEach(n=>n.onclick=()=>{n.closest('.message-row').remove();editDirty=true;});}
  function saveEdit(){const shot=selectedScreenshot(),messages=collectMessageRows('chatStream');post('saveEdit',{id:shot.id,messages,personIds:[...new Set(messages.map(x=>x.personId).filter(Boolean))],keywords:keywords($('editKeywords').value)});editDirty=false;}

  function renderSettings(){
    const s=state.settings||{},keys=[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].concat(Array.from({length:12},(_,i)=>`F${i+1}`));
    const selected=['None','PaddleOcrV6','Tesseract'].includes(s.ocrEngine)?s.ocrEngine:'None';
    const paddleStatus=s.paddleAvailable?'PaddleOCR 已安装，可直接使用':'PaddleOCR 尚未安装；切换时会先显示安装确认，不会自动下载';
    $('settingsPage').innerHTML=`<h1>设置</h1><div class="settings-lead">管理 QuoteVault 的 OCR、快捷键、数据与备份。</div><div class="settings-card"><h2>OCR 引擎</h2><p>选择后立即生效。默认不进行 OCR；PaddleOCR 适合中文聊天截图，但运行环境与模型约占用 900 MB。</p><div class="ocr-row"><select id="ocrEngine">${ocrEngineOptions(selected)}</select><span class="muted">${paddleStatus}</span></div></div><div class="settings-card"><h2>全局收录快捷键</h2><p>按下快捷键后，将剪贴板图片静默加入待处理。</p><div class="hotkey-row"><label><input id="hotCtrl" type="checkbox" ${s.hotKeyCtrl?'checked':''}/>Ctrl</label><label><input id="hotAlt" type="checkbox" ${s.hotKeyAlt?'checked':''}/>Alt</label><label><input id="hotShift" type="checkbox" ${s.hotKeyShift?'checked':''}/>Shift</label><select id="hotKey">${keys.map(k=>`<option ${k===s.hotKey?'selected':''}>${k}</option>`).join('')}</select><button class="btn primary" id="saveHotKey">保存快捷键</button></div></div><div class="settings-card"><h2>数据与备份</h2><p>备份包含索引、成员、群组、关键词和全部原图。</p><div class="smallrow"><button class="btn" id="backupData">导出完整备份</button><button class="btn" id="restoreData">从备份恢复</button></div></div>`;
    $('ocrEngine').onchange=e=>{const engine=e.target.value;e.target.value=selected;requestOcrChange(engine,draft?'draft':'settings',null,!!draft);};
    $('saveHotKey').onclick=()=>{
      if(!$('hotCtrl').checked&&!$('hotAlt').checked&&!$('hotShift').checked)return toast('至少选择一个修饰键。');
      post('saveHotKeySettings',{hotKeyCtrl:$('hotCtrl').checked,hotKeyAlt:$('hotAlt').checked,hotKeyShift:$('hotShift').checked,hotKey:$('hotKey').value});toast('快捷键已保存');
    };
    $('backupData').onclick=()=>post('createBackup');$('restoreData').onclick=()=>askConfirm('恢复备份','恢复会替换当前图库；操作前会自动创建安全备份。',()=>post('restoreBackup'));
  }

  function renderApp(){
    ensureDynamicUi();const settings=state.topView==='settings';document.querySelector('.workspace').classList.toggle('settings-mode',settings);
    document.querySelectorAll('[data-top]').forEach(x=>x.classList.toggle('active',x.dataset.top===(settings?'settings':'library')));
    if(settings){closeFloating();renderSettings();return;} updateSearchClear('side');updateSearchClear('center');renderTree();renderCenter();renderWorkbench();
  }

  function bindStaticEvents(){
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
    document.querySelector('.sidebar').addEventListener('contextmenu',e=>{if(e.target.closest('[data-person],[data-group],button,input,.side-actions'))return;e.preventDefault();showMenu(e.clientX,e.clientY,[{label:'新建群组',action:()=>openGroupModal()},{label:'新建成员',action:()=>openMemberModal()}]);});
    $('gridView').onclick=()=>{resetSelectionMode();viewMode='grid';$('gridView').classList.add('active');$('listView').classList.remove('active');renderCenter();};
    $('listView').onclick=()=>{resetSelectionMode();viewMode='list';$('listView').classList.add('active');$('gridView').classList.remove('active');renderCenter();};
    $('minimizeWindow').onclick=e=>{e.stopPropagation();post('windowAction',{action:'minimize'});};$('maximizeWindow').onclick=e=>{e.stopPropagation();post('windowAction',{action:'maximize'});};$('closeWindow').onclick=e=>{e.stopPropagation();post('windowAction',{action:'close'});};
    $('titlebar').onmousedown=e=>{if(!e.target.closest('.window-actions'))post('windowAction',{action:'drag'});};
    $('titlebar').ondblclick=e=>{if(!e.target.closest('.window-actions'))post('windowAction',{action:'maximize'});};
    document.addEventListener('pointerdown',e=>{if(!e.target.closest('.context-menu,.card-more,#managePeople'))closeFloating();});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeFloating();document.querySelector('.modal-layer')?.remove();}});
  }

  function setWindowIcon(mode){windowState=mode;const svg=$('maximizeWindow').querySelector('svg');svg.innerHTML=mode==='maximized'?'<rect x="5" y="3" width="8" height="8" rx="1"/><path d="M11 11v2H3V5h2"/>':'<rect x="3.25" y="3.25" width="9.5" height="9.5" rx="1"/>';}

  window.quoteVault={
    setState(next){state={...state,...next};renderApp();setActivePanel(state.activePanel||'preview',true);},
    setDraft(next){const stillAdding=state.topView==='library'&&state.activePanel==='add';draft=next;setBusy(false);if(stillAdding)setActivePanel('add',true);else{renderApp();toast('截图识别已完成，可在“添加”中继续处理。');}},
    clearDraft(){draft=null;renderAdd();},setBusy(value,text){Array.isArray(value)?setBusy(value[0],value[1]):setBusy(value,text);},
    showError:toast,setWindowState:setWindowIcon,
    showDuplicate(info){modal(`<h2>发现重复图片</h2><p>图库中已经存在“${esc(info.originalFileName)}”。请选择如何处理。</p><div class="modal-actions"><button class="btn" data-skip>跳过</button><button class="btn" data-view>查看已有截图</button><button class="btn primary" data-import>仍然导入</button></div>`,layer=>{layer.querySelector('[data-skip]').onclick=()=>{layer.remove();post('resolveDuplicate',{action:'skip'});};layer.querySelector('[data-view]').onclick=()=>{layer.remove();post('resolveDuplicate',{action:'view'});};layer.querySelector('[data-import]').onclick=()=>{layer.remove();post('resolveDuplicate',{action:'import'});};});}
  };
  document.addEventListener('DOMContentLoaded',()=>{ensureDynamicUi();bindStaticEvents();post('ready');});
})();
