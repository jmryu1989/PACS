// CD-01: the four notices of the Product Information panel (config/product-info.json notices) under the real login
// form, which is the page a user sees after the worklist's automatic entry. Same origin through the proxy (/auth and
// /worklist), so no new site is involved; a new tab keeps the login form and its session binding untouched. The parent
// theme's templates are not copied: this only appends a footer.
(() => {
  const NOTICES = [
    ['/worklist/legal/privacy.html', 'Privacy Policy'],
    ['/worklist/legal/operator-notice.html', 'Operator Notice'],
    ['/worklist/legal/open-source-notices.html', 'Open Source Notices'],
    ['/worklist/legal/accessibility.html', 'Accessibility'],
  ];

  const addLinks = () => {
    if (document.getElementById('kin-legal-links')) return;
    const footer = document.createElement('footer');
    footer.id = 'kin-legal-links';
    footer.className = 'kin-legal-links';
    const nav = document.createElement('nav');
    nav.setAttribute('aria-label', 'Notices');
    for (const [href, label] of NOTICES) {
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = label;
      nav.append(link);
    }
    footer.append(nav);
    (document.querySelector('.login-pf-page') || document.body).append(footer);
  };

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', addLinks, { once: true });
  else
    addLinks();
})();
