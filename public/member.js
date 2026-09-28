'use strict';

(() => {
  const byId = id => document.getElementById(id);
  const accessView = byId('access-view');
  const welcomeView = byId('welcome-view');
  const loginForm = byId('member-login-form');
  const registerForm = byId('member-register-form');
  const confirmForm = byId('member-confirm-form');
  let currentView = new URLSearchParams(window.location.search).get('cadastro') === '1' ? 'register' : 'login';
  let challengeId = null;
  let csrf = null;
  let busy = false;

  async function request(path, {method = 'GET', body, token} = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers['X-CSRF-Token'] = token;
      const response = await fetch(path, {method, credentials: 'same-origin', cache: 'no-store', headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal});
      let data = null;
      if (response.headers.get('content-type')?.includes('application/json')) data = await response.json();
      if (!response.ok) {
        const supplied = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : null;
        const error = new Error(supplied || (response.status === 429 ? 'Muitas tentativas. Aguarde antes de tentar novamente.' : response.status === 401 ? 'Sua sessão não está ativa. Entre novamente.' : 'Não foi possível concluir agora. Tente novamente.'));
        error.status = response.status;
        throw error;
      }
      if (!data || typeof data !== 'object') throw new Error('O serviço não retornou uma resposta válida. Tente novamente.');
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('O servidor demorou a responder. Tente novamente.');
      if (error instanceof TypeError) throw new Error('Falha de conexão. Confira sua internet e tente novamente.');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function showAccess(view, {focus = true, updateAddress = true} = {}) {
    currentView = view;
    welcomeView.hidden = true;
    accessView.hidden = false;
    for (const name of ['login', 'register', 'confirm']) byId(`${name}-view`).hidden = name !== view;
    byId('login-tab').toggleAttribute('aria-current', view === 'login');
    byId('register-tab').toggleAttribute('aria-current', view !== 'login');
    (view === 'login' ? byId('login-tab') : byId('register-tab')).setAttribute('aria-current', 'page');
    if (updateAddress) window.history.replaceState(null, '', view === 'login' ? '/member.html' : '/member.html?cadastro=1');
    if (focus) byId(`${view}-title`).focus();
  }

  function clearPrivateFields() {
    for (const id of ['login-password', 'register-password', 'register-confirm', 'confirm-code']) byId(id).value = '';
    challengeId = null;
  }

  function showWelcome(member) {
    if (typeof member.name !== 'string' || typeof member.csrf !== 'string' || !member.csrf) throw new Error('Não foi possível confirmar seu acesso. Entre novamente.');
    csrf = member.csrf;
    byId('member-name').textContent = member.name;
    byId('welcome-feedback').textContent = '';
    accessView.hidden = true;
    welcomeView.hidden = false;
    clearPrivateFields();
    window.history.replaceState(null, '', '/member.html');
    byId('welcome-title').focus();
  }

  async function loadMember() {
    const member = await request('/api/member/me');
    showWelcome(member);
  }

  async function submitForm(form, feedbackId, pendingText, work) {
    if (busy) return;
    const submit = form.querySelector('button[type="submit"]');
    const feedback = byId(feedbackId);
    const previousText = submit.textContent;
    feedback.textContent = '';
    busy = true;
    submit.disabled = true;
    submit.textContent = pendingText;
    form.setAttribute('aria-busy', 'true');
    try { await work(); }
    catch (error) { feedback.textContent = error.message; }
    finally {
      busy = false;
      submit.disabled = false;
      submit.textContent = previousText;
      form.removeAttribute('aria-busy');
    }
  }

  function switchTo(view) {
    if (busy) return;
    challengeId = null;
    byId('confirm-code').value = '';
    showAccess(view);
  }

  byId('login-tab').addEventListener('click', event => { event.preventDefault(); switchTo('login'); });
  byId('register-tab').addEventListener('click', event => { event.preventDefault(); switchTo('register'); });
  document.querySelectorAll('[data-view]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); switchTo(link.dataset.view); }));
  document.querySelectorAll('[data-password]').forEach(button => button.addEventListener('click', () => {
    const field = byId(button.dataset.password);
    const show = field.type === 'password';
    field.type = show ? 'text' : 'password';
    button.textContent = show ? 'Ocultar' : 'Mostrar';
    button.setAttribute('aria-pressed', String(show));
    button.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
  }));

  loginForm.addEventListener('submit', event => {
    event.preventDefault();
    submitForm(loginForm, 'login-feedback', 'Entrando…', async () => {
      const data = await request('/api/member/login', {method: 'POST', body: {username: byId('login-username').value.trim(), password: byId('login-password').value}});
      if (data.authenticated !== true) throw new Error('Não foi possível confirmar seu acesso. Tente novamente.');
      await loadMember();
    });
  });

  registerForm.addEventListener('submit', event => {
    event.preventDefault();
    submitForm(registerForm, 'register-feedback', 'Enviando código…', async () => {
      const password = byId('register-password').value;
      if (password !== byId('register-confirm').value) throw new Error('As senhas precisam ser iguais. Confira e tente novamente.');
      const data = await request('/api/member/register/start', {method: 'POST', body: {ifj: byId('register-ifj').value.trim(), username: byId('register-username').value.trim(), password}});
      if (typeof data.challenge_id !== 'string' || !data.challenge_id) throw new Error('Não foi possível iniciar a confirmação. Tente novamente.');
      challengeId = data.challenge_id;
      byId('register-password').value = '';
      byId('register-confirm').value = '';
      byId('confirm-code').value = '';
      byId('confirm-feedback').textContent = '';
      showAccess('confirm');
      byId('confirm-code').focus();
    });
  });

  confirmForm.addEventListener('submit', event => {
    event.preventDefault();
    submitForm(confirmForm, 'confirm-feedback', 'Confirmando…', async () => {
      if (!challengeId) throw new Error('Recomece o cadastro para receber um novo código.');
      const data = await request('/api/member/register/confirm', {method: 'POST', body: {challenge_id: challengeId, code: byId('confirm-code').value.trim()}});
      if (data.authenticated !== true) throw new Error('Não foi possível confirmar seu acesso. Tente novamente.');
      // The code is already consumed: a temporary session lookup failure must
      // not send the member back through the same confirmation attempt.
      challengeId = null;
      byId('confirm-code').value = '';
      try { await loadMember(); }
      catch {
        byId('login-username').value = byId('register-username').value.trim();
        byId('login-feedback').textContent = 'Cadastro confirmado. Entre na sua conta para continuar.';
        showAccess('login');
      }
    });
  });

  byId('restart-registration').addEventListener('click', () => {
    if (busy) return;
    challengeId = null;
    byId('confirm-code').value = '';
    byId('register-feedback').textContent = 'Preencha sua senha novamente. Aguarde 1 minuto entre os envios de código.';
    showAccess('register');
  });

  byId('member-logout').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    const button = byId('member-logout');
    button.disabled = true;
    button.textContent = 'Saindo…';
    byId('welcome-feedback').textContent = '';
    try {
      try { await request('/api/member/logout', {method: 'POST', body: {}, token: csrf}); }
      catch (error) { if (error.status !== 401) throw error; }
      csrf = null;
      byId('member-name').textContent = '';
      clearPrivateFields();
      byId('login-feedback').textContent = '';
      showAccess('login');
    } catch (error) { byId('welcome-feedback').textContent = error.message; }
    finally { busy = false; button.disabled = false; button.textContent = 'Sair'; }
  });

  (async () => {
    try { await loadMember(); }
    catch (error) {
      showAccess(currentView, {focus: false, updateAddress: false});
      if (error.status !== 401) byId(`${currentView}-feedback`).textContent = error.message;
    } finally { byId('initial-loading').hidden = true; }
  })();
})();
