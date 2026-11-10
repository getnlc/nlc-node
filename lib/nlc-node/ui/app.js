(function () {
  'use strict';
  var keyTag = document.querySelector('meta[name="nlc-key"]');
  var key = (location.hash.match(/k=([^&]+)/) || [])[1] || (keyTag && keyTag.getAttribute('content')) || sessionStorage.getItem('nlc-node-k') || '';
  if (key) { sessionStorage.setItem('nlc-node-k', key); history.replaceState(null, '', location.pathname); }
  var app = document.getElementById('app');
  var busy = false;

  function call(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
  }
  function refresh() {
    if (busy) return Promise.resolve();
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT';
    if (typing) return Promise.resolve();
    return call('GET', '/v1/window/view').then(function (r) { return r.text(); }).then(function (html) { app.innerHTML = html; }).catch(function () {});
  }
  function act(method, path, body) {
    busy = true;
    return call(method, path, body).then(function (r) { return r.json(); }).then(function (out) {
      busy = false;
      return refresh().then(function () { show(out); });
    }).catch(function () { busy = false; });
  }
  function show(out) {
    var slot = document.getElementById('message');
    if (!slot || !out || !out.message) return;
    slot.textContent = out.message;
    slot.className = out.ok ? 'note' : 'error';
  }

  app.addEventListener('submit', function (event) {
    event.preventDefault();
    var input = document.getElementById('pair-code');
    act('POST', '/v1/window/pair', { code: input ? input.value : '' });
  });
  app.addEventListener('click', function (event) {
    var target = event.target.closest('[data-action]');
    if (!target) return;
    var action = target.getAttribute('data-action');
    if (action === 'ask') act('POST', '/v1/window/request', {});
    if (action === 'add') act('POST', '/v1/window/folders/add', {});
    if (action === 'remove') act('POST', '/v1/window/folders/remove', { label: target.getAttribute('data-label') });
    if (action === 'open-central') act('POST', '/v1/window/open-central', {});
    if (action === 'open-folder') act('POST', '/v1/window/folders/open', { label: target.getAttribute('data-label') });
    if (action === 'replace') act('POST', '/v1/window/folders/replace', { label: target.getAttribute('data-label') });
    if (action === 'pause') act('POST', '/v1/window/pause', { paused: target.getAttribute('aria-checked') !== 'true' });
  });

  refresh();
  setInterval(refresh, 3000);
})();
