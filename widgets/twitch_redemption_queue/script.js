(() => {
  const API_BASE = '/twitch/widgets/twitch_redemption_queue';
  const RECONNECT_MIN_MS = 2000;
  const RECONNECT_MAX_MS = 15000;

  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  const errorEl = document.getElementById('error');
  const statusEl = document.getElementById('status');
  const refreshBtn = document.getElementById('refresh');

  let redemptions = [];
  // Redemption ids with an approve/refund request in flight - kept out of `redemptions`
  // itself so a slow response can't get clobbered by an update landing mid-request.
  const inFlight = new Set();
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

  function formatTime(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function isPending(redemption) {
    return String(redemption.status ?? 'unfulfilled').toLowerCase() === 'unfulfilled';
  }

  function buildItem(redemption) {
    const busy = inFlight.has(redemption.id);

    const li = document.createElement('li');
    li.className = 'item' + (busy ? ' pending-action' : '');

    const main = document.createElement('div');
    main.className = 'item-main';

    const titleRow = document.createElement('div');
    titleRow.className = 'item-title-row';

    const rewardEl = document.createElement('span');
    rewardEl.className = 'item-reward';
    rewardEl.textContent = redemption.reward?.title ?? '';

    const costEl = document.createElement('span');
    costEl.className = 'item-cost';
    costEl.textContent = String(redemption.reward?.cost ?? '');

    titleRow.append(rewardEl, costEl);

    const userEl = document.createElement('div');
    userEl.className = 'item-user';
    userEl.textContent = redemption.user_name ?? '';

    main.append(titleRow, userEl);

    if (redemption.user_input) {
      const inputEl = document.createElement('div');
      inputEl.className = 'item-input';
      inputEl.textContent = redemption.user_input;
      main.append(inputEl);
    }

    const timeEl = document.createElement('div');
    timeEl.className = 'item-time';
    timeEl.textContent = formatTime(redemption.redeemed_at);
    main.append(timeEl);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const approveBtn = document.createElement('button');
    approveBtn.className = 'approve-btn';
    approveBtn.textContent = 'Approve';
    approveBtn.disabled = busy;
    approveBtn.addEventListener('click', () => act(redemption, 'approve'));

    const refundBtn = document.createElement('button');
    refundBtn.className = 'refund-btn';
    refundBtn.textContent = 'Refund';
    refundBtn.disabled = busy;
    refundBtn.addEventListener('click', () => act(redemption, 'refund'));

    actions.append(approveBtn, refundBtn);
    li.append(main, actions);
    return li;
  }

  function render() {
    listEl.innerHTML = '';
    emptyEl.hidden = redemptions.length !== 0;
    for (const redemption of redemptions) {
      listEl.append(buildItem(redemption));
    }
  }

  // One-shot initial state (and manual resync via the refresh button) - the socket carries
  // everything after that, but a REST fetch is also the safety net for whatever happened
  // while the socket was disconnected.
  async function sync({ silent } = {}) {
    if (!silent) {
      refreshBtn.classList.add('spinning');
    }
    try {
      const response = await fetch(`${API_BASE}/pending`);
      const body = await response.json();
      if (body.error) {
        setError(describeError(body.error));
        redemptions = [];
      } else {
        setError(null);
        redemptions = body.data ?? [];
      }
    } catch (e) {
      setError('Could not reach Spooder.');
    } finally {
      refreshBtn.classList.remove('spinning');
      render();
    }
  }

  async function act(redemption, action) {
    inFlight.add(redemption.id);
    render();
    try {
      const response = await fetch(`${API_BASE}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rewardId: redemption.reward?.id, redemptionId: redemption.id }),
      });
      const body = await response.json();
      if (body.error) {
        setError(describeError(body.error));
        // No update event is coming for a failed call - stop showing it as busy.
        inFlight.delete(redemption.id);
        render();
      }
      // On success, the redemption's own 'update' event (over the socket) removes it from
      // the list and clears inFlight - no need to do either here.
    } catch (e) {
      setError('Could not reach Spooder.');
      inFlight.delete(redemption.id);
      render();
    }
  }

  function applyEvent(message) {
    const redemption = message.redemption;
    if (!redemption?.id) {
      return;
    }

    const index = redemptions.findIndex((r) => r.id === redemption.id);

    if (message.type === 'add') {
      if (index === -1 && isPending(redemption)) {
        redemptions.push(redemption);
      }
    } else if (message.type === 'update') {
      inFlight.delete(redemption.id);
      if (isPending(redemption)) {
        if (index === -1) {
          redemptions.push(redemption);
        } else {
          redemptions[index] = redemption;
        }
      } else if (index !== -1) {
        redemptions.splice(index, 1);
      }
    }

    render();
  }

  function connectSocket() {
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${wsProtocol}//${location.host}${API_BASE}`);

    socket.addEventListener('open', () => {
      reconnectDelay = RECONNECT_MIN_MS;
      setStatus('Live');
      // Resync in case anything happened while disconnected (including the very first
      // connection - this is what loads the initial list).
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
