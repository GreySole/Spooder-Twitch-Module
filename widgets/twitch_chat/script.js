(() => {
  const API_BASE = '/twitch/widgets/twitch_chat';
  const RECONNECT_MIN_MS = 2000;
  const RECONNECT_MAX_MS = 15000;
  const MAX_ROWS = 200;
  // How close to the bottom the list has to be for a new message to auto-scroll it further -
  // a viewer who's scrolled up to read history shouldn't get yanked back down.
  const NEAR_BOTTOM_PX = 40;

  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  const errorEl = document.getElementById('error');
  const statusEl = document.getElementById('status');
  const refreshBtn = document.getElementById('refresh');

  const rowsById = new Map();
  let socket = null;
  let reconnectDelay = RECONNECT_MIN_MS;

  function setError(message) {
    errorEl.hidden = !message;
    errorEl.textContent = message ?? '';
  }

  function setStatus(text) {
    statusEl.hidden = !text;
    statusEl.textContent = text ?? '';
  }

  function describeError(code) {
    if (code === 'nologin') return 'Twitch is not logged in.';
    if (code === 'NO BROADCASTER TOKEN' || code === 'NO BROADCASTER USER ID') {
      return 'Broadcaster is not authorized.';
    }
    return code;
  }

  function isNearBottom() {
    return listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < NEAR_BOTTOM_PX;
  }

  function buildBody(segments) {
    const frag = document.createDocumentFragment();
    for (const segment of segments ?? []) {
      if (segment.type === 'emote') {
        const img = document.createElement('img');
        img.className = 'emote';
        img.src = segment.url;
        img.alt = segment.code;
        img.title = `${segment.code} (${segment.source})`;
        frag.append(img);
      } else {
        frag.append(document.createTextNode(segment.value));
      }
    }
    return frag;
  }

  async function act(message, endpoint, body, button) {
    button.disabled = true;
    try {
      const response = await fetch(`${API_BASE}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (result.error) {
        setError(describeError(result.error));
        button.disabled = false;
      }
      // On success the row updates when the moderation event echoes back over the socket -
      // Twitch relays ban/timeout/delete to every client in the room regardless of who did it.
    } catch (e) {
      setError('Could not reach Spooder.');
      button.disabled = false;
    }
  }

  function buildActions(message) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    const timeouts = [
      ['1m', 60],
      ['10m', 600],
      ['1h', 3600],
    ];
    for (const [label, seconds] of timeouts) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.title = `Timeout for ${label}`;
      btn.addEventListener('click', () =>
        act(message, 'timeout', { userId: message.userId, duration: seconds }, btn),
      );
      actions.append(btn);
    }

    const banBtn = document.createElement('button');
    banBtn.className = 'ban-btn';
    banBtn.textContent = 'Ban';
    banBtn.addEventListener('click', () => {
      if (confirm(`Ban ${message.displayName ?? message.username}?`)) {
        act(message, 'ban', { userId: message.userId }, banBtn);
      }
    });
    actions.append(banBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = '✖';
    deleteBtn.title = 'Delete message';
    deleteBtn.addEventListener('click', () =>
      act(message, 'delete', { messageId: message.id }, deleteBtn),
    );
    actions.append(deleteBtn);

    return actions;
  }

  function buildRow(message) {
    const li = document.createElement('li');
    li.className = 'msg' + (message.removed ? ' removed' : '');

    const badges = document.createElement('span');
    badges.className = 'msg-badges';
    for (const badge of message.badges ?? []) {
      const img = document.createElement('img');
      img.src = badge.url;
      img.title = badge.title ?? '';
      img.alt = badge.title ?? badge.setId ?? '';
      badges.append(img);
    }

    const name = document.createElement('span');
    name.className = 'msg-name';
    name.style.color = message.color || 'inherit';
    name.textContent = message.displayName || message.username || '';

    const body = document.createElement('span');
    body.className = 'msg-body';
    body.append(buildBody(message.segments));

    li.append(badges, name, body);
    if (!message.removed) {
      li.append(buildActions(message));
    }
    return li;
  }

  function render() {
    emptyEl.hidden = rowsById.size !== 0;
  }

  function pruneOverflow() {
    while (listEl.children.length > MAX_ROWS) {
      const first = listEl.firstElementChild;
      if (!first) break;
      rowsById.delete(first.dataset.id);
      first.remove();
    }
  }

  function appendMessage(message) {
    const stickToBottom = isNearBottom();
    const row = buildRow(message);
    row.dataset.id = message.id ?? '';
    if (message.id) {
      rowsById.set(message.id, message);
    }
    listEl.append(row);
    pruneOverflow();
    render();
    if (stickToBottom) {
      listEl.scrollTop = listEl.scrollHeight;
    }
  }

  function applyModeration(payload) {
    const rows = listEl.querySelectorAll('.msg:not(.removed)');
    for (const row of rows) {
      const message = rowsById.get(row.dataset.id);
      if (!message) continue;
      const matches =
        (payload.targetMsgId && message.id === payload.targetMsgId) ||
        (payload.targetUserId && message.userId === payload.targetUserId) ||
        (payload.kind === 'clearchat' && !payload.targetUserId && !payload.targetMsgId);
      if (matches) {
        message.removed = true;
        row.replaceWith(buildRow(message));
      }
    }
  }

  // One-shot backlog (and manual resync via the refresh button) - the socket carries everything
  // live after that, but this is also the safety net for whatever happened while disconnected.
  async function sync({ silent } = {}) {
    if (!silent) {
      refreshBtn.classList.add('spinning');
    }
    try {
      const response = await fetch(`${API_BASE}/messages`);
      const body = await response.json();
      if (body.error) {
        setError(describeError(body.error));
      } else {
        setError(null);
        listEl.innerHTML = '';
        rowsById.clear();
        for (const message of body.data ?? []) {
          appendMessage(message);
        }
        listEl.scrollTop = listEl.scrollHeight;
      }
    } catch (e) {
      setError('Could not reach Spooder.');
    } finally {
      refreshBtn.classList.remove('spinning');
      render();
    }
  }

  function applyEvent(event) {
    if (event.type === 'message') {
      appendMessage(event.message);
    } else if (event.type === 'moderation') {
      applyModeration(event);
    }
  }

  function connectSocket() {
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${wsProtocol}//${location.host}${API_BASE}`);

    socket.addEventListener('open', () => {
      reconnectDelay = RECONNECT_MIN_MS;
      setStatus('Live');
      sync({ silent: true });
    });

    socket.addEventListener('message', (e) => {
      try {
        applyEvent(JSON.parse(e.data));
      } catch (err) {
        // Ignore anything that isn't the JSON this widget expects.
      }
    });

    socket.addEventListener('close', () => {
      setStatus('Reconnecting...');
      setTimeout(connectSocket, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    });

    socket.addEventListener('error', () => {
      socket.close();
    });
  }

  refreshBtn.addEventListener('click', () => sync());

  connectSocket();
})();
