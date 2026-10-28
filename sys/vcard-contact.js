/* Obfuscation against simple address harvesters; decode only on a user click. */
(() => {
  'use strict';
  const source = document.getElementById('vcard-contact-data');
  if (!source) return;
  const encoded = JSON.parse(source.textContent);
  const bound = new WeakSet();
  const copy = async event => {
    event.preventDefault();
    event.stopPropagation();
    const owner = event.currentTarget?.closest('dialog') || document.body;
    const email = new TextDecoder().decode(Uint8Array.from(encoded.slice(1), byte => byte ^ encoded[0]));
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(email);
        copied = true;
      }
    } catch (_) { }
    if (!copied) {
      const field = document.createElement('textarea');
      field.value = email;
      field.setAttribute('readonly', '');
      field.style.cssText = 'position:fixed;left:-9999px;top:0';
      // A modal dialog makes the rest of the document inert.
      owner.append(field);
      field.select();
      try { copied = document.execCommand('copy'); } catch (_) { }
      field.remove();
    }
    alert(copied ? 'Email address copyied to buf!' : 'Email address could not be copied.');
  };
  const bind = link => {
    if (bound.has(link)) return link;
    bound.add(link);
    link.href = '#';
    link.textContent = 'Email';
    link.dataset.vcardEmail = '';
    link.addEventListener('click', copy);
    return link;
  };
  const createLink = () => {
    const link = bind(document.createElement('a'));
    link.style.cssText = 'color:inherit;text-decoration:underline;cursor:pointer';
    return link;
  };
  window.VCardContact = Object.freeze({createLink});
  const install = () => {
    document.querySelectorAll('#email-link, [data-vcard-email]').forEach(bind);
    const footer = document.querySelector('[ids="about"].footer');
    if (footer && !footer.querySelector('.vcard-contact-footer')) {
      const row = document.createElement('div');
      row.className = 'vcard-contact-footer';
      row.style.textAlign = 'center';
      row.append(createLink());
      footer.insertBefore(row, footer.querySelector('.footer__copyright'));
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, {once:true});
  else install();
})();
