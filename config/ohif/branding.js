
/** Product branding only; loaded-image identity owns clinical window titles. */
function KinViewerBrand({ React }) {
  React.useEffect(() => {
    let sessionChannel;

    const resetTitle = () => {
      document.title = KIN_VIEWER_DEFAULT_TITLE;
    };

    sessionChannel = kinViewerOnEnd(resetTitle);

    // S5-UI4: 톱니 메뉴의 About(업스트림 버전·링크 창)은 판독 화면에서 뺀다. 라이선스 표기는 로그인 페이지 하단에 둔다.
    // OHIF 3.9 머리글은 메뉴 항목을 설정으로 끄는 길이 없어 DOM에서 처리한다. React가 소유한 행을 떼어 내면
    // 이후 재조정(언어 변경 등)의 removeChild가 예외를 던져 뷰어가 멈출 수 있으므로, 노드는 제자리에 두고
    // 표시·클릭·키보드 포커스·보조기술에서 모두 뺀다.
    // 메뉴 경계는 이 로고(#kin-viewer-brand)를 품은 머리글이다. 아래 CSS가 865f064부터 같은 선택자로 머리글과 그 안의
    // 오른쪽 드롭다운(.absolute.right-0)을 칠하므로 그 기준을 따른다. 머리글 밖(판독문·검사 설명·영상 주석)의 About은
    // 주변에 Preferences가 있어도 순회하지 않는다. 머리글을 못 찾으면 아무것도 숨기지 않는다(About이 남는 쪽으로 실패).
    // 설정 항목은 아래에서 Viewer Settings로 이름이 바뀌므로 두 이름 모두 설정 항목으로 읽는다.
    const ABOUT_TITLES = new Set(['About', 'About OHIF Viewer']);
    const SETTINGS_TITLES = new Set(['Preferences', 'Viewer Settings']);
    const menuScope = () => document.getElementById('kin-viewer-brand')?.closest('.bg-secondary-dark.z-20') || null;
    // 행의 이름은 아이콘 svg(<title> 포함)를 뺀 글자 전체다. 후손 어딘가의 한 글자 조각이 아니라 행 전체가 이름과 같아야 한다.
    const labelOf = node => node.nodeType === Node.ELEMENT_NODE
      ? (node.localName === 'svg' ? '' : [...node.childNodes].map(labelOf).join(''))
      : node.nodeType === 3 ? node.data : '';
    // D1821 replaces the browser-local shortcut editor with account settings.
    // Route the existing settings entry to its current owner without moving React nodes.
    const accountSettings = event => {
      const scope = menuScope(), menu = event.target.closest?.('.absolute.right-0');
      if (!scope || !menu || !scope.contains(menu)) return;
      let row = event.target;
      while (row && row !== menu) {
        if (SETTINGS_TITLES.has(labelOf(row).trim()) && window.kinViewerUXOpenSettings?.()) {
          event.preventDefault(); event.stopImmediatePropagation(); return;
        }
        row = row.parentElement;
      }
    };
    document.addEventListener('click', accountSettings, true);
    // 드롭다운은 한 목록에서 같은 태그의 행을 나란히 만든다. 클래스는 마지막 행만 다를 수 있어 비교하지 않는다.
    const hideAboutRows = scope => {
      scope.querySelectorAll('*').forEach(row => {
        if (row.dataset.kinRemoved === 'about' || !ABOUT_TITLES.has(labelOf(row).trim())) return;
        const peers = [...row.parentElement.children].filter(peer => peer !== row && peer.localName === row.localName);
        if (!peers.some(peer => SETTINGS_TITLES.has(labelOf(peer).trim()))) return;
        row.style.setProperty('display', 'none', 'important');
        row.setAttribute('inert', '');
        row.setAttribute('aria-hidden', 'true');
        row.dataset.kinRemoved = 'about';
      });
    };

    // S5-UI5 (VUI-08). 업스트림 제품명 치환과 설정 항목 이름 바꾸기는 제품 chrome, 곧 로고 머리글 안의 톱니 드롭다운
    // (.absolute.right-0 — 865f064부터 아래 CSS가 칠하는 같은 경계)에서만 한다. 영상·패널·알림·모달·판독/검사 문자열은 환자명·
    // 시리즈 설명·표식에 "OHIF"·"Foundation" 같은 글자가 있어도 원문 그대로 두고, 머리글 안이라도 드롭다운 밖(환자 정보 등)은
    // 건드리지 않는다. 로딩·CPU fallback·cross-origin 경고와 라이선스 원문도 드롭다운 밖이라 바꾸지 않는다. 드롭다운을 못 찾으면
    // 아무것도 바꾸지 않는다(원문이 남는 쪽으로 실패). 바꾼 글자는 다시 규칙에 걸리지 않으므로 메뉴를 다시 만들어도 한 번만 바뀐다.
    // 머리글 안의 About 제목은 위 판별이 맡으므로 이름을 바꾸지 않는다(바꾸면 설정 항목이 늦게 붙을 때 더는 About으로 읽히지 않는다).
    const replaceBrandText = scope => {
      scope.querySelectorAll('*').forEach(element => {
        if (element.childElementCount) return;
        const menu = element.closest('.absolute.right-0');
        if (!menu || menu === scope || !scope.contains(menu)) return;
        const text = element.textContent?.trim();
        if (!text || ABOUT_TITLES.has(text)) return;
        // VUI-05: 톱니 메뉴의 Preferences는 표시 이름만 Viewer Settings로 바꾼다. 항목·모달·포커스 복귀는 뷰어의 것이다.
        if (text === 'Preferences') { element.textContent = 'Viewer Settings'; return; }
        if (/OHIF|Open Health Imaging Foundation/i.test(text)) {
          element.textContent = text
            .replace(/Open Health Imaging Foundation/gi, '업스트림 오픈소스 프로젝트')
            .replace(/OHIF Viewer/gi, KIN_VIEWER_PRODUCT)
            .replace(/OHIF/gi, '업스트림');
        }
      });
    };
    // 행 이름은 형제 행과 라벨이 모두 붙어야 판별되므로, 머리글 안의 변경(행·라벨 추가, 글자 변경)이 있으면 추가된 노드만이
    // 아니라 머리글 전체를 다시 본다. 머리글이 새로 붙은 경우도 포함한다. 도구막대 버튼의 켜짐은 class로만 바뀌므로 class
    // 변경도 본다. 여기서 쓰는 속성(aria-*·title·data-kin-*)은 관찰 대상이 아니고 글자는 한 번만 바뀌므로 스스로 되풀이하지 않는다.
    const touchesScope = (scope, record) => {
      const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      return !!target && scope.contains(target) || [...record.addedNodes].some(node => node.contains?.(scope));
    };
    const refresh = scope => {
      hideAboutRows(scope);
      replaceBrandText(scope);
      kinViewerToolbarLabels.apply(scope);
    };
    const initialScope = menuScope();
    if (initialScope) refresh(initialScope);
    const observer = new MutationObserver(records => {
      const scope = menuScope();
      if (scope && records.some(record => touchesScope(scope, record))) refresh(scope);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });

    document.title = KIN_VIEWER_DEFAULT_TITLE;

    return () => {
      document.title = KIN_VIEWER_DEFAULT_TITLE;
      observer.disconnect();
      document.removeEventListener('click', accountSettings, true);
      if (sessionChannel) {
        sessionChannel.close();
      }
    };
  }, []);

  const style = `
    :root {
      --kin-panel: #0E1728;
      --kin-accent: #4F8EF7;
      --kin-accent-soft: rgba(79, 142, 247, .20);
      --kin-accent-faint: rgba(79, 142, 247, .10);
      --kin-link: #9CC3FF;
    }
    #root > div > .bg-secondary-dark.z-20:has(#kin-viewer-brand) {
      background-color: var(--kin-panel) !important;
      border-bottom: 1px solid rgba(130, 160, 210, .22) !important;
    }
    #root > div > .bg-secondary-dark.z-20:has(#kin-viewer-brand) button.bg-primary-light {
      color: #071528 !important;
      background-color: var(--kin-accent) !important;
    }
    /* S5-UI5 (VUI-04): 켜진 도구는 색에 더해 안쪽 테두리와 아래 막대로 구분하고, 키보드 초점은 바깥 윤곽선으로 따로 둔다. */
    #root > div > .bg-secondary-dark.z-20:has(#kin-viewer-brand) button.bg-primary-light,
    #root > div > .bg-secondary-dark.z-20:has(#kin-viewer-brand) button[aria-pressed="true"] {
      box-shadow: inset 0 0 0 2px #E8F1FF, inset 0 -4px 0 0 #071528 !important;
    }
    #root > div > .bg-secondary-dark.z-20:has(#kin-viewer-brand) button:focus-visible {
      outline: 2px solid #facc15 !important;
      outline-offset: 2px;
    }
    #root > div > .bg-secondary-dark.z-20:has(#kin-viewer-brand) .absolute.right-0 .text-primary-active {
      color: var(--kin-link) !important;
    }
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) [data-cy="seriesList-btn"],
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) .text-primary-active,
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) .text-primary,
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) .text-actions-primary {
      color: var(--kin-accent) !important;
    }
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) [role="group"] {
      background-color: var(--kin-accent-faint) !important;
    }
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) button[role="radio"][aria-checked="true"] {
      color: var(--kin-link) !important;
      background-color: var(--kin-accent-soft) !important;
    }
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) [data-cy="study-browser-thumbnail"] .bg-highlight {
      background-color: var(--kin-accent) !important;
    }
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) [data-cy="study-browser-thumbnail"]:hover {
      background-color: var(--kin-accent-soft) !important;
    }
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) [data-cy="study-browser-thumbnail"]:focus-visible {
      outline: 2px solid var(--kin-accent) !important;
      outline-offset: -2px;
    }
  `;

  return React.createElement(
    'div',
    {
      id: 'kin-viewer-brand',
      style: { display: 'flex', alignItems: 'center', gap: '9px', height: '28px' },
    },
    React.createElement('style', null, style),
    React.createElement('img', {
      src: '/kin-brand/kin-emblem-j1.svg',
      alt: '',
      width: 24,
      height: 24,
      style: { display: 'block', flex: '0 0 auto' },
    }),
    React.createElement(
      'span',
      {
        style: {
          color: '#AFC3E2',
          fontSize: '9.5px',
          fontWeight: 600,
          lineHeight: 1.3,
          letterSpacing: '.14em',
          whiteSpace: 'nowrap',
        },
      },
      'KOREA IMAGING',
      React.createElement('br'),
      'NETWORK'
    )
  );
}

document.title = KIN_VIEWER_DEFAULT_TITLE;
