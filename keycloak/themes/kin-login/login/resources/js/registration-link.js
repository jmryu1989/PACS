(() => {
  const useBffRegistration = () => {
    const link = document.querySelector('#kc-registration a');
    if (link) link.setAttribute('href', '/api/auth/register');
  };

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', useBffRegistration, { once: true });
  else
    useBffRegistration();
})();
