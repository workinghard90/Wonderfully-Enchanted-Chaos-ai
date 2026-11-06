/* Owner login for protected WEC APIs. One token, no passwords in URLs,
   localStorage, Git, or server logs. Public studio pages remain browsable. */
(() => {
  'use strict';
  const KEY = 'wec_token';
  let pending = [];
  let validated = false;
  let pendingCheck = null;
  const existing = () => (sessionStorage.getItem(KEY) || '').trim();

  const container = document.createElement('section');
  container.id = 'wec-owner-login';
  container.setAttribute('aria-label', 'WEC owner access');
  container.innerHTML = `
    <div class="wec-owner-toolbar">
      <strong id="wec-owner-state">Owner features locked</strong>
      <button type="button" id="wec-owner-open">Owner sign in</button>
      <button type="button" id="wec-owner-logout" hidden>Lock owner features</button>
      <span class="wec-owner-note">Basic pages remain available. AI requires separate provider setup and cost limits.</span>
    </div>
    <form id="wec-owner-form" hidden>
      <label for="wec-owner-token">Owner access password / token</label>
      <input id="wec-owner-token" type="password" autocomplete="off" required minlength="32"
         />
      <button type="submit">Unlock owner features</button>
      <button id="wec-owner-cancel" type="button">Cancel</button>
      <p id="wec-owner-message" role="status" aria-live="polite"></p>
    </form>`;
  const get = id => container.querySelector('#' + id);
  const form = get('wec-owner-form');
  const state = get('wec-owner-state');
  const input = get('wec-owner-token');
  const message = get('wec-owner-message');
  const button = get('wec-owner-open');
  const logout = get('wec-owner-logout');
  const mount = () => {
    const header = document.querySelector('body > header');
    if (header) header.insertAdjacentElement('afterend', container);
    else document.body.prepend(container);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
  else mount();

  function update() {
    state.textContent = validated ? 'Owner features unlocked for this tab' : 'Owner features locked';
    button.hidden = validated;
    logout.hidden = !validated;
    form.hidden = validated || form.hidden;
  }
  function resolvePending(error) {
    const all = pending;
    pending = [];
    for (const {resolve, reject} of all) error ? reject(error) : resolve(existing());
  }
  function lock() {
    sessionStorage.removeItem(KEY);
    validated = false;
    input.value = '';
    form.hidden = true;
    message.textContent = '';
    update();
    resolvePending(Error('Owner sign-in cancelled or locked.'));
    document.dispatchEvent(new CustomEvent('wec-owner-auth-changed', {detail:{signedIn:false}}));
  }
  async function validate(value) {
    const result = await fetch('/api/auth/status', {
      headers: {'X-WEC-Token': value},
      cache: 'no-store',
    });
    if (!result.ok) {
      if (result.status === 401) {
        const error = Error('Incorrect owner password/token.');
        error.invalidCredential = true;
        throw error;
      }
      throw Error('Could not verify owner access. Check the server connection.');
    }
    return true;
  }
  function show() {
    if (validated && existing()) return Promise.resolve(existing());
    form.hidden = false;
    message.textContent = 'Enter the owner access token configured in Render. It remains in this browser tab only.';
    update();
    input.focus();
    return new Promise((resolve, reject) => pending.push({resolve, reject}));
  }
  button.addEventListener('click', () => {show().catch(() => {});});
  get('wec-owner-cancel').addEventListener('click', () => {
    form.hidden = true;
    input.value = '';
    resolvePending(Error('Owner sign-in cancelled.'));
  });
  logout.addEventListener('click', lock);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const value = input.value.trim();
    if (value.length < 32) {
      message.textContent = 'The owner token must contain at least 32 characters.';
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    message.textContent = 'Checking owner access…';
    try {
      await validate(value);
      sessionStorage.setItem(KEY, value);
      validated = true;
      input.value = '';
      form.hidden = true;
      update();
      resolvePending();
      document.dispatchEvent(new CustomEvent('wec-owner-auth-changed', {detail:{signedIn:true}}));
    } catch (error) {
      message.textContent = error.message;
    } finally {submit.disabled = false;}
  });
  async function checkSaved() {
    if (!existing()) {validated = false;update();return false;}
    if (pendingCheck) return pendingCheck;
    pendingCheck = validate(existing()).then(() => {
      validated = true;update();return true;
    }).catch(error => {
      // Only an explicit server 401 proves that a token was revoked.
      // Network loss, an offline server, or a transient 5xx response must
      // never erase the tab credential used to locate offline device backups.
      validated = false;
      if (error.invalidCredential) lock();
      else update();
      return false;
    }).finally(() => {pendingCheck = null;});
    return pendingCheck;
  }
  window.WECOwnerLogin = Object.freeze({
    require: async () => {
      if (validated && existing()) return existing();
      if (await checkSaved()) return existing();
      return show();
    },
    lock,
    check: checkSaved,
    isUnlocked: () => validated && Boolean(existing()),
  });
  void checkSaved();
})();
