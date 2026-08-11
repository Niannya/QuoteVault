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

  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
  const selectedScreenshot = () => state.screenshots.find(x => x.id === state.selectedScreenshotId) ?? null;
  const memberById = id => state.people.find(x => x.id === id);
  const selectedMember = () => memberById(state.selectedPersonId);
  const screenshotMembers = shot => (shot?.personIds ?? []).map(memberById).filter(Boolean);
  const keywords = value => String(value ?? '').split(/[,，;；]/).map(x => x.trim()).filter(Boolean);
  const fmtDate = value => {
    const d = new Date(value);
    return Number.isNaN(d.valueOf()) ? '' : `${d.getMonth() + 1}月${d.getDate()}日`;
  };

  function ensureDynamicUi() {
    const toolbar = document.querySelector('.lib-toolbar');
    if (!$('batchMode')) {
      const button = document.createElement('button');
      button.id = 'batchMode'; button.className = 'iconbtn'; button.title = '批量选择'; button.textContent = '✓';
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

  function setBusy(value, text = '') {
    document.body.classList.toggle('loading', !!value);
    const status = document.querySelector('.statusbar span');
    if (text) status.textContent = text;
    else if (!value) status.textContent = '本地模式 · OCR 就绪';
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

  function askConfirm(title, text, action, danger = false) {
    modal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="modal-actions"><button class="btn" data-cancel>取消</button><button class="btn ${danger ? 'danger' : 'primary'}" data-confirm>确定</button></div>`, layer => {
      layer.querySelector('[data-confirm]').addEventListener('click', () => { layer.remove(); action(); });
    });
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
    $('trashNav').classList.toggle('active', state.topView === 'trash');
    const host = $('peopleTree');
    const query = $('sideSearch').value.trim().toLocaleLowerCase();
    const seen = new Set();
    const personHtml = person => {
      seen.add(person.id);
      const count = state.screenshots.filter(x => !x.deletedAt && !x.needsReview && x.personIds.includes(person.id)).length;
      const palette = ['a1','a2','a3','a4','a5']; const cls = palette[Math.abs(hash(person.id)) % palette.length];
      return `<div class="friend ${state.selectedPersonId === person.id && state.topView !== 'trash' ? 'active' : ''}" data-person="${person.id}"><span class="avatar ${cls}">${esc(person.displayName.slice(0,1) || '?')}</span><span>${esc(person.displayName)}</span><span class="count">${count}</span></div>`;
    };
    const categoryHtml = (group, depth = 0) => {
      const assigned = state.people.filter(x => x.categoryIds.includes(group.id) && (!query || x.displayName.toLocaleLowerCase().includes(query)));
      const children = state.categories.filter(x => x.parentId === group.id);
      const nested = children.map(x => categoryHtml(x, depth + 1)).join('');
      if (query && !assigned.length && !nested) return '';
      const collapsed = collapsedGroups.has(group.id);
      return `<div class="group" style="margin-left:${depth * 9}px" data-group-wrap="${group.id}"><div class="group-title" data-group="${group.id}"><span class="chev">${collapsed ? '▶' : '▼'}</span>${esc(group.name)}</div><div class="group-content ${collapsed ? 'hidden' : ''}">${assigned.map(personHtml).join('')}${nested}</div></div>`;
    };
    const roots = state.categories.filter(x => !x.parentId).map(x => categoryHtml(x)).join('');
    const ungrouped = state.people.filter(x => !x.categoryIds.length && (!query || x.displayName.toLocaleLowerCase().includes(query)));
    const other = ungrouped.length ? `<div class="group"><div class="group-title"><span class="chev">▼</span>未分组</div>${ungrouped.map(personHtml).join('')}</div>` : '';
    host.innerHTML = roots + other || '<div class="muted" style="padding:14px 9px">没有匹配的成员</div>';
    host.querySelectorAll('[data-person]').forEach(node => {
      node.addEventListener('click', () => post('selectPerson', { id: node.dataset.person }));
      node.addEventListener('contextmenu', e => { e.preventDefault(); const member = memberById(node.dataset.person); showMenu(e.clientX,e.clientY,[
        { label:'编辑成员与群组', action:()=>openMemberModal(member) }, { separator:true },
        { label:'删除成员', danger:true, action:()=>askConfirm('删除成员',`删除“${member.displayName}”？截图不会被删除，但会解除关联。`,()=>post('deleteMember',{id:member.id}),true) }
      ]); });
    });
    host.querySelectorAll('[data-group]').forEach(node => {
      node.addEventListener('click', () => { const id=node.dataset.group; collapsedGroups.has(id)?collapsedGroups.delete(id):collapsedGroups.add(id); renderTree(); });
      node.addEventListener('contextmenu', e => { e.preventDefault(); const group=state.categories.find(x=>x.id===node.dataset.group); showMenu(e.clientX,e.clientY,[
        {label:'新建子群组',action:()=>openGroupModal(null,group.id)}, {label:'新建成员',action:()=>openMemberModal(null,group.id)},
        {label:'重命名',action:()=>openGroupModal(group)}, {separator:true},
        {label:'删除群组',danger:true,action:()=>askConfirm('删除群组',`删除“${group.name}”？其成员不会被删除。`,()=>post('deleteGroup',{id:group.id}),true)}
      ]); });
    });
  }

  function hash(text) { let value=0; for(const ch of String(text)) value=((value<<5)-value+ch.charCodeAt(0))|0; return value; }

  function visibleScreenshots() {
    let items = state.screenshots;
    if (state.topView === 'trash') items = items.filter(x => !!x.deletedAt);
    else if (state.activePanel === 'pending') items = items.filter(x => !x.deletedAt && x.needsReview);
    else if (state.selectedPersonId) items = items.filter(x => !x.deletedAt && !x.needsReview && x.personIds.includes(state.selectedPersonId));
    else items = [];
    const query = $('centerSearch').value.trim().toLocaleLowerCase();
    if (query) items = items.filter(x => `${x.originalFileName}\n${x.messages.map(m=>m.text).join('\n')}\n${screenshotMembers(x).map(p=>p.displayName).join('\n')}\n${(x.keywords||[]).join('\n')}`.toLocaleLowerCase().includes(query));
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
    bar.innerHTML = `<b>已选择 ${selectedIds.size} 张</b><button class="btn" id="selectAll">全选</button><button class="btn" id="clearSelection">清除</button><span class="spacer"></span>${trash ? '<button class="btn" id="batchRestore">恢复</button><button class="btn danger" id="batchDelete">永久删除</button>' : '<button class="btn danger" id="batchTrash">移到回收站</button>'}<button class="btn" id="exitBatch">完成</button>`;
    $('selectAll').onclick=()=>{items.forEach(x=>selectedIds.add(x.id));renderCenter();};
    $('clearSelection').onclick=()=>{selectedIds.clear();renderCenter();}; $('exitBatch').onclick=toggleSelectionMode;
    $('batchTrash') && ($('batchTrash').onclick=()=>batchAction('trash'));
    $('batchRestore') && ($('batchRestore').onclick=()=>batchAction('restore'));
    $('batchDelete') && ($('batchDelete').onclick=()=>askConfirm('永久删除',`永久删除选中的 ${selectedIds.size} 张截图？`,()=>batchAction('deleteForever'),true));
  }

  function batchAction(action) { if(!selectedIds.size)return; post('batchAction',{action,ids:[...selectedIds]}); selectedIds.clear(); }

  function renderCenter() {
    if (state.topView === 'settings') return;
    const items = visibleScreenshots(); renderBatchBar(items);
    const title = state.topView === 'trash' ? '回收站' : state.activePanel === 'pending' ? '待处理图库' : selectedMember()?.displayName ?? '选择一个成员图库';
    $('libraryTitle').textContent=title;
    $('librarySub').textContent=state.topView==='trash'?`${items.length} 张已删除截图`:state.activePanel==='pending'?`${items.length} 张等待整理`:state.selectedPersonId?`${items.length} 张截图`:'';
    $('centerSearch').placeholder=state.topView==='trash'?'搜索回收站':state.activePanel==='pending'?'搜索待处理截图':'搜索消息、成员或关键词';
    const host=$('cards'); host.classList.toggle('list',viewMode==='list'); host.classList.toggle('selection-mode',selectionMode);
    if(!state.selectedPersonId && state.activePanel!=='pending' && state.topView!=='trash') {
      host.innerHTML=`<div class="empty-state" style="grid-column:1/-1"><div><h2>选择一个成员图库</h2><p>从左侧选择成员，或新建群组与成员。</p><button class="btn primary" id="emptyCreate">新建成员图库</button></div></div>`;
      $('emptyCreate').onclick=()=>openMemberModal(); return;
    }
    if(!items.length){host.innerHTML=`<div class="empty-state" style="grid-column:1/-1"><div><h2>${state.topView==='trash'?'回收站是空的':state.activePanel==='pending'?'没有待处理截图':'这个图库还没有截图'}</h2><p>${state.activePanel==='pending'?'使用全局快捷键可快速收录到这里。':'切换到右侧“添加”开始收录。'}</p></div></div>`;return;}
    host.innerHTML=items.map(shot=>{
      const members=screenshotMembers(shot).map(x=>x.displayName).join('、')||'未关联成员';
      const snippet=shot.messages.find(x=>x.text.trim())?.text||'尚未识别文字';
      return `<article class="card ${shot.id===state.selectedScreenshotId?'selected':''} ${selectedIds.has(shot.id)?'batch-selected':''}" data-shot="${shot.id}"><span class="select-dot">✓</span><button class="card-more" data-more="${shot.id}" title="更多">···</button><div class="thumb"><img class="real-image" src="${esc(shot.imageUrl)}" alt="截图"/></div><div class="cardline"><span class="snippet">${esc(snippet)}</span><span class="date">${fmtDate(shot.importedAt)}</span></div><div class="mini">${esc(members)} · ${shot.messages.length} 条消息${shot.needsReview?' · 待整理':''}${shot.keywords?.length?' · #'+esc(shot.keywords.join(' #')):''}</div></article>`;
    }).join('');
    host.querySelectorAll('[data-shot]').forEach(card=>{
      card.onclick=e=>{if(e.target.closest('[data-more]'))return;if(selectionMode){selectedIds.has(card.dataset.shot)?selectedIds.delete(card.dataset.shot):selectedIds.add(card.dataset.shot);renderCenter();}else post('selectScreenshot',{id:card.dataset.shot});};
      card.oncontextmenu=e=>{e.preventDefault();showScreenshotMenu(e.clientX,e.clientY,card.dataset.shot);};
    });
    host.querySelectorAll('[data-more]').forEach(button=>button.onclick=e=>{e.stopPropagation();const r=button.getBoundingClientRect();showScreenshotMenu(r.right,r.bottom+4,button.dataset.more);});
  }

  function showScreenshotMenu(x,y,id){
    const shot=state.screenshots.find(s=>s.id===id); if(!shot)return;
    showMenu(x,y,shot.deletedAt?[
      {label:'复制到剪贴板',action:()=>post('copyImage',{id})},{label:'恢复到图库',action:()=>post('restoreFromTrash',{id})},{separator:true},{label:'永久删除',danger:true,action:()=>askConfirm('永久删除','删除后无法恢复，确定继续？',()=>post('permanentDelete',{id}),true)}
    ]:[
      {label:'复制到剪贴板',action:()=>post('copyImage',{id})},{label:'在资源管理器中显示',action:()=>post('showFile',{id})},{separator:true},{label:'移到回收站',danger:true,action:()=>post('moveToTrash',{id})}
    ]);
  }

  function setActivePanel(name, force=false) {
    if(!force&&editDirty&&state.activePanel==='edit'&&name!=='edit') return askConfirm('放弃修改','编辑内容尚未保存，确定放弃吗？',()=>{editDirty=false;setActivePanel(name,true);});
    if(state.topView==='trash'&&name!=='preview')name='preview';
    state.activePanel=name;
    document.querySelectorAll('.tab').forEach(tab=>tab.classList.toggle('active',tab.dataset.panel===name));
    document.querySelectorAll('.panel').forEach(panel=>panel.classList.toggle('active',panel.id===name));
    renderCenter();renderWorkbench();post('panelChanged',{name});
  }

  function renderWorkbench(){
    $('pendingCount').textContent=state.screenshots.filter(x=>!x.deletedAt&&x.needsReview).length;
    document.querySelectorAll('.tab').forEach(tab=>tab.classList.toggle('hidden',state.topView==='trash'&&tab.dataset.panel!=='preview'));
    renderPreview();renderAdd();renderEdit();renderPending();
  }
  const emptyPanel=(host,title,text)=>host.innerHTML=`<div class="empty-state"><div><h2>${esc(title)}</h2><p>${esc(text)}</p></div></div>`;

  function renderPreview(){
    const host=$('preview'),shot=selectedScreenshot();
    if(!shot){emptyPanel(host,'选择一张截图','选择后可查看大图、消息内容并复制原图。');return;}
    const members=screenshotMembers(shot), messages=shot.messages.map(m=>`<div><span class="msg-person">${esc(memberById(m.personId)?.displayName||'未指定')}</span>${esc(m.text)}</div>`).join('')||'<span class="muted">尚未识别到消息</span>';
    host.innerHTML=`<div class="panel-header"><h2>截图预览</h2><span class="muted">${new Date(shot.importedAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span></div><div class="bigpreview"><img class="real-image" src="${esc(shot.imageUrl)}" alt="截图预览"/></div><div class="section"><div class="section-title">关联成员</div><div class="chips">${members.map(x=>`<span class="chip">${esc(x.displayName)}</span>`).join('')||'<span class="muted">未关联</span>'}</div></div>${shot.keywords?.length?`<div class="section"><div class="section-title">关键词</div><div class="chips">${shot.keywords.map(x=>`<span class="chip">#${esc(x)}</span>`).join('')}</div></div>`:''}<div class="section"><div class="section-title">消息内容</div><div class="message-box">${messages}</div></div><div class="actions"><button class="btn primary" id="copyShot">复制到剪贴板</button></div>`;
    $('copyShot').onclick=()=>post('copyImage',{id:shot.id});
  }

  function renderAdd(){
    const host=$('add'),current=selectedMember();
    if(!draft){host.innerHTML=`<div class="panel-header"><h2>添加截图</h2></div><div class="dropzone" id="dropzone"><div><div class="dropicon">＋</div><b>拖入截图或选择本地文件</b><div class="or">支持多选 PNG、JPG、BMP、GIF</div><button class="btn" id="chooseImage">选择图片</button></div></div><div class="formrow"><button class="btn" id="clipboardImage" style="width:100%">从剪贴板读取图片并识别</button></div><div class="formrow"><label>默认加入</label><div class="field" style="display:flex;align-items:center">${esc(current?.displayName||'请先选择成员图库')}</div><button class="btn" id="quickCreateMember" style="width:100%;margin-top:8px">＋ 新建成员图库</button></div><div class="pending-note">单张图片可直接加入当前图库；批量导入会进入待处理，方便统一整理。</div>`;
      $('chooseImage').onclick=()=>post('chooseImage');$('clipboardImage').onclick=()=>post('prepareClipboard');$('quickCreateMember').onclick=()=>openMemberModal();
      const dz=$('dropzone');['dragenter','dragover'].forEach(n=>dz.addEventListener(n,e=>{e.preventDefault();dz.style.borderColor='#444';}));['dragleave','drop'].forEach(n=>dz.addEventListener(n,e=>{e.preventDefault();dz.style.borderColor='';}));
      dz.addEventListener('drop',e=>readDroppedFiles([...e.dataTransfer.files].filter(f=>f.type.startsWith('image/'))));return;
    }
    const lines=draft.messages.map(x=>esc(x.text)).join('<br/>')||'<span class="muted">未识别到消息，可加入后在编辑中补充。</span>';
    host.innerHTML=`<div class="panel-header"><h2>确认添加</h2><span class="muted">OCR ${Math.round((draft.confidence||0)*100)}%</span></div><div class="bigpreview"><img class="real-image" src="${esc(draft.dataUrl)}"/></div><div class="section"><div class="section-title">识别消息</div><div class="message-box">${lines}</div></div><div class="section"><div class="section-title">目标图库</div><div class="chips">${current?`<span class="chip">${esc(current.displayName)}</span>`:'<span class="muted">未选择成员图库</span>'}</div></div><div class="section"><div class="section-title">关键词（可选，以逗号分隔）</div><input class="keyword-input" id="draftKeywords" placeholder="例如：加班，名场面"/></div><div class="actions"><button class="btn" id="cancelDraft">取消</button><button class="btn" id="commitPending">加入待处理</button><button class="btn primary" id="commitCurrent" ${current?'':'disabled'}>加入当前图库</button></div>`;
    $('cancelDraft').onclick=()=>{draft=null;post('cancelDraft');renderAdd();};
    $('commitPending').onclick=()=>commitDraft(true,current);$('commitCurrent').onclick=()=>commitDraft(false,current);
  }

  function commitDraft(pending,current){post('commitDraft',{pending,personId:current?.id||null,keywords:keywords($('draftKeywords')?.value)});}
  function readDroppedFiles(files){if(!files.length)return;Promise.all(files.map(file=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve({name:file.name,dataUrl:r.result});r.onerror=reject;r.readAsDataURL(file);}))).then(items=>items.length===1?post('prepareDroppedImage',items[0]):post('prepareDroppedImages',{items}));}
  function speakerOptions(id){return `<option value="">未指定</option>${state.people.map(p=>`<option value="${p.id}" ${p.id===id?'selected':''}>${esc(p.displayName)}</option>`).join('')}`;}

  function renderEdit(){
    const host=$('edit'),shot=selectedScreenshot(); if(!shot||shot.deletedAt){emptyPanel(host,'选择一张截图','从成员图库中选择截图后，可直接修改聊天内容。');return;}
    const rows=shot.messages.length?shot.messages:[{id:crypto.randomUUID(),personId:state.selectedPersonId,text:''}];
    host.innerHTML=`<div class="panel-header"><h2>编辑截图</h2><span class="muted">${rows.length} 条消息</span></div><div class="edit-tip">点击发言人或消息气泡即可直接修改</div><div class="chat-editor"><div class="chat-editor-head">识别结果<button class="bubble-tool small-action" id="rerunOcr">重新 OCR</button></div><div class="chat-stream" id="chatStream">${rows.map((m,i)=>chatRow(m,i)).join('')}</div><button class="chat-add" id="addMessage">＋ 添加一条消息</button></div><div class="section"><div class="section-title">关键词（可选）</div><input class="keyword-input" id="editKeywords" value="${esc((shot.keywords||[]).join('，'))}" placeholder="以逗号分隔"/></div><div class="actions"><button class="btn" id="cancelEdit">取消</button><button class="btn primary" id="saveEdit">保存修改</button></div>`;
    bindEdit();$('addMessage').onclick=()=>{$('chatStream').insertAdjacentHTML('beforeend',chatRow({id:crypto.randomUUID(),personId:state.selectedPersonId,text:''},$('chatStream').children.length));editDirty=true;bindEdit();};
    $('cancelEdit').onclick=()=>{editDirty=false;setActivePanel('preview',true);};$('saveEdit').onclick=saveEdit;
    $('rerunOcr').onclick=()=>askConfirm('重新识别','重新 OCR 会覆盖当前编辑内容，确定继续？',()=>post('rerunOcr',{id:shot.id}));
  }
  function chatRow(m,i){const mine=i%2===1,p=memberById(m.personId);return `<div class="chat-message ${mine?'mine':''}" data-message="${esc(m.id||'')}"><div class="chat-avatar ${mine?'a2':'a1'}">${esc(p?.displayName?.slice(0,1)||'?')}</div><div class="chat-body"><select class="chat-speaker" data-speaker>${speakerOptions(m.personId)}</select><br/><div class="chat-bubble" contenteditable="true" data-text>${esc(m.text)}</div><div class="bubble-tools"><button class="bubble-tool" data-remove>删除</button></div></div></div>`;}
  function bindEdit(){const h=$('edit');h.querySelectorAll('[contenteditable],select,input').forEach(n=>n.oninput=()=>editDirty=true);h.querySelectorAll('[data-remove]').forEach(n=>n.onclick=()=>{n.closest('.chat-message').remove();editDirty=true;});}
  function saveEdit(){const shot=selectedScreenshot(),rows=[...$('chatStream').querySelectorAll('.chat-message')];const messages=rows.map((r,i)=>({id:r.dataset.message||crypto.randomUUID(),sortOrder:i,personId:r.querySelector('[data-speaker]').value||null,text:r.querySelector('[data-text]').innerText.trim()})).filter(x=>x.text);post('saveEdit',{id:shot.id,messages,personIds:[...new Set(messages.map(x=>x.personId).filter(Boolean))],keywords:keywords($('editKeywords').value)});editDirty=false;}

  function renderPending(){const host=$('pending'),shot=selectedScreenshot();if(!shot||shot.deletedAt||!shot.needsReview){emptyPanel(host,'选择待处理截图','中间区域显示所有待处理截图，选择一张开始整理。');return;}const members=screenshotMembers(shot);host.innerHTML=`<div class="panel-header"><h2>整理待处理截图</h2></div><div class="pending-preview"><img class="real-image" src="${esc(shot.imageUrl)}"/></div><div class="section"><div class="section-title">识别消息</div><div class="message-box">${shot.messages.map(x=>esc(x.text)).join('<br/>')||'<span class="muted">尚未识别消息</span>'}</div></div><div class="section"><div class="section-title">关联成员</div><div class="chips">${members.map(x=>`<span class="chip">${esc(x.displayName)}</span>`).join('')||'<span class="muted">请在编辑中关联成员</span>'}</div></div><div class="actions"><button class="btn danger" id="deletePending">移到回收站</button><button class="btn" id="editPending">编辑内容</button><button class="btn primary" id="finishPending">完成整理</button></div>`;$('deletePending').onclick=()=>post('moveToTrash',{id:shot.id});$('editPending').onclick=()=>setActivePanel('edit');$('finishPending').onclick=()=>post('finishPending',{id:shot.id});}

  function renderSettings(){
    const s=state.settings||{},keys=[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].concat(Array.from({length:12},(_,i)=>`F${i+1}`));
    $('settingsPage').innerHTML=`<h1>设置</h1><div class="settings-lead">管理 QuoteVault 的快捷键、数据与备份。后续设置也会集中在这里。</div><div class="settings-card"><h2>全局收录快捷键</h2><p>按下快捷键后，将剪贴板图片静默加入待处理。</p><div class="hotkey-row"><label><input id="hotCtrl" type="checkbox" ${s.hotKeyCtrl?'checked':''}/>Ctrl</label><label><input id="hotAlt" type="checkbox" ${s.hotKeyAlt?'checked':''}/>Alt</label><label><input id="hotShift" type="checkbox" ${s.hotKeyShift?'checked':''}/>Shift</label><select id="hotKey">${keys.map(k=>`<option ${k===s.hotKey?'selected':''}>${k}</option>`).join('')}</select><button class="btn primary" id="saveSettings">保存快捷键</button></div></div><div class="settings-card"><h2>数据与备份</h2><p>备份包含索引、成员、群组、关键词和全部原图。</p><div class="smallrow"><button class="btn" id="backupData">导出完整备份</button><button class="btn" id="restoreData">从备份恢复</button></div></div>`;
    $('saveSettings').onclick=()=>{if(!$('hotCtrl').checked&&!$('hotAlt').checked&&!$('hotShift').checked)return toast('至少选择一个修饰键。');post('saveSettings',{hotKeyCtrl:$('hotCtrl').checked,hotKeyAlt:$('hotAlt').checked,hotKeyShift:$('hotShift').checked,hotKey:$('hotKey').value});toast('快捷键已保存');};
    $('backupData').onclick=()=>post('createBackup');$('restoreData').onclick=()=>askConfirm('恢复备份','恢复会替换当前图库；操作前会自动创建安全备份。',()=>post('restoreBackup'));
  }

  function renderApp(){
    ensureDynamicUi();const settings=state.topView==='settings';document.querySelector('.workspace').classList.toggle('settings-mode',settings);
    document.querySelectorAll('[data-top]').forEach(x=>x.classList.toggle('active',x.dataset.top===(settings?'settings':'library')));
    if(settings){closeFloating();renderSettings();return;} renderTree();renderCenter();renderWorkbench();
  }

  function bindStaticEvents(){
    document.querySelectorAll('.tab').forEach(tab=>tab.onclick=()=>setActivePanel(tab.dataset.panel));
    document.querySelectorAll('[data-top]').forEach(tab=>tab.onclick=()=>{state.topView=tab.dataset.top;state.selectedScreenshotId=null;if(state.topView==='library')state.activePanel='preview';post('topViewChanged',{name:state.topView});renderApp();});
    $('trashNav').onclick=()=>{state.topView='trash';state.activePanel='preview';state.selectedScreenshotId=null;selectionMode=false;post('topViewChanged',{name:'trash'});renderApp();};
    $('sideSearch').oninput=renderTree;$('centerSearch').oninput=renderCenter;
    $('managePeople').onclick=e=>openCreateMenu(e.currentTarget);
    document.querySelector('.sidebar').addEventListener('contextmenu',e=>{if(e.target.closest('[data-person],[data-group],button,input'))return;e.preventDefault();showMenu(e.clientX,e.clientY,[{label:'新建群组',action:()=>openGroupModal()},{label:'新建成员',action:()=>openMemberModal()}]);});
    $('gridView').onclick=()=>{viewMode='grid';$('gridView').classList.add('active');$('listView').classList.remove('active');renderCenter();};
    $('listView').onclick=()=>{viewMode='list';$('listView').classList.add('active');$('gridView').classList.remove('active');renderCenter();};
    $('minimizeWindow').onclick=e=>{e.stopPropagation();post('windowAction',{action:'minimize'});};$('maximizeWindow').onclick=e=>{e.stopPropagation();post('windowAction',{action:'maximize'});};$('closeWindow').onclick=e=>{e.stopPropagation();post('windowAction',{action:'close'});};
    $('titlebar').onmousedown=e=>{if(!e.target.closest('.window-actions'))post('windowAction',{action:'drag'});};
    $('titlebar').ondblclick=e=>{if(!e.target.closest('.window-actions'))post('windowAction',{action:'maximize'});};
    document.addEventListener('pointerdown',e=>{if(!e.target.closest('.context-menu,.card-more,#managePeople'))closeFloating();});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeFloating();document.querySelector('.modal-layer')?.remove();}});
  }

  function setWindowIcon(mode){windowState=mode;const svg=$('maximizeWindow').querySelector('svg');svg.innerHTML=mode==='maximized'?'<rect x="5" y="3" width="8" height="8" rx="1"/><path d="M11 11v2H3V5h2"/>':'<rect x="3.25" y="3.25" width="9.5" height="9.5" rx="1"/>';}

  window.quoteVault={
    setState(next){state={...state,...next};setBusy(false);renderApp();setActivePanel(state.activePanel||'preview',true);},
    setDraft(next){draft=next;setBusy(false);state.topView='library';setActivePanel('add',true);},
    clearDraft(){draft=null;renderAdd();},setBusy(value,text){Array.isArray(value)?setBusy(value[0],value[1]):setBusy(value,text);},
    showError:toast,setWindowState:setWindowIcon,
    showDuplicate(info){modal(`<h2>发现重复图片</h2><p>图库中已经存在“${esc(info.originalFileName)}”。请选择如何处理。</p><div class="modal-actions"><button class="btn" data-skip>跳过</button><button class="btn" data-view>查看已有截图</button><button class="btn primary" data-import>仍然导入</button></div>`,layer=>{layer.querySelector('[data-skip]').onclick=()=>{layer.remove();post('resolveDuplicate',{action:'skip'});};layer.querySelector('[data-view]').onclick=()=>{layer.remove();post('resolveDuplicate',{action:'view'});};layer.querySelector('[data-import]').onclick=()=>{layer.remove();post('resolveDuplicate',{action:'import'});};});}
  };
  document.addEventListener('DOMContentLoaded',()=>{ensureDynamicUi();bindStaticEvents();post('ready');});
})();
