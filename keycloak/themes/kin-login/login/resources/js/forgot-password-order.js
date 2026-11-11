// login.css draws the forgot-password link under the Login button (flex order), but Keycloak's login.ftl gives the
// link tabindex 6 and the button 7, so Tab reached the link before the button and went from the button straight to
// the registration link. One more than the button puts Tab in the order the screen shows.
(() => {
  const followLoginButton = () => {
    const link = document.querySelector('#kc-form-login .login-pf-settings a');
    const button = document.querySelector('#kc-form-login #kc-login');
    if (link && button && button.tabIndex > 0) link.tabIndex = button.tabIndex + 1;
  };

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', followLoginButton, { once: true });
  else
    followLoginButton();
})();
