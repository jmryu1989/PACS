

    $("#quick").addEventListener("input", () => { worklistSearch?.change(); render(); });
    for (const host of [$('#quick'),$('#filterrow')]) host.addEventListener('keydown',e=>{
      if(e.key==='Enter'&&!e.isComposing&&e.keyCode!==229){e.preventDefault();worklistSearch?.apply();}
    });
    $("#m-refresh").addEventListener("click", load);
    $('#page-prev').addEventListener('click', () => { resultPage--; render(); });
    $('#page-next').addEventListener('click', () => { resultPage++; render(); });
    $('#page-current').addEventListener('click', () => render(selectedUid));
    $('#page-size').addEventListener('change', () => {
      const size = Number($('#page-size').value);
      if (![25,50,100].includes(size)) return;
      resultPage = Math.floor(resultPage * resultPageSize / size); resultPageSize = size; render();
    });
    $("#m-home").addEventListener("click", load);
    $("#m-filmbox").addEventListener("click", () => { if (selectedUid) openFilmbox(selectedUid); });

    // 상단 메뉴로 옮긴 뒤에도 끝 쪽의 조건·저장 검색 단추가 창 밖으로 밀리지 않게 한다.
    function placeTopMenu(menu) {
      if (!menu.open) return;
      const summary = menu.querySelector(':scope > summary').getBoundingClientRect();
      const panel = menu.querySelector(':scope > .toolbar-menu-panel').getBoundingClientRect();
      menu.style.setProperty('--top-menu-left', Math.max(8, Math.min(summary.left, innerWidth - panel.width - 8)) + 'px');
      menu.style.setProperty('--top-menu-top', menu.closest('.menubar').getBoundingClientRect().bottom + 'px');
    }
    const topMenuObserver = new ResizeObserver(entries => entries.forEach(entry => placeTopMenu(entry.target.parentElement)));
    for (const menu of document.querySelectorAll('.menubar > .toolbar-menu')) {
      menu.addEventListener('toggle', () => placeTopMenu(menu), true);
      topMenuObserver.observe(menu.querySelector(':scope > .toolbar-menu-panel'));
      // 펼친 메뉴는 바깥을 눌러도 닫히지 않아, 대화상자를 연 단추의 메뉴가 닫힌 뒤에도 남아 아래 단추의 클릭을 가로챘다.
      // 단추의 처리보다 먼저(capture) 메뉴를 닫는다. 메뉴 안에 있던 focus는 요약 단추로 옮겨, 대화상자가 그 자리로 돌려준다.
      menu.addEventListener('click', e => {
        if (!menu.open || !e.target.closest('[aria-haspopup="dialog"]')) return;
        if (menu.contains(document.activeElement)) menu.querySelector(':scope > summary').focus({ preventScroll: true });
        menu.open = false;
      }, true);
    }
    window.addEventListener('resize', () => {
      for (const menu of document.querySelectorAll('.menubar > .toolbar-menu[open]')) placeTopMenu(menu);
    });
