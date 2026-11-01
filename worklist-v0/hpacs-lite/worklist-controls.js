

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
    }
    window.addEventListener('resize', () => {
      for (const menu of document.querySelectorAll('.menubar > .toolbar-menu[open]')) placeTopMenu(menu);
    });
