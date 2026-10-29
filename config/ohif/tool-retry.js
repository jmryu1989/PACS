// A module connection failure is retryable within the current mode, without discarding the study.
function kinToolRetry(id, message, retry) {
  document.getElementById(id)?.remove();
  if (!retry) return;
  const row = document.createElement('div'); row.id = id;
  const text = document.createElement('span'); text.textContent = message;
  const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Retry';
  button.onclick = () => { row.remove(); retry(); };
  row.append(text, button);
  (document.querySelector('#kin-viewer-layout-status')?.parentElement || document.body).append(row);
}
