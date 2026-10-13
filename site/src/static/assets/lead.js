// IntelyOpti e-mail forms (download and waitlist). Posts JSON to {api}/api/lead; contract: IntelyOpti docs/API.md.
// Plain fetch, no framework. Without this file the form stays hidden and a <noscript> link is shown instead.
(() => {
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const TIMEOUT_MS = 15000;

  document.querySelectorAll('form[data-lead]').forEach((form) => {
    const msgs = JSON.parse(form.dataset.msgs || '{}');
    const email = form.elements.email;
    const consent = form.elements.consent;
    const submit = form.querySelector('button[type="submit"]');
    const status = form.querySelector('.form-status');
    const root = form.closest('[data-lead-root]');
    const done = root.querySelector('[data-lead-done]');
    const label = submit.textContent;
    let sending = false;

    const say = (text, isError) => {
      status.textContent = text;
      status.classList.toggle('is-error', Boolean(isError));
    };
    const fail = (key, field) => {
      say(msgs[key] || msgs.server_error, true);
      [email, consent].forEach((f) => f.removeAttribute('aria-invalid'));
      if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
    };
    [email, consent].forEach((f) => f.addEventListener('input', () => f.removeAttribute('aria-invalid')));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (sending) return;
      const address = email.value.trim();
      if (!EMAIL.test(address) || address.length > 254) return fail('invalid_email', email);
      if (!consent.checked) return fail('consent_required', consent);
      sending = true;
      submit.disabled = true;
      submit.textContent = msgs.sending;
      form.setAttribute('aria-busy', 'true');
      say(msgs.sending, false);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(`${form.dataset.api}/api/lead`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: address,
            consent: true,
            product: 'intelyopti',
            kind: form.dataset.kind,
            lang: form.dataset.lang,
            source: form.dataset.source,
            company: form.elements.company.value, // honeypot: real people leave it empty
          }),
          signal: controller.signal,
          credentials: 'omit',
        });
        let data = null;
        try { data = await res.json(); } catch { /* not JSON: treated as a server error below */ }
        if (!res.ok || !data || data.ok !== true) {
          const key = data && data.error;
          if (key === 'invalid_email') return fail(key, email);
          if (key === 'consent_required') return fail(key, consent);
          return fail(res.status === 429 ? 'rate_limited' : msgs[key] ? key : 'server_error');
        }
        // Only a link on the project's own GitHub is ever put on the button.
        const link = done.querySelector('[data-dl-link]');
        if (link) {
          const url = typeof data.downloadUrl === 'string' && data.downloadUrl.startsWith(form.dataset.downloadPrefix) ? data.downloadUrl : form.dataset.download;
          link.setAttribute('href', url);
        }
        say('', false);
        form.hidden = true;
        done.hidden = false;
        done.focus();
      } catch {
        fail('network');
      } finally {
        clearTimeout(timer);
        sending = false;
        submit.disabled = false;
        submit.textContent = label;
        form.removeAttribute('aria-busy');
      }
    });
  });
})();
